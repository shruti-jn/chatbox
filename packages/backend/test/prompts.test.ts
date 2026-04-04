import { describe, it, expect } from 'vitest'
import { loadPrompt, assembleSystemPrompt, type SystemPromptConfig } from '../src/prompts/registry.js'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(__dirname, '..', 'src')

/** Recursively collect all .ts files from a directory */
function collectTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Skip templates directory (those are supposed to have prompts)
      if (entry.name === 'templates') continue
      results.push(...collectTsFiles(fullPath))
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      results.push(fullPath)
    }
  }
  return results
}

describe('Prompt Registry — Version Loading', () => {
  it('loadPrompt returns non-empty string for system_base v1', () => {
    const text = loadPrompt('system_base', 'v1')
    expect(text.length).toBeGreaterThan(0)
    expect(typeof text).toBe('string')
  })

  it('loadPrompt returns a different string for system_base v2', () => {
    const v1 = loadPrompt('system_base', 'v1')
    const v2 = loadPrompt('system_base', 'v2')
    expect(v2.length).toBeGreaterThan(0)
    expect(v1).not.toBe(v2)
  })

  it('loadPrompt throws for nonexistent template', () => {
    expect(() => loadPrompt('nonexistent_prompt', 'v99')).toThrow()
  })
})

describe('Prompt Registry — Dynamic Assembly', () => {
  it('assembleSystemPrompt includes all 5 parameter values in output', () => {
    const config: SystemPromptConfig = {
      classroomConfig: {
        mode: 'socratic',
        subject: 'math',
      },
      gradeBand: 'k2',
      toolSchemas: [{ name: 'chess' }],
      whisperGuidance: 'focus on fractions',
      safetyInstructions: 'no violence',
    }

    const output = assembleSystemPrompt(config)

    // 1. mode value appears verbatim (lowercase)
    expect(output).toContain('socratic')
    // 2. grade band: k2 -> includes K-2 or ages 5
    expect(output.includes('K-2') || output.includes('ages 5')).toBe(true)
    // 3. tool name
    expect(output).toContain('chess')
    // 4. whisper guidance content
    expect(output).toContain('fractions')
    // 5. safety instructions content
    expect(output).toContain('violence')
  })

  it('assembleSystemPrompt starts with the base system prompt', () => {
    const config: SystemPromptConfig = {
      classroomConfig: {},
      gradeBand: 'k2',
      toolSchemas: [],
      whisperGuidance: null,
      safetyInstructions: null,
    }
    const output = assembleSystemPrompt(config)
    const basePrompt = loadPrompt('system_base', 'v1')
    expect(output.startsWith(basePrompt)).toBe(true)
  })
})

describe('Prompt Registry — No Hardcoded Prompts', () => {
  it('no .ts source files contain long hardcoded prompt-like template literals', () => {
    // Scan all .ts files in src/ (excluding .d.ts, test files, and templates/)
    // for string literals > 150 chars that contain prompt-like keywords.
    // Match template literals (backtick strings) >150 chars containing prompt-like keywords
    const promptKeywords = /you are a|must not|do not give|system prompt|instruction/i
    const tsFiles = collectTsFiles(SRC_DIR)
    const violations: string[] = []

    for (const filePath of tsFiles) {
      // Skip the prompt registry itself — it's the prompt infrastructure
      if (filePath.includes('/prompts/')) continue
      // Skip server.ts — infrastructure file with template literals that aren't prompts
      if (filePath.endsWith('/server.ts')) continue
      const content = readFileSync(filePath, 'utf-8')
      // Find template literals (backtick) that span > 150 chars and look like prompt text
      const templateLiteralRegex = /`([^`]{150,})`/g
      let match: RegExpExecArray | null
      while ((match = templateLiteralRegex.exec(content)) !== null) {
        const literal = match[1]
        if (promptKeywords.test(literal)) {
          // Find line number
          const lineNum = content.slice(0, match.index).split('\n').length
          violations.push(`${filePath}:${lineNum}`)
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} file(s) with hardcoded prompt text:\n${violations.join('\n')}`,
    ).toHaveLength(0)
  })
})

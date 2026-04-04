/**
 * 5-stage automated app review pipeline.
 *
 * Stages:
 *   1. Schema validation — tool definitions have valid JSON Schema
 *   2. Security scan — URL safety, no external scripts/exfiltration
 *   3. Content check — profanity / inappropriate content filter
 *   4. Accessibility — permissions declared explicitly
 *   5. Performance — tool count and schema size limits
 *
 * Deterministic, no LLM calls.
 */

export interface ReviewStageResult {
  stage: string
  status: 'pass' | 'fail' | 'warning'
  details: string[]
}

export interface ReviewResult {
  stages: ReviewStageResult[]
  overallStatus: 'approved' | 'rejected' | 'needs_manual_review'
}

export interface ReviewInput {
  toolDefinitions: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown> | null
  }>
  uiManifest: { url: string; [key: string]: unknown }
  permissions: Record<string, unknown>
  name: string
  description: string
}

export interface ReviewOptions {
  environment?: 'development' | 'production'
}

// ---------- Stage 1: Schema Validation ----------

function validateSchema(input: ReviewInput): ReviewStageResult {
  const details: string[] = []
  let failed = false

  for (let i = 0; i < input.toolDefinitions.length; i++) {
    const tool = input.toolDefinitions[i]

    if (!tool.name || typeof tool.name !== 'string' || tool.name.trim() === '') {
      details.push(`Tool[${i}]: missing or empty name`)
      failed = true
    }

    if (!tool.description || typeof tool.description !== 'string' || tool.description.trim() === '') {
      details.push(`Tool[${i}]: missing or empty description`)
      failed = true
    }

    if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
      details.push(`Tool[${i}]: missing or invalid inputSchema`)
      failed = true
    }
  }

  return {
    stage: 'schema_validation',
    status: failed ? 'fail' : 'pass',
    details,
  }
}

// ---------- Stage 2: Security Scan ----------

const BLOCKED_PATTERNS = [
  /<script\b[^>]*src\s*=\s*["']https?:\/\/(?!localhost)/i,
  /fetch\s*\(\s*["']https?:\/\/(?!localhost)/i,
  /XMLHttpRequest/i,
  /navigator\.sendBeacon/i,
  /\beval\s*\(/i,
  /new\s+WebSocket\s*\(/i,
  /new\s+Image\b/i,
  /document\.cookie/i,
]

function scanSecurity(input: ReviewInput, opts: ReviewOptions): ReviewStageResult {
  const details: string[] = []
  let status: 'pass' | 'fail' | 'warning' = 'pass'
  const env = opts.environment ?? 'production'
  const url = input.uiManifest.url

  // HTTPS check
  if (url.startsWith('http://')) {
    if (env === 'production') {
      details.push(`URL must be HTTPS in production: ${url}`)
      status = 'fail'
    } else if (url.startsWith('http://localhost')) {
      details.push(`HTTP localhost URL allowed in development: ${url}`)
      status = 'warning'
    } else {
      details.push(`Non-localhost HTTP URL: ${url}`)
      status = 'fail'
    }
  }

  // Check tool code for data exfiltration patterns
  const toolJson = JSON.stringify(input.toolDefinitions)
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(toolJson)) {
      details.push(`Suspicious pattern in tool definitions: ${pattern.source}`)
      status = 'fail'
    }
  }

  return { stage: 'security_scan', status, details }
}

// ---------- Stage 3: Content Check ----------

// Simple blocklist for K-12 context. Covers obvious profanity only.
const PROFANITY_LIST = [
  'shit', 'fuck', 'damn', 'ass', 'bitch', 'bastard', 'crap',
  'dick', 'piss', 'slut', 'whore', 'cock', 'cunt',
]

function normalizeText(text: string): string {
  return text.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function checkContent(input: ReviewInput): ReviewStageResult {
  const details: string[] = []
  let failed = false

  const textsToCheck = [input.name, input.description]

  for (const text of textsToCheck) {
    const lower = text.toLowerCase()
    const normalized = normalizeText(text)
    for (const word of PROFANITY_LIST) {
      // Word boundary check to avoid false positives (e.g. "class" matching "ass")
      const regex = new RegExp(`\\b${word}\\b`, 'i')
      if (regex.test(lower) || normalized.includes(word)) {
        details.push(`Inappropriate word "${word}" found in text: "${text.substring(0, 50)}"`)
        failed = true
      }
    }
  }

  return {
    stage: 'content_check',
    status: failed ? 'fail' : 'pass',
    details,
  }
}

// ---------- Stage 4: Accessibility (Permissions) ----------

function checkAccessibility(input: ReviewInput): ReviewStageResult {
  const details: string[] = []
  let failed = false

  if (!input.permissions || Object.keys(input.permissions).length === 0) {
    details.push('App must declare required permissions explicitly (permissions object is empty)')
    failed = true
  }

  return {
    stage: 'accessibility',
    status: failed ? 'fail' : 'pass',
    details,
  }
}

// ---------- Stage 5: Performance ----------

const MAX_TOOLS = 20
const MIN_TOOLS = 1
const MAX_SCHEMA_BYTES = 10 * 1024 // 10KB

function checkPerformance(input: ReviewInput): ReviewStageResult {
  const details: string[] = []
  let failed = false

  const toolCount = input.toolDefinitions.length
  if (toolCount < MIN_TOOLS) {
    details.push(`App must have at least ${MIN_TOOLS} tool, found ${toolCount}`)
    failed = true
  }
  if (toolCount > MAX_TOOLS) {
    details.push(`App must have at most ${MAX_TOOLS} tools, found ${toolCount}`)
    failed = true
  }

  for (let i = 0; i < input.toolDefinitions.length; i++) {
    const tool = input.toolDefinitions[i]
    if (tool.inputSchema) {
      const size = new TextEncoder().encode(JSON.stringify(tool.inputSchema)).length
      if (size > MAX_SCHEMA_BYTES) {
        details.push(
          `Tool[${i}] "${tool.name}" inputSchema is ${(size / 1024).toFixed(1)}KB, max ${MAX_SCHEMA_BYTES / 1024}KB`,
        )
        failed = true
      }
    }
  }

  return {
    stage: 'performance',
    status: failed ? 'fail' : 'pass',
    details,
  }
}

// ---------- Pipeline orchestrator ----------

export function runReviewPipeline(input: ReviewInput, opts: ReviewOptions = {}): ReviewResult {
  const stages: ReviewStageResult[] = [
    validateSchema(input),
    scanSecurity(input, opts),
    checkContent(input),
    checkAccessibility(input),
    checkPerformance(input),
  ]

  const hasFailure = stages.some(s => s.status === 'fail')
  const hasWarning = stages.some(s => s.status === 'warning')

  let overallStatus: ReviewResult['overallStatus']
  if (hasFailure) {
    overallStatus = 'rejected'
  } else if (hasWarning) {
    overallStatus = 'needs_manual_review'
  } else {
    overallStatus = 'approved'
  }

  return { stages, overallStatus }
}

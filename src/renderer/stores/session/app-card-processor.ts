/**
 * Post-processes assistant message content parts to detect app link patterns
 * in text and convert them into app-card content parts for inline rendering.
 *
 * This runs after streaming completes, when the full text is available.
 */

import { v4 as uuidv4 } from 'uuid'
import type { MessageContentParts, MessageAppCardPart, MessageTextPart } from '@shared/types'
import { settingsStore } from '../settingsStore'

interface AppPattern {
  /** Matches the display text (e.g. "Open Chess Board") */
  textPattern: RegExp
  /** Matches the URL to confirm it's an app URL */
  urlPattern: RegExp
  appName: string
  height: number
  displayMode?: 'inline' | 'panel'
}

const APP_PATTERNS: AppPattern[] = [
  {
    textPattern: /Open\s+Chess/i,
    urlPattern: /apps\/chess\/ui/i,
    appName: 'Chess',
    height: 500,
  },
  {
    textPattern: /Open\s+Weather/i,
    urlPattern: /apps\/weather\/ui/i,
    appName: 'Weather',
    height: 400,
  },
  {
    textPattern: /Open\s+Spotify/i,
    urlPattern: /apps\/spotify\/ui/i,
    appName: 'Spotify',
    height: 400,
  },
]

/**
 * Regex that matches a markdown-style app link with emoji prefix.
 * Captures: [1] full link text, [2] display text, [3] URL
 *
 * Examples:
 *   🎮 [Open Chess Board](http://localhost:3001/api/v1/apps/chess/ui/)
 *   🌤 [Open Weather Dashboard](http://localhost:3001/api/v1/apps/weather/ui/)
 *   Plain link variant: 🎮 Open Chess Board http://localhost:3001/api/v1/apps/chess/ui/
 */
// Pattern 1: Emoji + [text](url) — e.g., 🎮 [Open Chess Board](http://...)
const MARKDOWN_LINK_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu
// Pattern 2: Emoji + text + url — e.g., 🎮 Open Chess Board http://...
const PLAIN_LINK_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*(Open\s+\S+(?:\s+\S+){0,3})\s+(https?:\/\/\S+)/gu
// Pattern 3: Bare [text](url) without emoji — e.g., [Open Chess Board](http://...)
const BARE_MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu

function findAppMatch(displayText: string, url: string): AppPattern | undefined {
  return APP_PATTERNS.find((p) => p.textPattern.test(displayText) && p.urlPattern.test(url))
}

interface LinkMatch {
  fullMatch: string
  startIndex: number
  endIndex: number
  displayText: string
  url: string
  appPattern: AppPattern
}

function findAllAppLinks(text: string): LinkMatch[] {
  const matches: LinkMatch[] = []

  // Try markdown-style links first: [text](url)
  for (const m of text.matchAll(MARKDOWN_LINK_RE)) {
    const displayText = m[1]
    const url = m[2]
    const appPattern = findAppMatch(displayText, url)
    if (appPattern && m.index !== undefined) {
      matches.push({
        fullMatch: m[0],
        startIndex: m.index,
        endIndex: m.index + m[0].length,
        displayText,
        url,
        appPattern,
      })
    }
  }

  // Try bare markdown links without emoji: [text](url)
  for (const m of text.matchAll(BARE_MARKDOWN_LINK_RE)) {
    const displayText = m[1]
    const url = m[2]
    const appPattern = findAppMatch(displayText, url)
    if (appPattern && m.index !== undefined) {
      const overlaps = matches.some(
        (existing) => m.index! >= existing.startIndex && m.index! < existing.endIndex
      )
      if (!overlaps) {
        matches.push({
          fullMatch: m[0],
          startIndex: m.index,
          endIndex: m.index + m[0].length,
          displayText,
          url,
          appPattern,
        })
      }
    }
  }

  // Try plain-text links: emoji + text + url
  for (const m of text.matchAll(PLAIN_LINK_RE)) {
    const displayText = m[1]
    const url = m[2]
    const appPattern = findAppMatch(displayText, url)
    if (appPattern && m.index !== undefined) {
      // Avoid duplicates if markdown regex already matched this region
      const overlaps = matches.some(
        (existing) => m.index! >= existing.startIndex && m.index! < existing.endIndex
      )
      if (!overlaps) {
        matches.push({
          fullMatch: m[0],
          startIndex: m.index,
          endIndex: m.index + m[0].length,
          displayText,
          url,
          appPattern,
        })
      }
    }
  }

  // Sort by position in text
  matches.sort((a, b) => a.startIndex - b.startIndex)
  return matches
}

function createAppCardPart(match: LinkMatch): MessageAppCardPart {
  return {
    type: 'app-card',
    appId: uuidv4(),
    appName: match.appPattern.appName,
    instanceId: uuidv4(),
    status: 'active',
    url: match.url,
    height: match.appPattern.height,
    ...(match.appPattern.displayMode ? { displayMode: match.appPattern.displayMode } : {}),
  }
}

export function getChatBridgeApiHost() {
  const configured = settingsStore.getState().getSettings().providers?.chatbridge?.apiHost
  if (configured) return configured.replace(/\/$/, '')
  return 'http://localhost:3001'
}

export function resolveChatBridgeUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return new URL(url, `${getChatBridgeApiHost()}/`).toString()
}

/**
 * Scans text content parts for app link patterns and replaces them with
 * app-card content parts. Non-text parts are passed through unchanged.
 *
 * Returns a new array (does not mutate the input).
 */
export function processAppCards(contentParts: MessageContentParts): MessageContentParts {
  const result: MessageContentParts = []

  for (const part of contentParts) {
    if (part.type !== 'text') {
      result.push(part)
      continue
    }

    const text = (part as MessageTextPart).text
    const matches = findAllAppLinks(text)

    if (matches.length === 0) {
      result.push(part)
      continue
    }

    // Split the text around each match, inserting app-card parts
    let cursor = 0
    for (const match of matches) {
      // Text before the match
      const before = text.slice(cursor, match.startIndex).trim()
      if (before.length > 0) {
        result.push({ type: 'text', text: before } as MessageTextPart)
      }

      // The app-card part
      result.push(createAppCardPart(match))

      cursor = match.endIndex
    }

    // Text after the last match
    const after = text.slice(cursor).trim()
    if (after.length > 0) {
      result.push({ type: 'text', text: after } as MessageTextPart)
    }
  }

  // Pass 2: Convert tool-call results with __cbApp metadata to inline app-card parts.
  // This handles the Vercel AI SDK tool-use pipeline where the AI calls a tool
  // and the backend returns __cbApp with the iframe URL from the database.
  for (let i = 0; i < result.length; i++) {
    const part = result[i] as any
    if (part.type === 'tool-call' && part.state === 'result' && part.result?.__cbApp) {
      const meta = part.result.__cbApp as {
        appId: string
        appName: string
        instanceId: string
        url: string
        height?: number
        displayMode?: 'inline' | 'panel'
      }

      // Resolve relative URLs against the backend host
      let resolvedUrl = meta.url
      if (!resolvedUrl.startsWith('http://') && !resolvedUrl.startsWith('https://')) {
        resolvedUrl = resolveChatBridgeUrl(resolvedUrl)
      }

      const appCard: MessageAppCardPart = {
        type: 'app-card',
        appId: meta.appId,
        appName: meta.appName,
        instanceId: meta.instanceId ?? uuidv4(),
        status: 'loading',
        url: resolvedUrl,
        height: meta.height ?? 400,
        ...(meta.displayMode === 'panel' ? { displayMode: 'panel' as const } : {}),
      }

      // Insert the app-card immediately after the tool-call part
      result.splice(i + 1, 0, appCard as any)
      i++ // skip the inserted part
    }
  }

  return result
}

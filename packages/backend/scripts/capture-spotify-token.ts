/**
 * One-time Spotify token capture script.
 *
 * Usage:
 *   cd packages/backend
 *   set -a && source ../../.env && set +a
 *   npx tsx scripts/capture-spotify-token.ts
 *
 * Opens a Spotify authorize URL, waits for the OAuth callback on
 * localhost:8765, exchanges the code for tokens, and prints the
 * values to paste into .env as:
 *   SPOTIFY_TEST_ACCESS_TOKEN=...
 *   SPOTIFY_TEST_REFRESH_TOKEN=...
 */

import http from 'http'
import crypto from 'crypto'
import { URL } from 'url'

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET
const PORT = 8765
const REDIRECT_URI = `http://localhost:${PORT}/callback`

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env')
  process.exit(1)
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

const state = crypto.randomBytes(16).toString('hex')
const codeVerifier = generateCodeVerifier()
const codeChallenge = generateCodeChallenge(codeVerifier)

const authUrl = `https://accounts.spotify.com/authorize?${new URLSearchParams({
  response_type: 'code',
  client_id: CLIENT_ID,
  scope: 'playlist-modify-public playlist-modify-private user-read-private',
  redirect_uri: REDIRECT_URI,
  state,
  code_challenge: codeChallenge,
  code_challenge_method: 'S256',
})}`

console.log('\n─────────────────────────────────────────────────────')
console.log('  Spotify Token Capture')
console.log('─────────────────────────────────────────────────────')
console.log('\n1. Open this URL in your browser:\n')
console.log(`   ${authUrl}`)
console.log('\n2. Log in to Spotify (enter the code from your email).')
console.log('3. Click "Agree" on the permissions screen.')
console.log('\nWaiting for callback on port', PORT, '...\n')

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/callback')) {
    res.writeHead(404)
    res.end()
    return
  }

  const url = new URL(req.url, `http://localhost:${PORT}`)
  const code = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html><body><p>Authorization was cancelled. You can close this tab.</p></body></html>')
    console.error('❌  Spotify authorization was cancelled:', error)
    server.close()
    process.exit(1)
  }

  if (!code || returnedState !== state) {
    res.writeHead(400, { 'Content-Type': 'text/html' })
    res.end('<html><body><p>Invalid callback — state mismatch.</p></body></html>')
    console.error('❌  State mismatch — possible CSRF')
    server.close()
    process.exit(1)
  }

  // Exchange code for tokens
  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      }),
    })

    const tokens = await tokenRes.json() as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      error?: string
    }

    if (!tokens.access_token || !tokens.refresh_token) {
      res.writeHead(500, { 'Content-Type': 'text/html' })
      res.end(`<html><body><p>Token exchange failed: ${tokens.error ?? 'unknown'}</p></body></html>`)
      console.error('❌  Token exchange failed:', tokens)
      server.close()
      process.exit(1)
    }

    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html><body style="font-family:sans-serif;padding:24px"><h2>✅ Spotify connected!</h2><p>You can close this tab and return to the terminal.</p></body></html>')

    console.log('✅  Tokens captured! Add these to your .env:\n')
    console.log(`SPOTIFY_TEST_ACCESS_TOKEN=${tokens.access_token}`)
    console.log(`SPOTIFY_TEST_REFRESH_TOKEN=${tokens.refresh_token}`)
    console.log(`SPOTIFY_TEST_EXPIRES_IN=${tokens.expires_in ?? 3600}`)
    console.log('\nDone. You can now run the E2E tests.')

    server.close()
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' })
    res.end('<html><body><p>Unexpected error — check the terminal.</p></body></html>')
    console.error('❌  Unexpected error:', err)
    server.close()
    process.exit(1)
  }
})

server.listen(PORT, () => {})

/**
 * Spotify service — searches tracks and creates playlists via Spotify Web API.
 *
 * - Uses stored OAuth access tokens from the database (per-user)
 * - Falls back to client credentials flow if no user token
 * - Returns mock data with { mock: true } flag when no credentials or API fails
 * - External paid API — mock in tests is acceptable (L-079)
 */

import { prisma, withTenantContext } from '../middleware/rls.js'

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1'
const API_TIMEOUT_MS = 5000

export interface SpotifyTrack {
  name: string
  artist: string
  id: string
  albumName?: string
  previewUrl?: string | null
}

export interface SearchTracksResult {
  tracks: SpotifyTrack[]
  mock?: boolean
}

export interface CreatePlaylistResult {
  playlistId?: string
  playlistUrl?: string
  name?: string
  mock?: boolean
  error?: string
}

/**
 * Attempt to get a Spotify access token for the given user.
 * Returns null if no token is stored or decryption fails.
 */
async function getUserSpotifyToken(userId: string, districtId: string): Promise<string | null> {
  try {
    // Dynamic import to avoid circular dependency
    const { decryptAES256GCM } = await import('../routes/auth.js')

    const oauthToken = await withTenantContext(districtId, async (tx) => {
      return tx.oAuthToken.findUnique({
        where: { userId_provider: { userId, provider: 'spotify' } },
      })
    })

    if (!oauthToken) return null
    return decryptAES256GCM(oauthToken.accessTokenEncrypted)
  } catch {
    return null
  }
}

/**
 * Attempt to get a client credentials access token (app-level, no user context).
 * Requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET env vars.
 */
async function getClientCredentialsToken(): Promise<string | null> {
  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!res.ok) return null
    const data = await res.json() as { access_token?: string }
    return data.access_token ?? null
  } catch {
    return null
  }
}

/**
 * Get a usable Spotify access token: user token first, then client credentials.
 */
async function resolveToken(userId?: string, districtId?: string): Promise<string | null> {
  if (userId && districtId) {
    const userToken = await getUserSpotifyToken(userId, districtId)
    if (userToken) return userToken
  }
  return getClientCredentialsToken()
}

const MOCK_TRACKS: SpotifyTrack[] = [
  { name: 'Lo-fi Study Beats', artist: 'ChillHop', id: 'mock_track1' },
  { name: 'Ambient Focus', artist: 'Study Music', id: 'mock_track2' },
]

/**
 * Search Spotify for tracks matching a query.
 * Falls back to mock data if no token or API fails.
 */
export async function searchTracks(
  query: string,
  options?: { userId?: string; districtId?: string; limit?: number },
): Promise<SearchTracksResult> {
  const token = await resolveToken(options?.userId, options?.districtId)
  if (!token) {
    return { tracks: MOCK_TRACKS, mock: true }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
    const limit = options?.limit ?? 5

    const res = await fetch(
      `${SPOTIFY_API_BASE}/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    )

    clearTimeout(timeout)

    if (!res.ok) {
      return { tracks: MOCK_TRACKS, mock: true }
    }

    const data = await res.json() as {
      tracks?: {
        items: Array<{
          id: string
          name: string
          artists: Array<{ name: string }>
          album?: { name: string }
          preview_url?: string | null
        }>
      }
    }

    const tracks: SpotifyTrack[] = (data.tracks?.items ?? []).map(item => ({
      name: item.name,
      artist: item.artists?.[0]?.name ?? 'Unknown',
      id: item.id,
      albumName: item.album?.name,
      previewUrl: item.preview_url,
    }))

    return { tracks }
  } catch {
    return { tracks: MOCK_TRACKS, mock: true }
  }
}

/**
 * Create a Spotify playlist for the user.
 * Requires a user-level access token (not client credentials).
 * Falls back to mock if no user token or API fails.
 */
export async function createPlaylist(
  name: string,
  options: { userId: string; districtId: string; description?: string; trackIds?: string[] },
): Promise<CreatePlaylistResult> {
  const token = await getUserSpotifyToken(options.userId, options.districtId)
  if (!token) {
    return { mock: true, playlistId: 'mock_playlist_1', name, playlistUrl: 'https://open.spotify.com/playlist/mock' }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

    // Get the Spotify user ID from the token
    const meRes = await fetch(`${SPOTIFY_API_BASE}/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })

    if (!meRes.ok) {
      clearTimeout(timeout)
      return { mock: true, playlistId: 'mock_playlist_1', name, playlistUrl: 'https://open.spotify.com/playlist/mock' }
    }

    const me = await meRes.json() as { id: string }

    // Create the playlist
    const createRes = await fetch(`${SPOTIFY_API_BASE}/users/${me.id}/playlists`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        description: options.description ?? `Created by ChatBridge`,
        public: false,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!createRes.ok) {
      return { mock: true, playlistId: 'mock_playlist_1', name, playlistUrl: 'https://open.spotify.com/playlist/mock' }
    }

    const playlist = await createRes.json() as {
      id: string
      external_urls: { spotify: string }
      name: string
    }

    // Optionally add tracks
    if (options.trackIds && options.trackIds.length > 0) {
      await fetch(`${SPOTIFY_API_BASE}/playlists/${playlist.id}/tracks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          uris: options.trackIds.map(id => `spotify:track:${id}`),
        }),
      })
    }

    return {
      playlistId: playlist.id,
      playlistUrl: playlist.external_urls.spotify,
      name: playlist.name,
    }
  } catch {
    return { mock: true, playlistId: 'mock_playlist_1', name, playlistUrl: 'https://open.spotify.com/playlist/mock' }
  }
}

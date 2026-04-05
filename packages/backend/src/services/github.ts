/**
 * GitHub service — fetches user repos and activity via GitHub API.
 *
 * - Uses stored OAuth access tokens from the database (per-user)
 * - Returns null if no token or API fails
 * - External public API — fallback to mock data is acceptable
 */

import { prisma, withTenantContext } from '../middleware/rls.js'

const GITHUB_API_BASE = 'https://api.github.com'
const API_TIMEOUT_MS = 5000

export interface GitHubRepository {
  name: string
  description: string | null
  url: string
  language: string | null
  stargazers_count: number
  updated_at: string
}

export interface GitHubActivity {
  type: string
  actor: { login: string }
  repo: { name: string }
  payload: Record<string, unknown>
  created_at: string
}

export interface GitHubUserProfile {
  login: string
  avatar_url: string
  public_repos: number
}

/**
 * Attempt to get a GitHub access token for the given user.
 * Returns null if no token is stored or decryption fails.
 */
async function getUserGitHubToken(userId: string, districtId: string): Promise<string | null> {
  try {
    const { decryptAES256GCM } = await import('../routes/auth.js')

    const oauthToken = await withTenantContext(districtId, async (tx) => {
      return tx.oAuthToken.findUnique({
        where: { userId_provider: { userId, provider: 'github' } },
      })
    })

    if (!oauthToken) return null
    // GitHub tokens typically don't expire, but check anyway
    if (oauthToken.expiresAt && oauthToken.expiresAt.getTime() <= Date.now() + 30_000) {
      return null // Token expired; no refresh mechanism for GitHub PAT
    }
    return decryptAES256GCM(oauthToken.accessTokenEncrypted)
  } catch {
    return null
  }
}

/**
 * Fetch the authenticated user's GitHub profile.
 */
export async function getUserProfile(accessToken: string): Promise<GitHubUserProfile | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

    const res = await fetch(`${GITHUB_API_BASE}/user`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'ChatBridge',
      },
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!res.ok) return null
    return await res.json() as GitHubUserProfile
  } catch {
    return null
  }
}

/**
 * Fetch the authenticated user's repositories, sorted by recently updated.
 */
export async function getUserRepos(userId: string, districtId: string, limit = 10): Promise<GitHubRepository[]> {
  const accessToken = await getUserGitHubToken(userId, districtId)
  if (!accessToken) return []
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

    const res = await fetch(
      `${GITHUB_API_BASE}/user/repos?sort=updated&direction=desc&per_page=${Math.min(limit, 20)}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'ChatBridge',
        },
        signal: controller.signal,
      },
    )

    clearTimeout(timeout)

    if (!res.ok) return []
    const repos = await res.json() as unknown[]
    return (repos as any[]).map(r => ({
      name: r.name,
      description: r.description,
      url: r.html_url,
      language: r.language,
      stargazers_count: r.stargazers_count,
      updated_at: r.updated_at,
    }))
  } catch {
    return []
  }
}

/**
 * Fetch the authenticated user's recent GitHub activity (events).
 */
export async function getRecentActivity(userId: string, districtId: string, limit = 10): Promise<GitHubActivity[]> {
  const accessToken = await getUserGitHubToken(userId, districtId)
  if (!accessToken) return []

  // Get the username from the profile
  const profile = await getUserProfile(accessToken)
  if (!profile) return []
  const username = profile.login
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

    const res = await fetch(
      `${GITHUB_API_BASE}/users/${encodeURIComponent(username)}/events?per_page=${Math.min(limit, 30)}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'ChatBridge',
        },
        signal: controller.signal,
      },
    )

    clearTimeout(timeout)

    if (!res.ok) return []
    return await res.json() as unknown as GitHubActivity[]
  } catch {
    return []
  }
}

/**
 * Fetch repos and activity directly using an access token (not userId lookup).
 * Used internally to avoid double token lookup.
 */
async function fetchGitHubDataWithToken(
  accessToken: string,
  limit = 10,
): Promise<{ username: string; avatar_url: string; repos: GitHubRepository[]; activity: GitHubActivity[] } | null> {
  const profile = await getUserProfile(accessToken)
  if (!profile) return null

  const controller1 = new AbortController()
  const t1 = setTimeout(() => controller1.abort(), API_TIMEOUT_MS)
  const reposRes = await fetch(
    `${GITHUB_API_BASE}/user/repos?sort=updated&direction=desc&per_page=${Math.min(limit, 20)}`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'ChatBridge' },
      signal: controller1.signal,
    },
  )
  clearTimeout(t1)
  const rawRepos = reposRes.ok ? (await reposRes.json() as any[]) : []
  const repos: GitHubRepository[] = rawRepos.map((r: any) => ({
    name: r.name,
    description: r.description,
    url: r.html_url,
    language: r.language,
    stargazers_count: r.stargazers_count,
    updated_at: r.updated_at,
  }))

  const controller2 = new AbortController()
  const t2 = setTimeout(() => controller2.abort(), API_TIMEOUT_MS)
  const actRes = await fetch(
    `${GITHUB_API_BASE}/users/${encodeURIComponent(profile.login)}/events?per_page=${Math.min(limit, 30)}`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'ChatBridge' },
      signal: controller2.signal,
    },
  )
  clearTimeout(t2)
  const activity = actRes.ok ? (await actRes.json() as GitHubActivity[]) : []

  return { username: profile.login, avatar_url: profile.avatar_url, repos, activity }
}

/**
 * Fetch user's complete GitHub data for display in the app.
 * Returns null if no token or API fails.
 */
export async function getGitHubData(
  userId: string,
  districtId: string,
): Promise<{ username: string; avatar_url: string; repos: GitHubRepository[]; activity: GitHubActivity[] } | null> {
  const token = await getUserGitHubToken(userId, districtId)
  if (!token) return null

  try {
    return await fetchGitHubDataWithToken(token)
  } catch {
    return null
  }
}

/**
 * REST API client for ChatBridge backend
 *
 * Features:
 * - JWT Bearer auth header injection on every request
 * - Configurable base URL
 * - Typed endpoints for classroom CRUD, health check
 * - Error handling with status codes
 */

// --- Response types ---

export interface ClassroomSummary {
  id: string
  name: string
  gradeBand: string
}

export interface ClassroomListResponse {
  classrooms: ClassroomSummary[]
}

export interface ClassroomDetail {
  id: string
  name: string
  gradeBand: string
  aiConfig?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

export interface ClassroomCreatePayload {
  name: string
  gradeBand: string
  aiConfig?: Record<string, unknown>
}

export interface ClassroomUpdatePayload {
  name?: string
  gradeBand?: string
  aiConfig?: Record<string, unknown>
}

export interface ClassroomContextResponse {
  classroom: string
  gradeBand: string
}

export interface HealthResponse {
  status: string
  capabilities?: Record<string, string>
}

// --- Client ---

export class ChatBridgeRestClient {
  private baseUrl: string
  private token: string

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.token = token
  }

  setToken(token: string) {
    this.token = token
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  private headers(includeContentType = false): Record<string, string> {
    const h: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
    }
    if (includeContentType) {
      h['Content-Type'] = 'application/json'
    }
    return h
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const hasBody = body !== undefined
    const response = await fetch(this.url(path), {
      method,
      headers: this.headers(hasBody),
      body: hasBody ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      let message: string
      try {
        const err = await response.json()
        message = (err as Record<string, unknown>).message as string ?? `HTTP ${response.status}`
      } catch {
        message = `HTTP ${response.status}`
      }
      throw new Error(`${response.status}: ${message}`)
    }

    return response.json() as Promise<T>
  }

  // --- Classroom CRUD ---

  async getClassrooms(): Promise<ClassroomListResponse> {
    return this.request<ClassroomListResponse>('GET', '/api/v1/classrooms')
  }

  async getClassroom(id: string): Promise<ClassroomDetail> {
    return this.request<ClassroomDetail>('GET', `/api/v1/classrooms/${id}`)
  }

  async createClassroom(data: ClassroomCreatePayload): Promise<ClassroomDetail> {
    return this.request<ClassroomDetail>('POST', '/api/v1/classrooms', data)
  }

  async updateClassroom(id: string, data: ClassroomUpdatePayload): Promise<ClassroomDetail> {
    return this.request<ClassroomDetail>('PUT', `/api/v1/classrooms/${id}`, data)
  }

  async deleteClassroom(id: string): Promise<void> {
    await this.request<unknown>('DELETE', `/api/v1/classrooms/${id}`)
  }

  // --- Classroom Context (no auth required) ---

  async getClassroomContext(joinCode: string): Promise<ClassroomContextResponse> {
    // This endpoint is public — no auth header needed
    const response = await fetch(this.url(`/api/v1/classroom-context?joinCode=${encodeURIComponent(joinCode)}`))
    if (!response.ok) {
      throw new Error(`${response.status}: Classroom not found`)
    }
    return response.json() as Promise<ClassroomContextResponse>
  }

  // --- Health ---

  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/api/v1/health')
  }
}

// --- Tool Manifest types ---

export interface ToolManifestEntry {
  appId: string
  appName: string
  toolName: string
  description: string
  parameters: Record<string, unknown>
  uiManifest: { url: string; height?: number; width?: number; displayMode?: 'inline' | 'panel' }
}

export interface ToolManifestResponse {
  classroomId: string
  classroomName: string
  tools: ToolManifestEntry[]
}

// --- App Tool Invoke types ---

export interface AppToolInvokeResponse {
  toolName: string
  result: Record<string, unknown>
  instanceId?: string
  latencyMs: number
}

// --- Standalone functions (no auth required) ---

export async function getToolManifest(joinCode: string, apiHost: string): Promise<ToolManifestResponse> {
  const res = await fetch(`${apiHost}/api/v1/classrooms/by-join-code/${joinCode}/tool-manifest`)
  if (!res.ok) throw new Error(`Tool manifest fetch failed: ${res.status}`)
  return res.json()
}

export async function invokeAppTool(
  appId: string,
  toolName: string,
  params: Record<string, unknown>,
  conversationId: string,
  apiHost: string,
  apiKey: string,
): Promise<AppToolInvokeResponse> {
  const res = await fetch(`${apiHost}/api/v1/apps/${appId}/tools/${toolName}/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ parameters: params, conversationId }),
  })
  if (!res.ok) throw new Error(`Tool invoke failed: ${res.status}`)
  return res.json()
}

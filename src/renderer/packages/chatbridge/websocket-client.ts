/**
 * WebSocket client for ChatBridge backend
 *
 * Features:
 * - Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
 * - Heartbeat ping every 30s
 * - JWT auth via query param
 * - Message routing by type
 */

type MessageHandler = (data: Record<string, unknown>) => void

export class ChatBridgeWebSocket {
  private ws: WebSocket | null = null
  private url: string
  private token: string
  private reconnectAttempts = 0
  private maxReconnectDelay = 30000 // 30s
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private messageHandlers = new Map<string, MessageHandler[]>()
  private onConnectHandlers: (() => void)[] = []
  private onDisconnectHandlers: (() => void)[] = []
  private shouldReconnect = true

  constructor(baseUrl: string, token: string) {
    this.url = baseUrl.replace('http', 'ws')
    this.token = token
  }

  connect(path: string = '/ws/chat') {
    if (this.ws?.readyState === WebSocket.OPEN) return

    const fullUrl = `${this.url}${path}?token=${this.token}`

    try {
      this.ws = new WebSocket(fullUrl)

      this.ws.onopen = () => {
        this.reconnectAttempts = 0
        this.startHeartbeat()
        this.onConnectHandlers.forEach(h => h())
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as Record<string, unknown>
          const type = data.type as string
          if (type && this.messageHandlers.has(type)) {
            this.messageHandlers.get(type)!.forEach(h => h(data))
          }
          // Also fire wildcard handlers
          if (this.messageHandlers.has('*')) {
            this.messageHandlers.get('*')!.forEach(h => h(data))
          }
        } catch {
          // Ignore non-JSON messages
        }
      }

      this.ws.onclose = (event) => {
        this.stopHeartbeat()
        this.onDisconnectHandlers.forEach(h => h())

        // Don't reconnect on normal close or auth rejection
        if (event.code === 1000 || event.code === 4001 || !this.shouldReconnect) return

        this.scheduleReconnect(path)
      }

      this.ws.onerror = () => {
        // Error handling done via onclose
      }
    } catch {
      this.scheduleReconnect(path)
    }
  }

  private scheduleReconnect(path: string) {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay)
    this.reconnectAttempts++
    setTimeout(() => this.connect(path), delay)
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, 30000) // 30s
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  send(data: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  on(type: string, handler: MessageHandler) {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, [])
    }
    this.messageHandlers.get(type)!.push(handler)
  }

  onConnect(handler: () => void) {
    this.onConnectHandlers.push(handler)
  }

  onDisconnect(handler: () => void) {
    this.onDisconnectHandlers.push(handler)
  }

  disconnect() {
    this.shouldReconnect = false
    this.stopHeartbeat()
    this.ws?.close(1000)
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

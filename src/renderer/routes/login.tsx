import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useCallback } from 'react'

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const getApiHost = useCallback(() => {
    try {
      const raw = localStorage.getItem('settings')
      if (!raw) return 'http://localhost:3001'
      const settings = typeof raw === 'string' ? JSON.parse(raw) : raw
      const providers = settings?.providers ?? settings?.state?.providers ?? {}
      return providers?.chatbridge?.apiHost || 'http://localhost:3001'
    } catch {
      return 'http://localhost:3001'
    }
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const apiHost = getApiHost()
      const res = await fetch(`${apiHost}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: password || 'dev-mode1' }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error || `Login failed (${res.status})`)
        setLoading(false)
        return
      }

      const data = await res.json()
      localStorage.setItem('chatbridge:teacher_jwt', data.token)
      localStorage.setItem('chatbridge:teacher_user', JSON.stringify({
        role: data.role,
        displayName: data.displayName,
      }))

      navigate({ to: '/mission-control' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#F9FAFB',
        fontFamily: "'DM Sans', system-ui, sans-serif",
      }}
    >
      <div
        style={{
          width: 400,
          background: '#fff',
          borderRadius: 16,
          padding: 40,
          boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
          border: '1px solid #E5E7EB',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' }}>ChatBridge</h1>
          <p style={{ color: '#6B7280', fontSize: 14, marginTop: 8 }}>Teacher Login</p>
        </div>

        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teacher@chatbridge.test"
              required
              data-testid="login-email"
              style={{
                width: '100%',
                padding: '10px 14px',
                borderRadius: 8,
                border: '1px solid #D1D5DB',
                fontSize: 14,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6 }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="any password (dev mode)"
              data-testid="login-password"
              style={{
                width: '100%',
                padding: '10px 14px',
                borderRadius: 8,
                border: '1px solid #D1D5DB',
                fontSize: 14,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {error && (
            <div
              data-testid="login-error"
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                background: '#FEF2F2',
                border: '1px solid #FECACA',
                color: '#DC2626',
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            data-testid="login-submit"
            style={{
              padding: '12px 24px',
              borderRadius: 10,
              border: 'none',
              background: loading ? '#9CA3AF' : '#4F46E5',
              color: '#fff',
              fontSize: 15,
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              marginTop: 8,
            }}
          >
            {loading ? 'Logging in...' : 'Log In'}
          </button>
        </form>

        <div style={{ marginTop: 24, padding: '12px 16px', background: '#F3F4F6', borderRadius: 8, fontSize: 12, color: '#6B7280' }}>
          <strong>Dev credentials:</strong><br />
          Teacher: teacher@chatbridge.test<br />
          Student: student@chatbridge.test<br />
          Password: anything (dev mode ignores password)
        </div>
      </div>
    </div>
  )
}

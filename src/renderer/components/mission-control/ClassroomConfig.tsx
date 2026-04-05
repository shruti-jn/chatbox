/**
 * ClassroomConfig — classroom configuration panel for teachers
 *
 * Loads config via GET /api/v1/classrooms/:classroomId/config
 * Saves via PATCH /api/v1/classrooms/:classroomId/config
 * Lists apps via GET /api/v1/classrooms/:classroomId/apps
 * Toggles apps via PATCH /api/v1/classrooms/:classroomId/apps/:appId
 *
 * Student role guard: renders nothing for students.
 */

import { useState, useEffect, useCallback, type FC } from 'react'

// --- Types ---

interface AIConfig {
  mode?: 'socratic' | 'direct' | 'exploratory'
  subject?: string
  tone?: string
  complexity?: string
  asyncGuidance?: string
}

interface ClassroomConfigData {
  name: string
  gradeBand: string
  joinCode: string
  aiConfig: AIConfig
}

interface AppEntry {
  id: string
  name: string
  description: string | null
  enabled: boolean
  interactionModel: string | null
}

export interface ClassroomConfigProps {
  classroomId: string
  apiHost: string
  token: string
  userRole: 'teacher' | 'district_admin' | 'student'
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const AI_MODES: Array<{ value: string; label: string }> = [
  { value: 'socratic', label: 'Socratic' },
  { value: 'direct', label: 'Direct' },
  { value: 'exploratory', label: 'Exploratory' },
]

export const ClassroomConfig: FC<ClassroomConfigProps> = ({
  classroomId,
  apiHost,
  token,
  userRole,
}) => {
  const [config, setConfig] = useState<ClassroomConfigData | null>(null)
  const [apps, setApps] = useState<AppEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [activeTab, setActiveTab] = useState<'general' | 'apps'>('general')

  // Edited form state (separate from loaded config for dirty tracking)
  const [editedConfig, setEditedConfig] = useState<AIConfig>({})

  const baseUrl = apiHost.replace(/\/$/, '')

  const authHeaders = useCallback(
    (includeJson = false): Record<string, string> => {
      const h: Record<string, string> = { Authorization: `Bearer ${token}` }
      if (includeJson) h['Content-Type'] = 'application/json'
      return h
    },
    [token],
  )

  // Student role guard
  if (userRole === 'student') {
    return null
  }

  // Fetch config + apps on mount
  useEffect(() => {
    let cancelled = false

    const fetchAll = async () => {
      setLoading(true)
      try {
        const [configRes, appsRes] = await Promise.all([
          fetch(`${baseUrl}/api/v1/classrooms/${classroomId}/config`, { headers: authHeaders() }),
          fetch(`${baseUrl}/api/v1/classrooms/${classroomId}/apps`, { headers: authHeaders() }),
        ])

        if (!cancelled && configRes.ok) {
          const data = (await configRes.json()) as ClassroomConfigData
          setConfig(data)
          setEditedConfig(data.aiConfig ?? {})
        }

        if (!cancelled && appsRes.ok) {
          const data = (await appsRes.json()) as AppEntry[]
          setApps(data)
        }
      } catch {
        // Network error — will show empty state
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchAll()
    return () => { cancelled = true }
  }, [classroomId, baseUrl, authHeaders])

  // Save config
  const handleSave = useCallback(async () => {
    setSaveStatus('saving')
    setErrorMessage('')

    try {
      const res = await fetch(`${baseUrl}/api/v1/classrooms/${classroomId}/config`, {
        method: 'PATCH',
        headers: authHeaders(true),
        body: JSON.stringify({ aiConfig: editedConfig }),
      })

      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const err = await res.json()
          msg = (err as Record<string, unknown>).error as string ?? msg
        } catch {
          // keep default msg
        }
        throw new Error(msg)
      }

      setSaveStatus('saved')
      const updated = (await res.json()) as { id: string; aiConfig: AIConfig }
      setEditedConfig(updated.aiConfig ?? editedConfig)
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (err) {
      setSaveStatus('error')
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save')
    }
  }, [editedConfig, classroomId, baseUrl, authHeaders])

  // Toggle app
  const handleToggleApp = useCallback(
    async (appId: string, enabled: boolean) => {
      // Optimistic update
      setApps((prev) => prev.map((a) => (a.id === appId ? { ...a, enabled } : a)))

      try {
        const res = await fetch(`${baseUrl}/api/v1/classrooms/${classroomId}/apps/${appId}`, {
          method: 'PATCH',
          headers: authHeaders(true),
          body: JSON.stringify({ enabled }),
        })
        if (!res.ok) {
          // Revert on failure
          setApps((prev) => prev.map((a) => (a.id === appId ? { ...a, enabled: !enabled } : a)))
        }
      } catch {
        // Revert on network error
        setApps((prev) => prev.map((a) => (a.id === appId ? { ...a, enabled: !enabled } : a)))
      }
    },
    [classroomId, baseUrl, authHeaders],
  )

  if (loading) {
    return (
      <div data-testid="classroom-config" style={{ padding: 32, textAlign: 'center', color: '#9CA3AF' }}>
        Loading configuration...
      </div>
    )
  }

  const enabledCount = apps.filter((a) => a.enabled).length

  return (
    <div data-testid="classroom-config" style={{ maxWidth: 800, margin: '0 auto', padding: '32px 24px' }}>
      {/* Breadcrumb */}
      <nav style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#9CA3AF', marginBottom: 24 }}>
        <span style={{ color: '#6B7280', cursor: 'pointer' }}>Mission Control</span>
        <span style={{ color: '#E5E7EB' }}>/</span>
        <span style={{ color: '#6B7280' }}>{config?.name ?? 'Classroom'}</span>
        <span style={{ color: '#E5E7EB' }}>/</span>
        <span style={{ color: '#111827', fontWeight: 500 }}>Settings</span>
      </nav>

      {/* Tab Bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid #E5E7EB', marginBottom: 32 }}>
        {(['general', 'apps'] as const).map((tab) => (
          <button
            key={tab}
            data-testid={`config-tab-${tab}`}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '12px 20px', fontSize: 14, fontWeight: 500,
              color: activeTab === tab ? '#4F46E5' : '#6B7280',
              background: 'none', border: 'none',
              borderBottom: `2px solid ${activeTab === tab ? '#4F46E5' : 'transparent'}`,
              marginBottom: -1, cursor: 'pointer',
            }}
          >
            {tab === 'general' ? 'AI Behavior' : 'Apps'}
          </button>
        ))}
      </div>

      {/* General / AI Behavior Tab */}
      {activeTab === 'general' && (
        <div data-testid="config-general-panel">
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 24 }}>AI Behavior</h2>

          {/* AI Mode */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              AI Mode
            </label>
            <select
              data-testid="config-ai-mode"
              value={editedConfig.mode ?? 'socratic'}
              onChange={(e) => setEditedConfig((prev) => ({ ...prev, mode: e.target.value as AIConfig['mode'] }))}
              style={{
                width: '100%', padding: '8px 12px', fontSize: 14,
                border: '1px solid #E5E7EB', borderRadius: 8,
                background: '#F9FAFB', color: '#111827',
                fontFamily: "'Inter', sans-serif",
              }}
            >
              {AI_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          {/* Subject */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Subject
            </label>
            <input
              data-testid="config-subject"
              type="text"
              value={editedConfig.subject ?? ''}
              onChange={(e) => setEditedConfig((prev) => ({ ...prev, subject: e.target.value }))}
              placeholder="e.g., Mathematics, Science"
              style={{
                width: '100%', padding: '8px 12px', fontSize: 14,
                border: '1px solid #E5E7EB', borderRadius: 8,
                background: '#F9FAFB', color: '#111827',
                fontFamily: "'Inter', sans-serif",
              }}
            />
          </div>

          {/* Tone */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Tone
            </label>
            <input
              data-testid="config-tone"
              type="text"
              value={editedConfig.tone ?? ''}
              onChange={(e) => setEditedConfig((prev) => ({ ...prev, tone: e.target.value }))}
              placeholder="e.g., Encouraging, Formal, Casual"
              style={{
                width: '100%', padding: '8px 12px', fontSize: 14,
                border: '1px solid #E5E7EB', borderRadius: 8,
                background: '#F9FAFB', color: '#111827',
                fontFamily: "'Inter', sans-serif",
              }}
            />
          </div>

          {/* Complexity */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Complexity
            </label>
            <input
              data-testid="config-complexity"
              type="text"
              value={editedConfig.complexity ?? ''}
              onChange={(e) => setEditedConfig((prev) => ({ ...prev, complexity: e.target.value }))}
              placeholder="e.g., Beginner, Intermediate, Advanced"
              style={{
                width: '100%', padding: '8px 12px', fontSize: 14,
                border: '1px solid #E5E7EB', borderRadius: 8,
                background: '#F9FAFB', color: '#111827',
                fontFamily: "'Inter', sans-serif",
              }}
            />
          </div>

          {/* Async Guidance */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Async Guidance
            </label>
            <textarea
              data-testid="config-async-guidance"
              value={editedConfig.asyncGuidance ?? ''}
              onChange={(e) => setEditedConfig((prev) => ({ ...prev, asyncGuidance: e.target.value }))}
              placeholder="General guidance for the AI when no teacher is actively monitoring"
              style={{
                width: '100%', minHeight: 80, padding: '10px 12px', fontSize: 14,
                border: '1px solid #E5E7EB', borderRadius: 8,
                background: '#F9FAFB', color: '#111827', resize: 'vertical',
                fontFamily: "'Inter', sans-serif",
              }}
            />
          </div>
        </div>
      )}

      {/* Apps Tab */}
      {activeTab === 'apps' && (
        <div data-testid="config-apps-panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Available Apps</h2>
            <span style={{
              fontSize: 12, fontWeight: 500,
              padding: '2px 10px', borderRadius: 999,
              background: '#EEF2FF', color: '#4F46E5',
            }}>
              {enabledCount} enabled
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {apps.map((app) => (
              <div
                key={app.id}
                data-testid="app-row"
                style={{
                  display: 'flex', alignItems: 'center',
                  padding: '16px 24px',
                  background: '#FFFFFF',
                  border: '1px solid #E5E7EB',
                  borderRadius: 12,
                  gap: 16,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{app.name}</div>
                  {app.description && (
                    <div style={{ fontSize: 13, color: '#6B7280', marginTop: 2 }}>{app.description}</div>
                  )}
                </div>
                <label
                  data-testid={`app-toggle-${app.id}`}
                  style={{ position: 'relative', width: 44, height: 24, flexShrink: 0, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={app.enabled}
                    onChange={() => handleToggleApp(app.id, !app.enabled)}
                    style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
                  />
                  <span
                    style={{
                      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                      background: app.enabled ? '#4F46E5' : '#E5E7EB',
                      borderRadius: 999, transition: 'background 0.2s ease',
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        width: 20, height: 20,
                        left: app.enabled ? 22 : 2, top: 2,
                        background: '#FFFFFF',
                        borderRadius: '50%',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                        transition: 'left 0.2s ease',
                      }}
                    />
                  </span>
                </label>
              </div>
            ))}

            {apps.length === 0 && (
              <div style={{ textAlign: 'center', color: '#9CA3AF', padding: 32 }}>
                No apps available for this classroom.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Bottom Actions */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        marginTop: 32, paddingTop: 32,
        borderTop: '1px solid #E5E7EB',
      }}>
        <button
          data-testid="config-save-btn"
          onClick={handleSave}
          disabled={saveStatus === 'saving'}
          style={{
            padding: '10px 24px',
            background: saveStatus === 'saving' ? '#A5B4FC' : '#4F46E5',
            color: '#FFFFFF', border: 'none', borderRadius: 8,
            fontFamily: "'Inter', sans-serif", fontSize: 14, fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {saveStatus === 'saving' ? 'Saving...' : 'Save Changes'}
        </button>
        <button
          style={{
            padding: '10px 24px',
            background: 'transparent', color: '#9CA3AF', border: 'none',
            fontFamily: "'Inter', sans-serif", fontSize: 14, fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>

        {saveStatus === 'saved' && (
          <span data-testid="config-save-success" style={{ fontSize: 13, color: '#10B981', fontWeight: 500 }}>
            Changes saved
          </span>
        )}
        {saveStatus === 'error' && (
          <span data-testid="config-save-error" style={{ fontSize: 13, color: '#EF4444', fontWeight: 500 }}>
            {errorMessage || 'Failed to save'}
          </span>
        )}
      </div>
    </div>
  )
}

export default ClassroomConfig

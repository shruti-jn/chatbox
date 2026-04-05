import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef, useCallback } from 'react'
import Page from '@/components/layout/Page'
import { WhisperInput } from '@/components/mission-control/WhisperInput'
import { ClassroomConfig } from '@/components/mission-control/ClassroomConfig'

// --- Types ---

interface StudentTile {
  id: string
  displayName: string
  gradeBand: string | null
  status: 'active' | 'idle' | 'flagged'
  lastActivity: string
  currentApp: string | null
}

interface SafetyAlert {
  studentId: string
  severity: string
  category: string
  eventType: string
  timestamp: string
}

// --- Status colors ---

const STATUS_COLORS: Record<string, { bg: string; border: string; dot: string }> = {
  active: { bg: '#ECFDF5', border: '#10B981', dot: '#10B981' },
  idle: { bg: '#FFFBEB', border: '#F59E0B', dot: '#F59E0B' },
  flagged: { bg: '#FEF2F2', border: '#EF4444', dot: '#EF4444' },
}

// --- Route ---

export const Route = createFileRoute('/mission-control/')({
  component: MissionControlPage,
})

function MissionControlPage() {
  const [students, setStudents] = useState<StudentTile[]>([])
  const [alerts, setAlerts] = useState<SafetyAlert[]>([])
  const [selectedStudent, setSelectedStudent] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [activeView, setActiveView] = useState<'grid' | 'settings'>('grid')
  const [whisperOpenFor, setWhisperOpenFor] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  // Read teacher JWT from localStorage (set by /login page)
  const getSettings = useCallback(() => {
    try {
      const token = localStorage.getItem('chatbridge:teacher_jwt') ?? ''
      // API host from Chatbox settings or default
      const raw = localStorage.getItem('settings')
      let apiHost = 'http://localhost:3001'
      if (raw) {
        const settings = typeof raw === 'string' ? JSON.parse(raw) : raw
        const providers = settings?.providers ?? settings?.state?.providers ?? {}
        apiHost = providers?.chatbridge?.apiHost || apiHost
      }
      return { apiHost, token }
    } catch {
      return { apiHost: 'http://localhost:3001', token: '' }
    }
  }, [])

  // Fetch initial student list via REST
  const fetchStudents = useCallback(async (classroomId: string) => {
    const { apiHost, token } = getSettings()
    try {
      const res = await fetch(`${apiHost}/api/v1/classrooms/${classroomId}/students`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        setStudents(data.students ?? [])
      }
    } catch {
      // Will get data via WS instead
    }
  }, [getSettings])

  const [classrooms, setClassrooms] = useState<Array<{ id: string; name: string }>>([])
  const [selectedClassroom, setSelectedClassroom] = useState<string>('')

  // Fetch teacher's classrooms on mount
  useEffect(() => {
    const { apiHost, token } = getSettings()
    if (!token) return
    fetch(`${apiHost}/api/v1/classrooms`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        const list = data?.classrooms ?? data ?? []
        setClassrooms(Array.isArray(list) ? list : [])
        if (list.length > 0 && !selectedClassroom) {
          setSelectedClassroom(list[0].id)
        }
      })
      .catch(() => {})
  }, [getSettings])

  // Connect WebSocket to mission control
  useEffect(() => {
    const { apiHost, token } = getSettings()
    if (!token || !selectedClassroom) return
    const classroomId = selectedClassroom
    const wsUrl = `${apiHost.replace('http', 'ws')}/api/v1/ws/mission-control?token=${token}&classroomId=${classroomId}`

    const connect = () => {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        // Auto-reconnect after 3s
        setTimeout(connect, 3000)
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)

          if (msg.type === 'student_list') {
            setStudents(msg.students ?? [])
          }

          if (msg.type === 'student_activity') {
            setStudents((prev) =>
              prev.map((s) =>
                s.id === msg.studentId
                  ? { ...s, status: 'active' as const, lastActivity: msg.timestamp }
                  : s,
              ),
            )
          }

          if (msg.type === 'safety_alert') {
            // Mark student as flagged
            setStudents((prev) =>
              prev.map((s) =>
                s.id === msg.studentId ? { ...s, status: 'flagged' as const } : s,
              ),
            )
            // Add to alerts list
            setAlerts((prev) => [msg as SafetyAlert, ...prev.slice(0, 49)])
          }
        } catch {}
      }
    }

    connect()

    return () => {
      wsRef.current?.close()
    }
  }, [getSettings, selectedClassroom])

  // Time ago helper
  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime()
    if (diff < 60_000) return 'just now'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
    return `${Math.floor(diff / 3600_000)}h ago`
  }

  const selectedAlerts = alerts.filter((a) => a.studentId === selectedStudent)
  const { apiHost, token } = getSettings()
  const classroomId = selectedClassroom || 'default'

  return (
    <Page title="Mission Control">
      <div style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Header bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Mission Control</h2>
          {classrooms.length > 0 && (
            <select
              value={selectedClassroom}
              onChange={(e) => setSelectedClassroom(e.target.value)}
              data-testid="classroom-selector"
              style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid #D1D5DB', fontSize: 13 }}
            >
              {classrooms.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 12px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 500,
              background: connected ? '#ECFDF5' : '#FEF2F2',
              color: connected ? '#059669' : '#DC2626',
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: connected ? '#10B981' : '#EF4444',
              }}
            />
            {connected ? 'Live' : 'Disconnected'}
          </span>
          <span style={{ fontSize: 13, color: '#6B7280' }}>{students.length} students</span>

          {/* Nav tabs: Grid | Settings */}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              data-testid="nav-grid"
              onClick={() => setActiveView('grid')}
              style={{
                padding: '6px 16px', fontSize: 13, fontWeight: 500,
                background: activeView === 'grid' ? '#EEF2FF' : 'transparent',
                color: activeView === 'grid' ? '#4F46E5' : '#6B7280',
                border: '1px solid', borderColor: activeView === 'grid' ? '#C7D2FE' : '#E5E7EB',
                borderRadius: 8, cursor: 'pointer',
              }}
            >
              Students
            </button>
            <button
              data-testid="nav-settings"
              onClick={() => setActiveView('settings')}
              style={{
                padding: '6px 16px', fontSize: 13, fontWeight: 500,
                background: activeView === 'settings' ? '#EEF2FF' : 'transparent',
                color: activeView === 'settings' ? '#4F46E5' : '#6B7280',
                border: '1px solid', borderColor: activeView === 'settings' ? '#C7D2FE' : '#E5E7EB',
                borderRadius: 8, cursor: 'pointer',
              }}
            >
              Settings
            </button>
          </div>
        </div>

        {/* Settings View */}
        {activeView === 'settings' && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <ClassroomConfig
              classroomId={classroomId}
              apiHost={apiHost}
              token={token}
              userRole="teacher"
            />
          </div>
        )}

        {/* Grid View */}
        {activeView === 'grid' && (
          <div style={{ display: 'flex', flex: 1, gap: 16, minHeight: 0 }}>
            {/* Student grid */}
            <div
              style={{
                flex: 1,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                gap: 12,
                alignContent: 'start',
                overflowY: 'auto',
              }}
            >
              {students.map((student) => {
                const colors = STATUS_COLORS[student.status] ?? STATUS_COLORS.idle
                const isWhisperOpen = whisperOpenFor === student.id
                return (
                  <div
                    key={student.id}
                    data-testid="student-tile"
                    data-status={student.status}
                    data-last-activity={student.lastActivity}
                    data-current-app={student.currentApp ?? ''}
                    style={{
                      borderRadius: 10,
                      border: `2px solid ${colors.border}`,
                      background: colors.bg,
                      transition: 'box-shadow 0.15s',
                      boxShadow: selectedStudent === student.id ? `0 0 0 3px ${colors.border}40` : 'none',
                      overflow: 'hidden',
                    }}
                  >
                    {/* Tile header - clickable */}
                    <div
                      onClick={() => setSelectedStudent(student.id)}
                      style={{ padding: 14, cursor: 'pointer' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <span
                          style={{
                            width: 10, height: 10,
                            borderRadius: '50%', background: colors.dot, flexShrink: 0,
                          }}
                        />
                        <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {student.displayName}
                        </span>
                        {/* Whisper button */}
                        <button
                          data-testid={`whisper-toggle-${student.id}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setWhisperOpenFor(isWhisperOpen ? null : student.id)
                          }}
                          title="Send whisper to AI"
                          style={{
                            width: 28, height: 28, borderRadius: 6,
                            background: isWhisperOpen ? '#4F46E5' : '#EEF2FF',
                            color: isWhisperOpen ? '#FFFFFF' : '#4F46E5',
                            border: 'none', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0,
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                          </svg>
                        </button>
                      </div>
                      <div style={{ fontSize: 12, color: '#6B7280', display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span>{timeAgo(student.lastActivity)}</span>
                        {student.currentApp && (
                          <span style={{ color: '#4F46E5', fontWeight: 500 }}>{student.currentApp}</span>
                        )}
                        {student.gradeBand && (
                          <span style={{ color: '#9CA3AF' }}>{student.gradeBand.toUpperCase()}</span>
                        )}
                      </div>
                    </div>

                    {/* Inline whisper input */}
                    {isWhisperOpen && (
                      <WhisperInput
                        classroomId={classroomId}
                        studentId={student.id}
                        apiHost={apiHost}
                        token={token}
                        onWhisperSent={() => setWhisperOpenFor(null)}
                      />
                    )}
                  </div>
                )
              })}

              {students.length === 0 && (
                <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#9CA3AF', padding: 48 }}>
                  No students in this classroom yet.
                </div>
              )}
            </div>

            {/* Detail panel */}
            {selectedStudent && (
              <div
                data-testid="student-detail-panel"
                style={{
                  width: 320,
                  borderLeft: '1px solid #E5E7EB',
                  paddingLeft: 16,
                  overflowY: 'auto',
                }}
              >
                <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
                  {students.find((s) => s.id === selectedStudent)?.displayName ?? 'Student'}
                </h3>

                {selectedAlerts.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <h4 style={{ fontSize: 13, fontWeight: 600, color: '#EF4444' }}>Safety Alerts</h4>
                    {selectedAlerts.map((alert, i) => (
                      <div
                        key={`${alert.timestamp}-${i}`}
                        data-testid="safety-alert-detail"
                        style={{
                          padding: 10,
                          borderRadius: 8,
                          background: '#FEF2F2',
                          border: '1px solid #FECACA',
                          fontSize: 13,
                        }}
                      >
                        <div style={{ fontWeight: 600, color: '#DC2626' }}>{alert.eventType}</div>
                        <div style={{ color: '#6B7280', marginTop: 4 }}>
                          Severity: {alert.severity}
                        </div>
                        <div style={{ color: '#9CA3AF', fontSize: 11, marginTop: 2 }}>
                          {new Date(alert.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: '#9CA3AF', fontSize: 13 }}>No alerts for this student.</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Page>
  )
}

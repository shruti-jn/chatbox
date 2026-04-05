/**
 * WhisperInput — inline whisper compose widget shown on each student tile
 *
 * Sends teacher guidance to the AI via POST /api/v1/classrooms/:classroomId/students/:studentId/whisper.
 * The student never sees the whisper text; it only shapes AI behavior.
 */

import { useState, useCallback, type FC } from 'react'

const MAX_CHARS = 2000

export interface WhisperInputProps {
  classroomId: string
  studentId: string
  apiHost: string
  token: string
  onWhisperSent?: () => void
}

type WhisperStatus = 'idle' | 'sending' | 'success' | 'error'

export const WhisperInput: FC<WhisperInputProps> = ({
  classroomId,
  studentId,
  apiHost,
  token,
  onWhisperSent,
}) => {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<WhisperStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  const charCount = text.length

  const handleSend = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || trimmed.length > MAX_CHARS) return

    setStatus('sending')
    setErrorMessage('')

    try {
      const res = await fetch(
        `${apiHost.replace(/\/$/, '')}/api/v1/classrooms/${classroomId}/students/${studentId}/whisper`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ text: trimmed }),
        },
      )

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

      setStatus('success')
      setText('')
      onWhisperSent?.()

      // Reset success indicator after 2s
      setTimeout(() => setStatus('idle'), 2000)
    } catch (err) {
      setStatus('error')
      setErrorMessage(err instanceof Error ? err.message : 'Failed to send whisper')
    }
  }, [text, classroomId, studentId, apiHost, token, onWhisperSent])

  const handleCancel = useCallback(() => {
    setText('')
    setStatus('idle')
    setErrorMessage('')
  }, [])

  return (
    <div data-testid="whisper-input" style={{ borderTop: '1px solid #E5E7EB', padding: 16, background: '#FFFFFF' }}>
      {/* Label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#4F46E5' }}>Whisper to AI</span>
        <span
          title="This guidance will shape how the AI responds to the student. The student will not see your whisper."
          style={{
            width: 16, height: 16, borderRadius: '50%',
            background: '#EEF2FF', color: '#4F46E5',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 700, cursor: 'help',
          }}
        >
          ?
        </span>
      </div>

      {/* Tooltip */}
      <p style={{ fontSize: 11, color: '#9CA3AF', marginBottom: 8, lineHeight: 1.4 }}>
        This guidance will shape how the AI responds to the student. The student will not see your whisper.
      </p>

      {/* Textarea */}
      <textarea
        data-testid="whisper-textarea"
        value={text}
        onChange={(e) => {
          if (e.target.value.length <= MAX_CHARS) {
            setText(e.target.value)
            if (status === 'error') setStatus('idle')
          }
        }}
        placeholder="e.g., Guide the student toward discovering the Pythagorean theorem rather than giving the formula directly"
        disabled={status === 'sending'}
        style={{
          width: '100%', minHeight: 72, padding: '10px 12px',
          border: '1px solid #E5E7EB', borderRadius: 8,
          fontFamily: "'Inter', sans-serif", fontSize: 13, lineHeight: 1.5,
          color: '#111827', resize: 'vertical', background: '#F9FAFB',
          outline: 'none',
        }}
      />

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
        <span
          data-testid="whisper-char-count"
          style={{
            fontSize: 11,
            color: charCount > MAX_CHARS * 0.9 ? '#EF4444' : '#9CA3AF',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {charCount} / {MAX_CHARS}
        </span>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleCancel}
            disabled={status === 'sending'}
            style={{
              padding: '8px 16px', background: 'transparent', color: '#6B7280',
              border: '1px solid #E5E7EB', borderRadius: 8,
              fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 500, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            data-testid="whisper-send-btn"
            onClick={handleSend}
            disabled={status === 'sending' || !text.trim()}
            style={{
              padding: '8px 16px',
              background: status === 'sending' || !text.trim() ? '#A5B4FC' : '#4F46E5',
              color: '#FFFFFF',
              border: 'none', borderRadius: 8,
              fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 500, cursor: 'pointer',
            }}
          >
            {status === 'sending' ? 'Sending...' : 'Send Whisper'}
          </button>
        </div>
      </div>

      {/* Status feedback */}
      {status === 'success' && (
        <div data-testid="whisper-success" style={{ marginTop: 8, fontSize: 12, color: '#10B981', fontWeight: 500 }}>
          Whisper sent successfully
        </div>
      )}
      {status === 'error' && (
        <div data-testid="whisper-error" style={{ marginTop: 8, fontSize: 12, color: '#EF4444', fontWeight: 500 }}>
          {errorMessage || 'Failed to send whisper'}
        </div>
      )}
    </div>
  )
}

export default WhisperInput

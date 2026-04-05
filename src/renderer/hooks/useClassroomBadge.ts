/**
 * Hook to populate the chatbridgeClassroom badge on sessions using the ChatBridge provider.
 *
 * When a session's provider is 'chatbridge' and the provider settings include a
 * chatbridgeJoinCode, this hook fetches the classroom name + grade band from the
 * backend and writes it to session.chatbridgeClassroom (one-time).
 */

import { useEffect, useRef } from 'react'
import type { Session } from '@shared/types'
import { updateSession } from '@/stores/chatStore'
import { settingsStore } from '@/stores/settingsStore'

const GRADE_BAND_LABELS: Record<string, string> = {
  k2: 'K-2',
  g35: 'Grade 3-5',
  g68: 'Grade 6-8',
  g912: 'Grade 9-12',
}

export function useClassroomBadge(session: Session | null | undefined) {
  const fetched = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!session) return
    // Already has badge text — nothing to do
    if (session.chatbridgeClassroom) return
    // Already attempted for this session
    if (fetched.current.has(session.id)) return

    const provider = session.settings?.provider
    if (provider !== 'chatbridge') return

    const settings = settingsStore.getState()
    const providerSettings = settings.providers?.chatbridge
    const joinCode = providerSettings?.chatbridgeJoinCode
    const apiHost = providerSettings?.apiHost ?? 'http://localhost:3001'

    if (!joinCode) return

    fetched.current.add(session.id)

    // Fetch classroom context from the backend (no auth needed)
    const url = `${apiHost.replace(/\/$/, '')}/api/v1/classroom-context?joinCode=${encodeURIComponent(joinCode)}`

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ classroom: string; gradeBand: string }>
      })
      .then((data) => {
        const gradeBandLabel = GRADE_BAND_LABELS[data.gradeBand] ?? data.gradeBand
        const badgeText = `${data.classroom} \u00b7 ${gradeBandLabel}`
        updateSession(session.id, { chatbridgeClassroom: badgeText })
      })
      .catch(() => {
        // Silently fail — badge just won't show
      })
  }, [session?.id, session?.chatbridgeClassroom, session?.settings?.provider])
}

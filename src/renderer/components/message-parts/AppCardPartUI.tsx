/**
 * AppCardPartUI — Renders third-party apps in sandboxed iframes inline in chat
 *
 * Lifecycle: loading → active → suspended → collapsed → terminated → error
 * Single active constraint: only one app card active at a time
 * CBP communication via postMessage with origin validation
 */

import React, { useRef, useEffect, useState, useCallback } from 'react'
import type { AppCardPart } from '@chatbridge/shared'
import { authInfoStore } from '@/stores/authInfoStore'
import {
  addAllowedOrigin,
  connectAppInstance,
  disconnectAppInstance,
  initCBPListener,
  registerAppIframe,
  sendCommand,
  sendLifecycleEvent,
  unregisterAppIframe,
} from '../../packages/chatbridge/cbp-client'

interface AppCardPartUIProps {
  part: AppCardPart
  onStateUpdate?: (instanceId: string, state: Record<string, unknown>) => void
  onCompletion?: (instanceId: string, result: Record<string, unknown>) => void
  onExpand?: (instanceId: string) => void
}

const STATUS_STYLES: Record<string, React.CSSProperties> = {
  loading: { opacity: 0.7 },
  active: { opacity: 1 },
  suspended: { opacity: 0.6, maxHeight: '48px', overflow: 'hidden', cursor: 'pointer' },
  collapsed: { opacity: 0.8, maxHeight: '64px', overflow: 'hidden', cursor: 'pointer' },
  terminated: { opacity: 0.5, filter: 'grayscale(0.5)' },
  error: { border: '2px solid #E11D48' },
}

export function AppCardPartUI({ part, onStateUpdate, onCompletion, onExpand }: AppCardPartUIProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    initCBPListener()
  }, [])

  useEffect(() => {
    if (!part.instanceId || !iframeRef.current || !part.url) return

    try {
      const appUrl = new URL(part.url, window.location.origin)
      addAllowedOrigin(appUrl.origin)

      registerAppIframe(part.instanceId, iframeRef.current)

      const wsProtocol = appUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${wsProtocol}//${appUrl.host}/api/v1/ws/chat`
      const token = authInfoStore.getState().accessToken ?? ''
      connectAppInstance(part.instanceId, wsUrl, token)
    } catch {
      // Best-effort wiring for host bridge. The iframe still renders even if
      // the websocket bridge can't be established.
    }

    return () => {
      unregisterAppIframe(part.instanceId)
      disconnectAppInstance(part.instanceId)
    }
  }, [part.instanceId, part.url])

  // Send instance ID to app once iframe loads
  useEffect(() => {
    if (isLoaded && iframeRef.current && part.instanceId) {
      sendCommand(iframeRef.current, part.instanceId, 'set_instance_id', {
        instance_id: part.instanceId,
      })
    }
  }, [isLoaded, part.instanceId])

  // Handle lifecycle changes
  useEffect(() => {
    if (!iframeRef.current || !part.instanceId) return

    if (part.status === 'suspended') {
      sendLifecycleEvent(iframeRef.current, part.instanceId, 'suspend')
    } else if (part.status === 'terminated') {
      sendLifecycleEvent(iframeRef.current, part.instanceId, 'terminate')
    }
  }, [part.status, part.instanceId])

  const handleLoad = useCallback(() => {
    setIsLoaded(true)
    setError(null)
  }, [])

  const handleError = useCallback(() => {
    setError('App failed to load')
  }, [])

  const handleClick = useCallback(() => {
    if (part.status === 'suspended' || part.status === 'collapsed') {
      onExpand?.(part.instanceId)
    }
  }, [part.status, part.instanceId, onExpand])

  // Loading skeleton
  if (part.status === 'loading' && !isLoaded) {
    return (
      <div style={{
        background: '#F1F5F9',
        borderRadius: '12px',
        padding: '16px',
        margin: '8px 0',
        animation: 'shimmer 1.5s infinite',
        height: part.height ?? 300,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#E2E8F0' }} />
          <div style={{ fontSize: '14px', color: '#64748B' }}>Opening {part.appName}...</div>
        </div>
        <div style={{ background: '#E2E8F0', borderRadius: '8px', height: '80%' }} />
      </div>
    )
  }

  // Error state
  if (error || part.status === 'error') {
    return (
      <div style={{
        background: '#FFF1F2',
        border: '2px solid #FECDD3',
        borderRadius: '12px',
        padding: '16px',
        margin: '8px 0',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: '24px', marginBottom: '8px' }}>⚠️</div>
        <div style={{ color: '#E11D48', fontSize: '14px', marginBottom: '8px' }}>
          {error ?? 'App encountered an error'}
        </div>
        <button
          onClick={() => { setError(null); setIsLoaded(false) }}
          style={{
            padding: '8px 16px',
            background: '#4F46E5',
            color: 'white',
            border: 'none',
            borderRadius: '20px',
            cursor: 'pointer',
            fontSize: '13px',
          }}
        >
          Retry
        </button>
      </div>
    )
  }

  // Suspended (thumbnail)
  if (part.status === 'suspended') {
    return (
      <div
        onClick={handleClick}
        style={{
          background: '#F8FAFC',
          border: '1px solid #E2E8F0',
          borderRadius: '12px',
          padding: '12px 16px',
          margin: '8px 0',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          transition: 'background 0.2s',
        }}
      >
        <span style={{ fontSize: '16px' }}>⏸️</span>
        <span style={{ fontSize: '13px', color: '#64748B' }}>
          {part.appName} — paused (tap to resume)
        </span>
      </div>
    )
  }

  // Collapsed (completed)
  if (part.status === 'collapsed') {
    return (
      <div
        onClick={handleClick}
        style={{
          background: '#F0FDF4',
          border: '1px solid #BBF7D0',
          borderRadius: '12px',
          padding: '12px 16px',
          margin: '8px 0',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <span style={{ fontSize: '16px' }}>✅</span>
        <span style={{ fontSize: '13px', color: '#166534' }}>
          {part.summary ?? `${part.appName} — completed`}
        </span>
      </div>
    )
  }

  // Terminated
  if (part.status === 'terminated') {
    return (
      <div style={{
        background: '#F8FAFC',
        border: '1px solid #E2E8F0',
        borderRadius: '12px',
        padding: '12px 16px',
        margin: '8px 0',
        opacity: 0.5,
        filter: 'grayscale(0.5)',
      }}>
        <span style={{ fontSize: '13px', color: '#94A3B8' }}>
          {part.appName} — ended
        </span>
      </div>
    )
  }

  // Active — render iframe
  return (
    <div style={{
      borderRadius: '12px',
      overflow: 'hidden',
      margin: '8px 0',
      border: '1px solid #E2E8F0',
      boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
      transition: 'all 0.3s ease-out',
    }}>
      {part.url && (
        <iframe
          ref={iframeRef}
          src={part.url}
          onLoad={handleLoad}
          onError={handleError}
          sandbox="allow-scripts allow-same-origin"
          data-testid={`app-card-iframe-${part.appName.toLowerCase()}`}
          style={{
            width: '100%',
            height: part.height ?? 400,
            border: 'none',
            display: 'block',
          }}
          title={`${part.appName} app`}
        />
      )}
    </div>
  )
}

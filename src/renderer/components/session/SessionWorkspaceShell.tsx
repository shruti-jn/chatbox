import type { PropsWithChildren } from 'react'
import type { MessageAppCardPart } from '@shared/types'

interface SessionWorkspaceShellProps extends PropsWithChildren {
  activePanelApp?: MessageAppCardPart
  miniPlayerApps: MessageAppCardPart[]
  onFocusApp: (instanceId: string) => void
  onMinimizeApp: (instanceId: string) => void
  onRestoreApp: (instanceId: string) => void
}

function PanelFrame({ app }: { app: MessageAppCardPart }) {
  return (
    <iframe
      src={app.url}
      title={`${app.appName} panel`}
      className="h-full w-full border-0 bg-white"
      sandbox="allow-scripts allow-same-origin"
    />
  )
}

export function SessionWorkspaceShell({
  activePanelApp,
  miniPlayerApps,
  onFocusApp,
  onMinimizeApp,
  onRestoreApp,
  children,
}: SessionWorkspaceShellProps) {
  const showPanel = !!activePanelApp
  const showMiniPlayer = miniPlayerApps.length > 0

  return (
    <div
      data-testid="session-workspace-shell"
      className={`flex h-full min-h-0 ${showPanel ? 'gap-4 px-4 pb-4 pt-2' : 'px-0'} `}
    >
      {showPanel && activePanelApp && (
        <section
          data-testid="session-app-panel"
          className="flex min-h-0 min-w-[340px] flex-[0_0_42%] flex-col overflow-hidden rounded-3xl border border-solid border-chatbox-border-primary bg-chatbox-background-secondary shadow-sm"
        >
          <header className="flex items-center justify-between border-b border-solid border-chatbox-border-primary px-4 py-3">
            <button
              type="button"
              className="rounded-full border border-solid border-chatbox-border-primary bg-transparent px-3 py-1 text-sm"
              onClick={() => onFocusApp(activePanelApp.instanceId)}
            >
              {activePanelApp.appName}
            </button>
            <button
              type="button"
              aria-label={`Minimize ${activePanelApp.appName}`}
              className="rounded-full border border-solid border-chatbox-border-primary bg-transparent px-3 py-1 text-sm"
              onClick={() => onMinimizeApp(activePanelApp.instanceId)}
            >
              Minimize
            </button>
          </header>
          <div className="min-h-0 flex-1 bg-white">
            {activePanelApp.url ? (
              <PanelFrame app={activePanelApp} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-chatbox-tertiary">
                App URL unavailable
              </div>
            )}
          </div>
        </section>
      )}

      <section className="flex min-h-0 flex-1 flex-col">
        {showMiniPlayer && (
          <div
            data-testid="session-mini-player"
            className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-solid border-chatbox-border-primary bg-chatbox-background-secondary px-3 py-2"
          >
            {miniPlayerApps.map((app) => (
              <button
                key={app.instanceId}
                type="button"
                aria-label={`Resume ${app.appName}`}
                className="rounded-full border border-solid border-chatbox-border-primary bg-transparent px-3 py-1 text-sm"
                onClick={() => onRestoreApp(app.instanceId)}
              >
                {app.summary ?? `${app.appName} in background`}
              </button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1">{children}</div>
      </section>
    </div>
  )
}

/**
 * App Instance Lifecycle FSM
 *
 * Table-driven finite state machine for app instance lifecycle management.
 * States align with Prisma enum AppInstanceStatus.
 */

export type AppState = 'loading' | 'active' | 'suspended' | 'collapsed' | 'terminated' | 'error'

export type AppEvent = 'activate' | 'suspend' | 'complete' | 'terminate' | 'fail' | 'resume' | 'expand' | 'retry'

/**
 * Transition table: maps (currentState, event) -> nextState.
 * Missing entries mean the transition is invalid.
 */
export const TRANSITIONS: Record<AppState, Partial<Record<AppEvent, AppState>>> = {
  loading:    { activate: 'active', fail: 'error', terminate: 'terminated' },
  active:     { suspend: 'suspended', complete: 'collapsed', terminate: 'terminated', fail: 'error' },
  suspended:  { resume: 'active', terminate: 'terminated', fail: 'error' },
  collapsed:  { expand: 'active', terminate: 'terminated' },
  terminated: {},
  error:      { retry: 'loading', terminate: 'terminated' },
}

const TERMINAL_STATES: ReadonlySet<AppState> = new Set(['terminated'])

/**
 * Check if a state is terminal (no valid outbound transitions).
 */
export function isTerminal(state: AppState): boolean {
  return TERMINAL_STATES.has(state)
}

/**
 * Check whether a transition from currentState via event is valid.
 */
export function canTransition(currentState: AppState, event: string): boolean {
  const stateTransitions = TRANSITIONS[currentState]
  if (!stateTransitions) return false
  return event in stateTransitions
}

/**
 * Execute a state transition. Returns the new state.
 * Throws if the transition is invalid.
 */
export function transition(currentState: AppState, event: string): AppState {
  const stateTransitions = TRANSITIONS[currentState]
  if (!stateTransitions) {
    throw new InvalidTransitionError(currentState, event)
  }

  const nextState = stateTransitions[event as AppEvent]
  if (nextState === undefined) {
    throw new InvalidTransitionError(currentState, event)
  }

  return nextState
}

export class InvalidTransitionError extends Error {
  public readonly currentState: string
  public readonly event: string

  constructor(currentState: string, event: string) {
    super(`Invalid transition: cannot apply event '${event}' in state '${currentState}'`)
    this.name = 'InvalidTransitionError'
    this.currentState = currentState
    this.event = event
  }
}

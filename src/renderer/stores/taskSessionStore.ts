// Task sessions are not available in the open-source edition
import type { TaskSession } from '@shared/types'
import { createStore, useStore } from 'zustand'

export const TASK_SESSION_QUERY_KEY = 'task-session'

export const taskSessionStore = createStore(() => ({
  currentTaskId: null as string | null,
  initialized: false,
  setCurrentTaskId: (_id: string | null) => {},
  setInitialized: (_initialized: boolean) => {},
}))

export function useTaskSessionStore<T>(selector: (state: ReturnType<typeof taskSessionStore.getState>) => T): T {
  return useStore(taskSessionStore, selector)
}

export async function getTaskSession(_id: string) {
  return null
}

export async function updateTaskSession(_id: string, _updates: Partial<TaskSession>): Promise<TaskSession | null> {
  return null
}

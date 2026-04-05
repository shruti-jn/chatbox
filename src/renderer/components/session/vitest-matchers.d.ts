import 'vitest'

declare module 'vitest' {
  interface Assertion<T = any> {
    toBeInTheDocument(): T
  }

  interface AsymmetricMatchersContaining {
    toBeInTheDocument(): void
  }
}

import { describe, expect, it } from 'vitest'
import { UIManifestSchema } from '../../../packages/shared/src/schemas/apps'

describe('UIManifestSchema display mode routing', () => {
  it('defaults apps to inline rendering when displayMode is omitted', () => {
    const parsed = UIManifestSchema.parse({
      url: 'https://apps.chatbridge.example/chess',
      height: 480,
    })

    expect(parsed.displayMode).toBe('inline')
  })

  it('keeps inline apps explicitly marked as inline', () => {
    const parsed = UIManifestSchema.parse({
      url: 'https://apps.chatbridge.example/weather',
      displayMode: 'inline',
    })

    expect(parsed.displayMode).toBe('inline')
  })

  it('accepts panel apps that should render in the center workspace column', () => {
    const parsed = UIManifestSchema.parse({
      url: 'https://apps.chatbridge.example/chess',
      width: 640,
      height: 640,
      displayMode: 'panel',
    })

    expect(parsed.displayMode).toBe('panel')
  })

  it('accepts wider panel apps that need a dedicated workspace column', () => {
    const parsed = UIManifestSchema.parse({
      url: 'https://apps.chatbridge.example/chess',
      width: 640,
      displayMode: 'panel',
    })

    expect(parsed.width).toBe(640)
  })
})

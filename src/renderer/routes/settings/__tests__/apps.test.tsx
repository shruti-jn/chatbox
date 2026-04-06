// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouteComponent } from '../apps'

type FetchResponseInit = {
  ok?: boolean
  status?: number
  json?: unknown
}

function mockResponse(init: FetchResponseInit) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.ok === false ? 'Request failed' : 'OK',
    json: async () => init.json ?? {},
  } satisfies Partial<Response>
}

function renderRoute() {
  return render(
    <MantineProvider>
      <RouteComponent />
    </MantineProvider>,
  )
}

describe('Developer portal apps route', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
    localStorage.clear()
    localStorage.setItem(
      'settings',
      JSON.stringify({
        developerPlatformApiHost: 'http://localhost:3101',
        developerPlatformAdminApiKey: 'test-admin-key',
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('loads plugins from the developer platform and renders their latest version status', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        json: {
          plugins: [
            {
              pluginId: 'chess-tutor',
              name: 'Chess Tutor',
              description: 'Teaches chess through guided play.',
              trustTier: 'reviewed',
              queueStatus: 'awaiting_review',
              latestVersion: {
                id: 'ver_1',
                version: '1.0.0',
                status: 'awaiting_review',
                hasArtifact: true,
              },
            },
          ],
        },
      }),
    )

    renderRoute()

    expect(screen.getByText(/loading developer portal/i)).toBeTruthy()

    expect(await screen.findByText('Chess Tutor')).toBeTruthy()
    expect(screen.getByText(/awaiting_review/i)).toBeTruthy()
    expect(screen.getByText(/teaches chess through guided play/i)).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3101/api/v1/admin/plugins',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-developer-platform-admin-key': 'test-admin-key',
        }),
      }),
    )
  })

  it('creates a plugin draft, version draft, uploads an artifact, and submits it for review', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ json: { plugins: [] } }))
      .mockResolvedValueOnce(
        mockResponse({
          status: 201,
          json: {
            pluginId: 'dictionary-kit',
            slug: 'dictionary-kit',
            name: 'Dictionary Kit',
            description: 'Dictionary tools for classrooms',
            trustTier: 'dev-only',
          },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          status: 201,
          json: {
            id: 'ver_1',
            pluginId: 'dictionary-kit',
            version: '1.0.0',
            status: 'uploaded',
            hasArtifact: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          status: 201,
          json: {
            fileName: 'plugin.zip',
            sizeBytes: 12,
            sha256: 'abc123',
          },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          json: {
            id: 'ver_1',
            pluginId: 'dictionary-kit',
            version: '1.0.0',
            status: 'awaiting_review',
            hasArtifact: true,
          },
        }),
      )

    renderRoute()

    await screen.findByText(/no submitted plugins yet/i)

    fireEvent.change(screen.getByLabelText(/plugin slug/i), { target: { value: 'dictionary-kit' } })
    fireEvent.change(screen.getByLabelText(/^plugin name$/i), { target: { value: 'Dictionary Kit' } })
    fireEvent.change(screen.getByLabelText(/plugin description/i), {
      target: { value: 'Dictionary tools for classrooms' },
    })
    fireEvent.click(screen.getByRole('button', { name: /create plugin draft/i }))

    expect(await screen.findByText(/plugin draft created/i)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(/^version$/i), { target: { value: '1.0.0' } })
    fireEvent.change(screen.getByLabelText(/manifest json/i), {
      target: {
        value: JSON.stringify({
          pluginId: 'dictionary-kit',
          name: 'Dictionary Kit',
          version: '1.0.0',
          description: 'Dictionary tools for classrooms',
          entrypoint: '/index.html',
          ageRating: '8+',
          collectsInput: false,
          inputFields: [],
          permissions: [],
          networkDomains: [],
          dataPolicyUrl: 'https://example.com/privacy',
          externalResources: [],
          sriHashes: [],
          tools: [
            {
              name: 'lookup_word',
              description: 'Lookup a word',
              inputSchema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
            },
          ],
        }, null, 2),
      },
    })
    fireEvent.click(screen.getByRole('button', { name: /create version draft/i }))

    expect(await screen.findByText(/version draft 1.0.0 created/i)).toBeTruthy()

    const file = new File(['zip-content'], 'plugin.zip', { type: 'application/zip' })
    const fileInput = screen.getByLabelText(/plugin bundle/i) as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: /upload artifact/i }))

    expect(await screen.findByText(/Artifact uploaded: plugin.zip./i)).toBeTruthy()
    expect(screen.getByText(/^artifact uploaded$/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /submit version for review/i }))

    expect(await screen.findByText(/submitted for review/i)).toBeTruthy()

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3101/api/v1/developer/plugins',
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:3101/api/v1/developer/plugins/dictionary-kit/versions',
      expect.objectContaining({
        method: 'POST',
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://localhost:3101/api/v1/developer/plugins/dictionary-kit/versions/ver_1/artifact',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(FormData),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      'http://localhost:3101/api/v1/developer/plugins/dictionary-kit/versions/ver_1/submit',
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })

  it('shows actionable validation feedback when the manifest JSON is invalid', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ json: { plugins: [] } }))

    renderRoute()

    await screen.findByText(/no submitted plugins yet/i)

    fireEvent.change(screen.getByLabelText(/manifest json/i), {
      target: { value: '{ invalid json' },
    })
    fireEvent.click(screen.getByRole('button', { name: /create version draft/i }))

    await waitFor(() => {
      expect(screen.getByText(/manifest json is invalid/i)).toBeTruthy()
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

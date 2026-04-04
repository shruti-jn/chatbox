import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock global fetch before importing the module
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Import after mocking
const { getWeather, _testHelpers } = await import('../src/services/weather.js')

function makeOWMResponse(overrides: Record<string, unknown> = {}) {
  return {
    main: { temp: 295.37, humidity: 55 },       // ~72F
    weather: [{ main: 'Clouds', description: 'partly cloudy', icon: '02d' }],
    wind: { speed: 3.5 },                         // m/s
    name: 'New York',
    ...overrides,
  }
}

function makeForecastResponse() {
  return {
    list: [
      { dt: Date.now() / 1000 + 86400 * 0, main: { temp_max: 297, temp_min: 289 }, weather: [{ main: 'Clouds' }] },
      { dt: Date.now() / 1000 + 86400 * 1, main: { temp_max: 299, temp_min: 291 }, weather: [{ main: 'Clear' }] },
      { dt: Date.now() / 1000 + 86400 * 2, main: { temp_max: 295, temp_min: 287 }, weather: [{ main: 'Rain' }] },
    ],
  }
}

function mockSuccessfulFetch() {
  mockFetch.mockImplementation(async (url: string) => {
    const urlStr = String(url)
    if (urlStr.includes('/forecast')) {
      return { ok: true, json: async () => makeForecastResponse() }
    }
    return { ok: true, json: async () => makeOWMResponse() }
  })
}

describe('Weather Service', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    _testHelpers.clearCache()
    // Set API key for tests
    process.env.OPENWEATHER_API_KEY = 'test-api-key-123'
  })

  afterEach(() => {
    delete process.env.OPENWEATHER_API_KEY
  })

  it('returns weather data for a valid location', async () => {
    mockSuccessfulFetch()

    const result = await getWeather('New York')

    expect(result).toMatchObject({
      temperature: expect.any(Number),
      conditions: expect.any(String),
      humidity: expect.any(Number),
      windSpeed: expect.any(Number),
      icon: expect.any(String),
      forecast: expect.any(Array),
    })
    expect(result.temperature).toBeGreaterThan(0)
    expect(mockFetch).toHaveBeenCalled()
  })

  it('returns cached data without making an API call on cache hit', async () => {
    mockSuccessfulFetch()

    // First call populates cache
    const first = await getWeather('Chicago')
    expect(mockFetch).toHaveBeenCalledTimes(2) // current + forecast

    mockFetch.mockReset()

    // Second call should use cache
    const second = await getWeather('Chicago')
    expect(mockFetch).not.toHaveBeenCalled()
    expect(second).toEqual(first)
  })

  it('expires cache after 10 minutes', async () => {
    mockSuccessfulFetch()

    await getWeather('Boston')
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Simulate cache expiry by manipulating the cache timestamp
    _testHelpers.expireCache('boston')

    mockFetch.mockReset()
    mockSuccessfulFetch()

    await getWeather('Boston')
    // Should make new API calls after cache expired
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('returns stale cached data when API fails and cache exists', async () => {
    mockSuccessfulFetch()

    // Populate cache
    const original = await getWeather('Denver')

    // Expire cache so it's stale but still present
    _testHelpers.expireCache('denver')

    // Now make API fail
    mockFetch.mockReset()
    mockFetch.mockRejectedValue(new Error('Network error'))

    const staleResult = await getWeather('Denver')
    expect(staleResult.temperature).toBe(original.temperature)
    expect(staleResult.stale).toBe(true)
    expect(staleResult.lastUpdated).toBeDefined()
  })

  it('returns fallback mock data when API fails and no cache exists', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    const result = await getWeather('Nowhere')
    expect(result.fallback).toBe(true)
    expect(result.error).toBe('Weather data unavailable')
    expect(result.temperature).toBeDefined()
  })

  it('returns fallback on API timeout', async () => {
    // Simulate a timeout by making fetch hang
    mockFetch.mockImplementation(() => new Promise((_, reject) => {
      setTimeout(() => reject(new Error('AbortError')), 5000)
    }))

    // The service uses a 3s AbortController timeout, so we mock AbortController behavior
    mockFetch.mockReset()
    mockFetch.mockImplementation(() => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      return Promise.reject(error)
    })

    const result = await getWeather('Timeout City')
    expect(result.fallback).toBe(true)
    expect(result.error).toBe('Weather data unavailable')
  })

  it('returns mock data with warning when no API key is set', async () => {
    delete process.env.OPENWEATHER_API_KEY

    const result = await getWeather('San Francisco')
    expect(result.fallback).toBe(true)
    expect(result.warning).toMatch(/API.?KEY/i)
    expect(result.temperature).toBeDefined()
  })
})

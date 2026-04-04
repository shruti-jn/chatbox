/**
 * Weather service — calls OpenWeatherMap API with caching and graceful fallback.
 *
 * - Uses OPENWEATHER_API_KEY env var; returns mock data with warning if unset
 * - 10-minute in-memory cache per location
 * - 3-second timeout on API calls
 * - Graceful fallback: stale cache on failure, or mock data if no cache
 */

const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const API_TIMEOUT_MS = 3000
const OWM_BASE = 'https://api.openweathermap.org/data/2.5'

export interface WeatherData {
  temperature: number   // Fahrenheit
  conditions: string
  humidity: number
  windSpeed: number     // mph
  icon: string
  forecast: Array<{ day: string; high: number; low: number; conditions: string }>
  location?: string
  stale?: boolean
  lastUpdated?: string
  fallback?: boolean
  error?: string
  warning?: string
}

interface CacheEntry {
  data: WeatherData
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

function kelvinToFahrenheit(k: number): number {
  return Math.round((k - 273.15) * 9 / 5 + 32)
}

function mpsToMph(mps: number): number {
  return Math.round(mps * 2.237 * 10) / 10
}

function cacheKey(location: string): string {
  return location.toLowerCase().trim()
}

function getDayName(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow'
  return date.toLocaleDateString('en-US', { weekday: 'long' })
}

function fallbackData(location: string, extraFields: Partial<WeatherData> = {}): WeatherData {
  return {
    temperature: 70,
    conditions: 'Unknown',
    humidity: 50,
    windSpeed: 5,
    icon: '01d',
    forecast: [
      { day: 'Today', high: 72, low: 58, conditions: 'Unknown' },
      { day: 'Tomorrow', high: 74, low: 60, conditions: 'Unknown' },
    ],
    location,
    fallback: true,
    error: 'Weather data unavailable',
    ...extraFields,
  }
}

export async function getWeather(location: string): Promise<WeatherData> {
  const key = cacheKey(location)
  const apiKey = process.env.OPENWEATHER_API_KEY

  // No API key -- return mock with warning
  if (!apiKey) {
    return fallbackData(location, {
      warning: 'No OPENWEATHER_API_KEY set. Returning mock data.',
    })
  }

  // Check cache (non-expired)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data
  }

  // Attempt API call
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

    const [currentRes, forecastRes] = await Promise.all([
      fetch(
        `${OWM_BASE}/weather?q=${encodeURIComponent(location)}&appid=${apiKey}`,
        { signal: controller.signal },
      ),
      fetch(
        `${OWM_BASE}/forecast?q=${encodeURIComponent(location)}&appid=${apiKey}&cnt=5`,
        { signal: controller.signal },
      ),
    ])

    clearTimeout(timeout)

    if (!currentRes.ok || !forecastRes.ok) {
      throw new Error(`API responded with status ${currentRes.status}/${forecastRes.status}`)
    }

    const current = await currentRes.json() as {
      main: { temp: number; humidity: number }
      weather: Array<{ main: string; description: string; icon: string }>
      wind: { speed: number }
      name: string
    }

    const forecastBody = await forecastRes.json() as {
      list: Array<{
        dt: number
        main: { temp_max: number; temp_min: number }
        weather: Array<{ main: string }>
      }>
    }

    const forecast = forecastBody.list.map(entry => ({
      day: getDayName(entry.dt),
      high: kelvinToFahrenheit(entry.main.temp_max),
      low: kelvinToFahrenheit(entry.main.temp_min),
      conditions: entry.weather[0]?.main ?? 'Unknown',
    }))

    const data: WeatherData = {
      temperature: kelvinToFahrenheit(current.main.temp),
      conditions: current.weather[0]?.description ?? 'Unknown',
      humidity: current.main.humidity,
      windSpeed: mpsToMph(current.wind.speed),
      icon: current.weather[0]?.icon ?? '01d',
      forecast,
      location: current.name,
    }

    // Update cache
    cache.set(key, { data, fetchedAt: Date.now() })

    return data
  } catch (_err: unknown) {
    // API failed -- try stale cache
    if (cached) {
      return {
        ...cached.data,
        stale: true,
        lastUpdated: new Date(cached.fetchedAt).toISOString(),
      }
    }

    // No cache at all -- return fallback
    return fallbackData(location)
  }
}

/**
 * Test helpers -- only used by the test suite.
 * Exported so tests can manipulate cache state.
 */
export const _testHelpers = {
  clearCache() {
    cache.clear()
  },
  expireCache(key: string) {
    const entry = cache.get(key)
    if (entry) {
      entry.fetchedAt = Date.now() - CACHE_TTL_MS - 1
    }
  },
}

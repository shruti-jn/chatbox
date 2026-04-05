const WEATHER_ICONS: Record<string, string> = {
  Clear: '☀️', Clouds: '☁️', Rain: '🌧️', Drizzle: '🌦️',
  Thunderstorm: '⛈️', Snow: '❄️', Mist: '🌫️', Fog: '🌫️',
  Haze: '🌫️', Smoke: '🌫️', Dust: '🌫️', default: '🌤️',
}

interface WeatherData {
  location: string
  temperature: number
  feelsLike: number
  conditions: string
  humidity: number
  windSpeed: number
  icon: string
  forecast: Array<{
    day: string
    high: number
    low: number
    conditions: string
    icon: string
  }>
}

class WeatherApp {
  private appEl: HTMLElement
  private instanceId: string | null = null

  constructor() {
    this.appEl = document.getElementById('app')!
    this.setupCBP()
  }

  private setupCBP() {
    window.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : JSON.stringify(event.data))
        if (msg.jsonrpc !== '2.0') return

        if (msg.method === 'command') {
          this.handleCommand(msg.params)
        }
      } catch {}
    })
  }

  private handleCommand(params: Record<string, unknown>) {
    if (params.command === 'set_instance_id') {
      this.instanceId = params.instance_id as string
    } else if (params.command === 'show_weather') {
      this.displayWeather(params as unknown as WeatherData)
    }
  }

  displayWeather(data: WeatherData) {
    const icon = WEATHER_ICONS[data.conditions] ?? WEATHER_ICONS.default

    this.appEl.innerHTML = `
      <div class="weather-card">
        <div class="location">${data.location}</div>
        <div class="current">
          <div class="weather-icon">${icon}</div>
          <div>
            <div class="temp">${Math.round(data.temperature)}°F</div>
            <div class="conditions">${data.conditions}</div>
          </div>
        </div>
        <div class="details">
          <div class="detail-item">
            <div class="detail-label">Feels Like</div>
            <div class="detail-value">${Math.round(data.feelsLike ?? data.temperature)}°F</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Humidity</div>
            <div class="detail-value">${data.humidity ?? '--'}%</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Wind</div>
            <div class="detail-value">${data.windSpeed ?? '--'} mph</div>
          </div>
        </div>
        ${data.forecast ? `
          <div class="forecast">
            ${data.forecast.map(day => `
              <div class="forecast-day">
                <div class="day">${day.day}</div>
                <div class="icon">${WEATHER_ICONS[day.conditions] ?? WEATHER_ICONS.default}</div>
                <div class="temps">${Math.round(day.high)}° / ${Math.round(day.low)}°</div>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `

    // Send state update to platform
    this.postCBP('state_update', {
      instance_id: this.instanceId ?? 'pending',
      state: {
        location: data.location,
        temperature: data.temperature,
        conditions: data.conditions,
        displayed: true,
      },
    })
  }

  private postCBP(method: string, params: Record<string, unknown>) {
    window.parent.postMessage(JSON.stringify({ jsonrpc: '2.0', method, params }), '*')
  }
}

// Initialize and expose for external data injection
const app = new WeatherApp()

// Also accept data via URL params (for development)
const urlParams = new URLSearchParams(window.location.search)
const location = urlParams.get('location')
if (location) {
  // Mock data for development
  app.displayWeather({
    location,
    temperature: 72,
    feelsLike: 70,
    conditions: 'Clear',
    humidity: 45,
    windSpeed: 8,
    icon: '☀️',
    forecast: [
      { day: 'Mon', high: 72, low: 58, conditions: 'Clear', icon: '☀️' },
      { day: 'Tue', high: 75, low: 60, conditions: 'Clouds', icon: '☁️' },
      { day: 'Wed', high: 68, low: 55, conditions: 'Rain', icon: '🌧️' },
      { day: 'Thu', high: 70, low: 56, conditions: 'Clear', icon: '☀️' },
      { day: 'Fri', high: 73, low: 59, conditions: 'Clouds', icon: '☁️' },
    ],
  })
}

export {}

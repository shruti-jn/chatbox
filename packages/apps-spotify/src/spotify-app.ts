interface Track {
  name: string
  artist: string
  duration?: string
  id: string
}

interface PlaylistData {
  name: string
  description: string
  tracks: Track[]
  spotifyUrl?: string
}

class SpotifyApp {
  private appEl: HTMLElement
  private instanceId: string | null = null
  private isAuthenticated = false

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
    } else if (params.command === 'show_auth_prompt') {
      this.showAuthPrompt()
    } else if (params.command === 'auth_success') {
      this.isAuthenticated = true
      this.showLoading('Creating your playlist...')
    } else if (params.command === 'show_playlist') {
      this.displayPlaylist(params as unknown as PlaylistData)
    } else if (params.command === 'show_error') {
      this.showError(params.message as string)
    }
  }

  showAuthPrompt() {
    this.appEl.innerHTML = `
      <div class="spotify-card">
        <div class="auth-prompt">
          <div style="font-size: 48px; margin-bottom: 16px;">🎵</div>
          <h2 style="margin-bottom: 8px;">Connect to Spotify</h2>
          <p>To create playlists, I need to connect to your Spotify account.</p>
          <button class="connect-btn" id="connect-btn">Connect Spotify</button>
        </div>
      </div>
    `

    document.getElementById('connect-btn')?.addEventListener('click', () => {
      this.postCBP('state_update', {
        instance_id: this.instanceId ?? 'pending',
        state: { action: 'request_auth', provider: 'spotify' },
      })
    })
  }

  displayPlaylist(data: PlaylistData) {
    this.appEl.innerHTML = `
      <div class="spotify-card">
        <div class="header">
          <span class="spotify-logo">🎵</span>
          <div>
            <div class="playlist-name">${data.name}</div>
            <div class="playlist-desc">${data.description} • ${data.tracks.length} tracks</div>
          </div>
        </div>
        <ul class="track-list">
          ${data.tracks.map((track, i) => `
            <li class="track">
              <span class="track-num">${i + 1}</span>
              <div class="track-info">
                <div class="track-name">${track.name}</div>
                <div class="track-artist">${track.artist}</div>
              </div>
              ${track.duration ? `<span class="track-duration">${track.duration}</span>` : ''}
            </li>
          `).join('')}
        </ul>
        ${data.spotifyUrl ? `<a href="${data.spotifyUrl}" target="_blank" class="open-spotify">Open in Spotify</a>` : ''}
      </div>
    `

    this.postCBP('state_update', {
      instance_id: this.instanceId ?? 'pending',
      state: {
        playlistName: data.name,
        trackCount: data.tracks.length,
        completed: true,
      },
    })
  }

  private showLoading(message: string) {
    this.appEl.innerHTML = `<div class="loading">${message}</div>`
  }

  private showError(message: string) {
    this.appEl.innerHTML = `<div class="spotify-card"><div class="auth-prompt"><p style="color: #E11D48;">${message}</p></div></div>`
  }

  private postCBP(method: string, params: Record<string, unknown>) {
    window.parent.postMessage(JSON.stringify({ jsonrpc: '2.0', method, params }), '*')
  }
}

// Initialize
const app = new SpotifyApp()

// Dev mode: show mock playlist
const urlParams = new URLSearchParams(window.location.search)
if (urlParams.get('mock') === 'playlist') {
  app.displayPlaylist({
    name: 'Chill Study Vibes',
    description: 'Lo-fi beats for focused studying',
    tracks: [
      { name: 'Sunset Dreams', artist: 'ChillHop', id: '1', duration: '3:24' },
      { name: 'Rainy Day Café', artist: 'Lo-Fi Girl', id: '2', duration: '4:12' },
      { name: 'Midnight Study', artist: 'Ambient Focus', id: '3', duration: '5:01' },
      { name: 'Campus Walk', artist: 'Study Beats', id: '4', duration: '3:45' },
      { name: 'Library Quiet', artist: 'Brain Food', id: '5', duration: '4:33' },
    ],
    spotifyUrl: 'https://open.spotify.com/playlist/example',
  })
} else if (urlParams.get('mock') === 'auth') {
  app.showAuthPrompt()
}

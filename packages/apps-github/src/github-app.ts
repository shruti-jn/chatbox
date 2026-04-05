interface Repository {
  name: string
  description: string | null
  url: string
  language: string | null
  stargazers_count: number
  updated_at: string
}

interface Activity {
  type: string
  actor: { login: string }
  repo: { name: string }
  payload: Record<string, unknown>
  created_at: string
}

interface GitHubData {
  username: string
  avatar_url: string
  repos: Repository[]
  activity: Activity[]
}

class GitHubApp {
  private appEl: HTMLElement
  private instanceId: string | null = null
  private isAuthenticated = false
  private username: string | null = null

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
      this.showLoading('Loading your GitHub activity...')
    } else if (params.command === 'show_github_data') {
      this.displayGitHubData(params as unknown as GitHubData)
    } else if (params.command === 'show_error') {
      this.showError(params.message as string)
    }
  }

  private showAuthPrompt() {
    this.appEl.innerHTML = `
      <div class="github-card">
        <div class="auth-prompt">
          <div style="font-size: 48px; margin-bottom: 16px;">🐙</div>
          <h2 style="margin-bottom: 8px; color: #f0f6fc;">Connect to GitHub</h2>
          <p>To see your repositories and recent activity, I need to connect to your GitHub account.</p>
          <button class="connect-btn" id="connect-btn">Connect GitHub</button>
        </div>
      </div>
    `

    document.getElementById('connect-btn')?.addEventListener('click', () => {
      this.postCBP('state_update', {
        instance_id: this.instanceId ?? 'pending',
        state: { action: 'request_auth', provider: 'github' },
      })
    })
  }

  private displayGitHubData(data: GitHubData) {
    this.username = data.username

    const reposHTML = data.repos.length > 0
      ? data.repos.map(repo => `
        <li class="repo-item">
          <div class="repo-name" onclick="window.open('${repo.url}', '_blank')">${repo.name}</div>
          ${repo.description ? `<div class="repo-desc">${this.escapeHtml(repo.description)}</div>` : ''}
          <div class="repo-meta">
            ${repo.language ? `<div class="language-badge"><div class="language-dot"></div>${repo.language}</div>` : ''}
            <div class="stars">⭐ ${repo.stargazers_count}</div>
          </div>
        </li>
      `).join('')
      : '<div class="empty-state">No repositories found</div>'

    const activityHTML = data.activity.length > 0
      ? data.activity.map(evt => {
        const time = this.getRelativeTime(evt.created_at)
        let description = ''
        if (evt.type === 'PushEvent') {
          const payload = evt.payload as any
          description = `Pushed ${payload.size || 1} commit(s) to ${evt.repo.name}`
        } else if (evt.type === 'PullRequestEvent') {
          const payload = evt.payload as any
          description = `${payload.action === 'opened' ? 'Opened' : payload.action === 'closed' ? 'Closed' : 'Updated'} PR in ${evt.repo.name}`
        } else if (evt.type === 'IssuesEvent') {
          const payload = evt.payload as any
          description = `${payload.action === 'opened' ? 'Opened' : payload.action === 'closed' ? 'Closed' : 'Updated'} issue in ${evt.repo.name}`
        } else if (evt.type === 'CreateEvent') {
          const payload = evt.payload as any
          description = `Created ${payload.ref_type || 'repository'} in ${evt.repo.name}`
        } else if (evt.type === 'DeleteEvent') {
          const payload = evt.payload as any
          description = `Deleted ${payload.ref_type || 'item'} from ${evt.repo.name}`
        } else if (evt.type === 'WatchEvent') {
          description = `Starred ${evt.repo.name}`
        } else if (evt.type === 'ForkEvent') {
          description = `Forked ${evt.repo.name}`
        } else {
          description = `${evt.type} in ${evt.repo.name}`
        }
        return `
        <li class="activity-item">
          <div class="activity-type">${evt.type.replace('Event', '')}</div>
          <div class="activity-desc">${this.escapeHtml(description)}</div>
          <div class="activity-time">${time}</div>
        </li>
      `
      }).join('')
      : '<div class="empty-state">No recent activity</div>'

    this.appEl.innerHTML = `
      <div class="github-card">
        <div class="header">
          <div class="github-logo">🐙</div>
          <div class="header-info">
            <h2>${this.escapeHtml(data.username)}</h2>
            <div class="username">@${this.escapeHtml(data.username)}</div>
          </div>
        </div>

        <div class="section-title">Your Repositories</div>
        <ul class="repos-list">
          ${reposHTML}
        </ul>

        <div class="section-title">Recent Activity</div>
        <ul class="activity-list">
          ${activityHTML}
        </ul>

        <a href="https://github.com/${this.escapeHtml(data.username)}" target="_blank" class="view-on-github">
          View on GitHub
        </a>
      </div>
    `

    this.postCBP('state_update', {
      instance_id: this.instanceId ?? 'pending',
      state: {
        username: data.username,
        repoCount: data.repos.length,
        activityCount: data.activity.length,
        authenticated: true,
        completed: true,
      },
    })
  }

  private showLoading(message: string) {
    this.appEl.innerHTML = `<div class="loading">${message}</div>`
  }

  private showError(message: string) {
    this.appEl.innerHTML = `<div class="github-card"><div class="error"><p>🐙 Error</p><p>${this.escapeHtml(message)}</p></div></div>`
  }

  private postCBP(method: string, params: Record<string, unknown>) {
    window.parent.postMessage(JSON.stringify({ jsonrpc: '2.0', method, params }), '*')
  }

  private getRelativeTime(dateString: string): string {
    const date = new Date(dateString)
    const now = new Date()
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)

    if (seconds < 60) return 'just now'
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
    if (seconds < 2592000) return `${Math.floor(seconds / 604800)}w ago`
    return `${Math.floor(seconds / 2592000)}mo ago`
  }

  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    }
    return text.replace(/[&<>"']/g, m => map[m])
  }
}

// Initialize
const app = new GitHubApp()

// Dev mode: show mock data
const urlParams = new URLSearchParams(window.location.search)
if (urlParams.get('mock') === 'repos') {
  app.constructor.prototype.displayGitHubData.call(app, {
    username: 'octocat',
    avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
    repos: [
      {
        name: 'Hello-World',
        description: 'My first repository on GitHub!',
        url: 'https://github.com/octocat/Hello-World',
        language: 'JavaScript',
        stargazers_count: 80,
        updated_at: new Date(Date.now() - 86400000).toISOString(),
      },
      {
        name: 'Spoon-Knife',
        description: 'This your first repo!',
        url: 'https://github.com/octocat/Spoon-Knife',
        language: 'HTML',
        stargazers_count: 1726,
        updated_at: new Date(Date.now() - 259200000).toISOString(),
      },
    ],
    activity: [
      {
        type: 'PushEvent',
        actor: { login: 'octocat' },
        repo: { name: 'octocat/Hello-World' },
        payload: { size: 2 },
        created_at: new Date(Date.now() - 3600000).toISOString(),
      },
      {
        type: 'PullRequestEvent',
        actor: { login: 'octocat' },
        repo: { name: 'octocat/Spoon-Knife' },
        payload: { action: 'opened' },
        created_at: new Date(Date.now() - 86400000).toISOString(),
      },
    ],
  })
} else if (urlParams.get('mock') === 'auth') {
  app.constructor.prototype.showAuthPrompt.call(app)
}

export {}

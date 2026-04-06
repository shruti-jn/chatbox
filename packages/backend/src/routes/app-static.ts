/**
 * Static file serving for built app bundles
 * Serves chess, weather, spotify app UIs from their dist/ directories
 */

import type { FastifyInstance } from 'fastify'
import path from 'path'
import fs from 'fs'

const DEFAULT_APPS_BASE = path.resolve(process.cwd(), '../../packages')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

function getAllowedFrameAncestors() {
  const configuredOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => /^https?:\/\//.test(origin))

  return [`'self'`, ...new Set(configuredOrigins)].join(' ')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applySecurityHeaders(reply: any, ext: string) {
  reply.header('X-Content-Type-Options', 'nosniff')

  if (ext === '.html' || ext === '') {
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors ${getAllowedFrameAncestors()}`,
    )
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  } else if (ext === '.js') {
    reply.header('Content-Security-Policy', "script-src 'self'")
    reply.header('Cross-Origin-Resource-Policy', 'same-origin')
  } else {
    reply.header('Cross-Origin-Resource-Policy', 'same-origin')
  }
}

export async function appStaticRoutes(server: FastifyInstance, opts: { appsBase?: string } = {}) {
  const appsBase = opts.appsBase ?? DEFAULT_APPS_BASE
  const allowedApps = ['chess', 'weather', 'spotify']

  // Serve app static files: /apps/:appName/ui/*
  server.get('/apps/:appName/ui/*', async (request, reply) => {
    const { appName } = request.params as { appName: string }
    const filePath = (request.params as Record<string, string>)['*'] || 'index.html'

    if (!allowedApps.includes(appName)) {
      return reply.status(404).send({ error: 'App not found' })
    }

    const distDir = path.resolve(appsBase, `apps-${appName}`, 'dist')
    const fullPath = path.resolve(distDir, filePath)

    // Prevent directory traversal
    if (!fullPath.startsWith(distDir)) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    if (!fs.existsSync(fullPath)) {
      // Fallback to index.html for SPA routing
      const indexPath = path.join(distDir, 'index.html')
      if (fs.existsSync(indexPath)) {
        applySecurityHeaders(reply, '.html')
        return reply.type('text/html').send(fs.readFileSync(indexPath))
      }
      return reply.status(404).send({ error: 'File not found' })
    }

    const ext = path.extname(fullPath)
    const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream'
    applySecurityHeaders(reply, ext)
    return reply.type(contentType).send(fs.readFileSync(fullPath))
  })

  // Serve index.html at /apps/:appName/ui
  server.get('/apps/:appName/ui', async (request, reply) => {
    const { appName } = request.params as { appName: string }

    if (!allowedApps.includes(appName)) {
      return reply.status(404).send({ error: 'App not found' })
    }

    const indexPath = path.join(appsBase, `apps-${appName}`, 'dist', 'index.html')
    if (fs.existsSync(indexPath)) {
      applySecurityHeaders(reply, '.html')
      return reply.type('text/html').send(fs.readFileSync(indexPath))
    }
    return reply.status(404).send({ error: 'App not built. Run: cd packages/apps-' + appName + ' && pnpm run build' })
  })
}

/**
 * Static file serving for built app bundles
 * Serves chess, weather, spotify app UIs from their dist/ directories
 */

import type { FastifyInstance } from 'fastify'
import path from 'path'
import fs from 'fs'

const APPS_BASE = path.resolve(process.cwd(), '../../packages')

export async function appStaticRoutes(server: FastifyInstance) {
  // Serve app static files: /apps/:appName/ui/*
  server.get('/apps/:appName/ui/*', async (request, reply) => {
    const { appName } = request.params as { appName: string }
    const filePath = (request.params as Record<string, string>)['*'] || 'index.html'

    // Whitelist allowed apps
    const allowedApps = ['chess', 'weather', 'spotify']
    if (!allowedApps.includes(appName)) {
      return reply.status(404).send({ error: 'App not found' })
    }

    const distDir = path.join(APPS_BASE, `apps-${appName}`, 'dist')
    const fullPath = path.join(distDir, filePath)

    // Prevent directory traversal
    if (!fullPath.startsWith(distDir)) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    // Check file exists
    if (!fs.existsSync(fullPath)) {
      // Fallback to index.html for SPA routing
      const indexPath = path.join(distDir, 'index.html')
      if (fs.existsSync(indexPath)) {
        return reply.type('text/html').send(fs.readFileSync(indexPath))
      }
      return reply.status(404).send({ error: 'File not found' })
    }

    // Determine content type
    const ext = path.extname(fullPath)
    const contentTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    }

    const contentType = contentTypes[ext] ?? 'application/octet-stream'
    return reply.type(contentType).send(fs.readFileSync(fullPath))
  })

  // Also serve at root /apps/:appName/ui for index.html
  server.get('/apps/:appName/ui', async (request, reply) => {
    const { appName } = request.params as { appName: string }
    const allowedApps = ['chess', 'weather', 'spotify']
    if (!allowedApps.includes(appName)) {
      return reply.status(404).send({ error: 'App not found' })
    }

    const indexPath = path.join(APPS_BASE, `apps-${appName}`, 'dist', 'index.html')
    if (fs.existsSync(indexPath)) {
      return reply.type('text/html').send(fs.readFileSync(indexPath))
    }
    return reply.status(404).send({ error: 'App not built. Run: cd packages/apps-' + appName + ' && pnpm run build' })
  })
}

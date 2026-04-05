import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appStaticRoutes } from '../src/routes/app-static.js'

describe('app static hosting policy', () => {
  let server: FastifyInstance
  let tempDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'app-static-'))

    const chessDist = path.join(tempDir, 'apps-chess', 'dist')
    await mkdir(path.join(chessDist, 'assets'), { recursive: true })
    await writeFile(path.join(chessDist, 'index.html'), '<!doctype html><html><body>chess</body></html>', 'utf8')
    await writeFile(path.join(chessDist, 'assets', 'app.js'), 'console.log("chess")', 'utf8')

    server = Fastify()
    await server.register(appStaticRoutes, { prefix: '/api/v1', appsBase: tempDir })
    await server.ready()
  })

  afterAll(async () => {
    await server.close()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('applies platform-controlled security headers to hosted HTML responses', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/apps/chess/ui',
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-security-policy']).toContain("default-src 'self'")
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'self'")
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()')
  })

  it('applies the same hosting policy to static asset responses', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/apps/chess/ui/assets/app.js',
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/javascript')
    expect(response.headers['content-security-policy']).toContain("script-src 'self'")
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin')
  })

  it('blocks unknown hosted apps', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/apps/unknown/ui',
    })

    expect(response.statusCode).toBe(404)
  })

  it('does not serve traversal attempts outside the hosted dist directory', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/apps/chess/ui/%2e%2e/%2e%2e/%2e%2e/package.json',
    })

    expect(response.statusCode).not.toBe(200)
  })
})

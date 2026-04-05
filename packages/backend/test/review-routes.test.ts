import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma } from '../src/middleware/rls.js'

describe('Review Routes', () => {
  let server: FastifyInstance
  let districtId: string
  let teacherToken: string

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()

    const district = await ownerPrisma.district.create({ data: { name: 'Review Route District' } })
    districtId = district.id

    const teacher = await ownerPrisma.user.create({
      data: { districtId, role: 'teacher', displayName: 'Review Teacher' },
    })

    teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId })
  })

  afterAll(async () => {
    try {
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM apps WHERE name LIKE 'Review %'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM users WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = '${districtId}'`)
    } catch {}
    await server.close()
  })

  it('clean app passes all 5 stages and review result is stored', async () => {
    const registerRes = await server.inject({
      method: 'POST',
      url: '/api/v1/apps/register',
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: {
        name: `Review Clean ${Date.now()}`,
        description: 'Clean app for review route coverage',
        toolDefinitions: [
          { name: 'start', description: 'Start action', inputSchema: { type: 'object' } },
        ],
        uiManifest: { url: 'https://clean.chatbridge.app', width: 400, height: 300 },
        permissions: { network: false },
        complianceMetadata: {},
        version: '1.0.0',
      },
    })

    expect(registerRes.statusCode).toBe(201)
    const { appId } = JSON.parse(registerRes.body)

    const reviewRes = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/submit-review`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })

    expect(reviewRes.statusCode).toBe(202)
    const reviewBody = JSON.parse(reviewRes.body)
    expect(reviewBody.status).toBe('approved')
    expect(reviewBody.reviewResults.stages).toHaveLength(5)
    expect(reviewBody.reviewResults.stages.every((s: any) => s.status === 'pass')).toBe(true)

    const getRes = await server.inject({
      method: 'GET',
      url: `/api/v1/apps/${appId}/review-results`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })

    expect(getRes.statusCode).toBe(200)
    const getBody = JSON.parse(getRes.body)
    expect(getBody.reviewStatus).toBe('approved')
    expect(getBody.reviewResults.stages).toHaveLength(5)
  })

  it('external script in localhost UI HTML fails security scan and blocks approval', async () => {
    const htmlServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body><script src="https://evil.com/steal.js"></script></body></html>')
    })
    await new Promise<void>((resolve) => htmlServer.listen(0, '127.0.0.1', () => resolve()))
    const port = (htmlServer.address() as AddressInfo).port

    const registerRes = await server.inject({
      method: 'POST',
      url: '/api/v1/apps/register',
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: {
        name: `Review Evil ${Date.now()}`,
        description: 'App with unsafe script',
        toolDefinitions: [
          { name: 'start', description: 'Start action', inputSchema: { type: 'object' } },
        ],
        uiManifest: { url: `http://127.0.0.1:${port}/index.html`, width: 400, height: 300 },
        permissions: { network: true },
        complianceMetadata: {},
        version: '1.0.0',
      },
    })

    const { appId } = JSON.parse(registerRes.body)
    const reviewRes = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/submit-review`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })

    htmlServer.close()

    expect(reviewRes.statusCode).toBe(202)
    const body = JSON.parse(reviewRes.body)
    expect(body.status).toBe('rejected')
    const securityStage = body.reviewResults.stages.find((s: any) => s.stage === 'security_scan')
    expect(securityStage.status).toBe('fail')
  })

  it('single a11y failure blocks approval while the other stages pass', async () => {
    const htmlServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body><img src="/hero.png"></body></html>')
    })
    await new Promise<void>((resolve) => htmlServer.listen(0, '127.0.0.1', () => resolve()))
    const port = (htmlServer.address() as AddressInfo).port

    const registerRes = await server.inject({
      method: 'POST',
      url: '/api/v1/apps/register',
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: {
        name: `Review A11y ${Date.now()}`,
        description: 'App with a single accessibility issue',
        toolDefinitions: [
          { name: 'start', description: 'Start action', inputSchema: { type: 'object' } },
        ],
        uiManifest: { url: `http://127.0.0.1:${port}/index.html`, width: 400, height: 300 },
        permissions: { network: false },
        complianceMetadata: {},
        version: '1.0.0',
      },
    })

    const { appId } = JSON.parse(registerRes.body)
    const reviewRes = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/submit-review`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })

    htmlServer.close()

    expect(reviewRes.statusCode).toBe(202)
    const body = JSON.parse(reviewRes.body)
    expect(body.status).toBe('rejected')
    const stages = body.reviewResults.stages
    expect(stages).toHaveLength(5)
    expect(stages.find((s: any) => s.stage === 'accessibility').status).toBe('fail')
    expect(stages.find((s: any) => s.stage === 'schema_validation').status).toBe('pass')
    expect(stages.find((s: any) => s.stage === 'security_scan').status).toBe('pass')
    expect(stages.find((s: any) => s.stage === 'content_check').status).toBe('pass')
    expect(stages.find((s: any) => s.stage === 'performance').status).toBe('pass')
  })
})

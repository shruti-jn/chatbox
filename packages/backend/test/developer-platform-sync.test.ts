import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma } from '../src/middleware/rls.js'

type RegistryState = {
  apps: Array<{
    pluginId: string
    name: string
    version: string
    trustTier: string
    status: 'approved' | 'suspended'
    enabled: boolean
    ageRating: string
    hostedUrl: string
    permissions: string[]
    networkDomains: string[]
    collectsInput: boolean
    inputFields: Array<Record<string, unknown>>
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  }>
}

describe('Developer platform registry sync', () => {
  let server: FastifyInstance
  let registryServer: http.Server
  let registryState: RegistryState
  let districtId: string
  let teacherId: string
  let teacherToken: string
  let classroomId: string
  let joinCode: string
  let syncedAppId: string

  beforeAll(async () => {
    registryState = {
      apps: [
        {
          pluginId: 'weather-lab',
          name: 'Weather Lab',
          version: '1.0.0',
          trustTier: 'reviewed',
          status: 'approved',
          enabled: true,
          ageRating: '8+',
          hostedUrl: 'https://plugins.chatbridge.app/weather-lab/v1.0.0/',
          permissions: ['weather.read'],
          networkDomains: ['api.weather.example'],
          collectsInput: true,
          inputFields: [{ name: 'query', required: true, kind: 'text' }],
          tools: [
            {
              name: 'lookup_weather',
              description: 'Lookup weather data',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            },
          ],
        },
      ],
    }

    registryServer = http.createServer((request, response) => {
      if (request.url?.startsWith('/api/v1/registry/apps')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(registryState))
        return
      }

      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not_found' }))
    })

    await new Promise<void>((resolve) => {
      registryServer.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (registryServer.address() as AddressInfo).port
    process.env.DEVELOPER_PLATFORM_API_HOST = `http://127.0.0.1:${port}`

    server = await buildServer()
    await server.ready()

    const district = await ownerPrisma.district.create({ data: { name: 'DP Sync District' } })
    districtId = district.id

    const teacher = await ownerPrisma.user.create({
      data: { districtId, role: 'teacher', displayName: 'DP Sync Teacher' },
    })
    teacherId = teacher.id
    teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId })

    const classroom = await ownerPrisma.classroom.create({
      data: {
        districtId,
        teacherId,
        name: 'DP Sync Classroom',
        joinCode: 'DPREG001',
        gradeBand: 'g68',
        aiConfig: { mode: 'socratic' },
      },
    })
    classroomId = classroom.id
    joinCode = classroom.joinCode
  })

  afterAll(async () => {
    try {
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM classroom_app_configs WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM district_app_catalog WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM classrooms WHERE id = '${classroomId}'`)
      await ownerPrisma.app.deleteMany({ where: { developerId: 'developer-platform:weather-lab' } })
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM users WHERE id = '${teacherId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = '${districtId}'`)
    } catch {
      // best effort cleanup
    }

    delete process.env.DEVELOPER_PLATFORM_API_HOST
    await server.close()
    await new Promise<void>((resolve, reject) => {
      registryServer.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('imports published registry apps into teacher app listing and tool manifest', async () => {
    const appsResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/classrooms/${classroomId}/apps`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })

    expect(appsResponse.statusCode).toBe(200)
    const apps = JSON.parse(appsResponse.body) as Array<{ id: string; name: string; enabled: boolean }>
    const persistedApps = await ownerPrisma.app.findMany({
      where: { developerId: 'developer-platform:weather-lab' },
      select: { id: true, name: true, developerId: true },
    })
    const persistedCatalog = await ownerPrisma.districtAppCatalog.findMany({
      where: { districtId },
      select: { appId: true, status: true },
    })
    expect(persistedApps.length).toBeGreaterThan(0)
    expect(persistedCatalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'approved' }),
      ]),
    )
    const weatherLab = apps.find((app) => app.name === 'Weather Lab')
    syncedAppId = weatherLab?.id ?? ''
    expect(apps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Weather Lab',
          enabled: true,
        }),
      ]),
    )

    const manifestResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/classrooms/by-join-code/${joinCode}/tool-manifest`,
    })

    expect(manifestResponse.statusCode).toBe(200)
    const manifest = JSON.parse(manifestResponse.body) as {
      tools: Array<{ appId: string; appName: string; toolName: string }>
    }
    expect(manifest.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appId: syncedAppId,
          appName: 'Weather Lab',
          toolName: 'lookup_weather',
        }),
      ]),
    )
  })

  it('lets the teacher disable the synced app and removes it from the student manifest', async () => {
    const toggleResponse = await server.inject({
      method: 'PATCH',
      url: `/api/v1/classrooms/${classroomId}/apps/${syncedAppId}`,
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { enabled: false },
    })

    expect(toggleResponse.statusCode).toBe(200)

    const manifestResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/classrooms/by-join-code/${joinCode}/tool-manifest`,
    })

    expect(manifestResponse.statusCode).toBe(200)
    const manifest = JSON.parse(manifestResponse.body) as {
      tools: Array<{ appId: string }>
    }
    expect(manifest.tools.every((tool) => tool.appId !== syncedAppId)).toBe(true)
  })

  it('removes suspended apps from teacher view after the next sync', async () => {
    await ownerPrisma.classroomAppConfig.deleteMany({
      where: {
        classroomId,
        appId: syncedAppId,
      },
    })

    registryState.apps = [
      {
        ...registryState.apps[0],
        status: 'suspended',
      },
    ]

    const appsResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/classrooms/${classroomId}/apps`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })

    expect(appsResponse.statusCode).toBe(200)
    const apps = JSON.parse(appsResponse.body) as Array<{ id: string }>
    expect(apps.every((app) => app.id !== syncedAppId)).toBe(true)

    const catalogEntry = await ownerPrisma.districtAppCatalog.findUnique({
      where: {
        districtId_appId: {
          districtId,
          appId: syncedAppId,
        },
      },
    })
    expect(catalogEntry?.status).toBe('suspended')
  })

  it('suspends previously imported apps that disappear from the registry feed', async () => {
    registryState.apps = [
      {
        pluginId: 'ephemeral-lab',
        name: 'Ephemeral Lab',
        version: '1.0.0',
        trustTier: 'reviewed',
        status: 'approved',
        enabled: true,
        ageRating: '8+',
        hostedUrl: 'https://plugins.chatbridge.app/ephemeral-lab/v1.0.0/',
        permissions: ['weather.read'],
        networkDomains: ['api.weather.example'],
        collectsInput: true,
        inputFields: [{ name: 'query', required: true, kind: 'text' }],
        tools: [
          {
            name: 'lookup_weather',
            description: 'Lookup weather data',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      },
    ]

    const firstSync = await server.inject({
      method: 'GET',
      url: `/api/v1/classrooms/${classroomId}/apps`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(firstSync.statusCode).toBe(200)

    const importedApp = await ownerPrisma.app.findFirstOrThrow({
      where: { developerId: 'developer-platform:ephemeral-lab' },
      select: { id: true },
    })

    await ownerPrisma.classroomAppConfig.upsert({
      where: {
        classroomId_appId: {
          classroomId,
          appId: importedApp.id,
        },
      },
      update: { enabled: true },
      create: {
        classroomId,
        districtId,
        appId: importedApp.id,
        enabled: true,
      },
    })

    registryState.apps = []

    const secondSync = await server.inject({
      method: 'GET',
      url: `/api/v1/classrooms/${classroomId}/apps`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(secondSync.statusCode).toBe(200)
    const apps = JSON.parse(secondSync.body) as Array<{ id: string }>
    expect(apps.every((app) => app.id !== importedApp.id)).toBe(true)

    const catalogEntry = await ownerPrisma.districtAppCatalog.findUniqueOrThrow({
      where: {
        districtId_appId: {
          districtId,
          appId: importedApp.id,
        },
      },
      select: { status: true, rejectionReason: true },
    })

    const classroomConfig = await ownerPrisma.classroomAppConfig.findUniqueOrThrow({
      where: {
        classroomId_appId: {
          classroomId,
          appId: importedApp.id,
        },
      },
      select: { enabled: true },
    })

    const appRecord = await ownerPrisma.app.findUniqueOrThrow({
      where: { id: importedApp.id },
      select: { reviewStatus: true },
    })

    expect(catalogEntry.status).toBe('suspended')
    expect(catalogEntry.rejectionReason).toContain('Removed from developer platform registry')
    expect(classroomConfig.enabled).toBe(false)
    expect(appRecord.reviewStatus).toBe('suspended')

    await ownerPrisma.classroomAppConfig.deleteMany({
      where: {
        districtId,
        appId: importedApp.id,
      },
    })
    await ownerPrisma.districtAppCatalog.deleteMany({
      where: {
        districtId,
        appId: importedApp.id,
      },
    })
    await ownerPrisma.app.deleteMany({ where: { developerId: 'developer-platform:ephemeral-lab' } })
  })
})

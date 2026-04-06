import type { FastifyBaseLogger } from 'fastify'
import { ownerPrisma } from '../middleware/rls.js'

type RegistryTool = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

type RegistryApp = {
  pluginId: string
  name: string
  version: string
  trustTier: string
  status: 'approved' | 'suspended' | 'rejected' | 'pending_review'
  enabled: boolean
  ageRating: string
  hostedUrl: string
  permissions: string[]
  networkDomains: string[]
  collectsInput: boolean
  inputFields: Array<Record<string, unknown>>
  tools: RegistryTool[]
}

type RegistryAppsResponse = {
  apps: RegistryApp[]
}

const DEFAULT_API_HOST = 'https://developer-platform-production.up.railway.app'

function getDeveloperPlatformApiHost(): string | null {
  const value = process.env.DEVELOPER_PLATFORM_API_HOST?.trim()
  if (value === '') return null
  if ((process.env.NODE_ENV ?? 'development') === 'test' && !value) return null
  return value ?? DEFAULT_API_HOST
}

function registryMarker(pluginId: string) {
  return `developer-platform:${pluginId}`
}

function isDeveloperPlatformMarker(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith('developer-platform:')
}

function buildDescription(app: RegistryApp) {
  return `Published via developer platform (${app.pluginId})`
}

function mapToolDefinitions(app: RegistryApp) {
  return app.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object' },
  }))
}

function mapUiManifest(app: RegistryApp) {
  return {
    url: app.hostedUrl,
    width: 500,
    height: 400,
    displayMode: 'inline',
    sandboxAttrs: ['allow-scripts'],
  }
}

export async function syncDeveloperPlatformAppsForDistrict(input: {
  districtId: string
  logger?: FastifyBaseLogger
}) {
  const apiHost = getDeveloperPlatformApiHost()
  if (!apiHost) return { synced: false, reason: 'disabled' as const }

  try {
    const response = await fetch(`${apiHost.replace(/\/$/, '')}/api/v1/registry/apps?includeSuspended=true`)
    if (!response.ok) {
      input.logger?.warn({ statusCode: response.status }, 'developer-platform registry sync skipped: non-200 response')
      return { synced: false, reason: 'unavailable' as const }
    }

    const data = await response.json() as RegistryAppsResponse
    const registryApps = Array.isArray(data.apps) ? data.apps : []
    const liveMarkers = new Set(registryApps.map((app) => registryMarker(app.pluginId)))

    for (const app of registryApps) {
      const marker = registryMarker(app.pluginId)
      const existingApps = await ownerPrisma.app.findMany({
        where: { developerId: marker },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      })
      const [primaryApp, ...duplicateApps] = existingApps

      if (duplicateApps.length > 0 && primaryApp) {
        for (const duplicate of duplicateApps) {
          const existingCatalog = await ownerPrisma.districtAppCatalog.findUnique({
            where: {
              districtId_appId: {
                districtId: input.districtId,
                appId: primaryApp.id,
              },
            },
            select: { id: true },
          })

          if (!existingCatalog) {
            await ownerPrisma.districtAppCatalog.updateMany({
              where: {
                districtId: input.districtId,
                appId: duplicate.id,
              },
              data: {
                appId: primaryApp.id,
              },
            })
          } else {
            await ownerPrisma.districtAppCatalog.deleteMany({
              where: {
                districtId: input.districtId,
                appId: duplicate.id,
              },
            })
          }

          const existingClassroomConfig = await ownerPrisma.classroomAppConfig.findFirst({
            where: {
              districtId: input.districtId,
              appId: primaryApp.id,
            },
            select: { id: true },
          })

          if (!existingClassroomConfig) {
            await ownerPrisma.classroomAppConfig.updateMany({
              where: {
                districtId: input.districtId,
                appId: duplicate.id,
              },
              data: {
                appId: primaryApp.id,
              },
            })
          } else {
            await ownerPrisma.classroomAppConfig.deleteMany({
              where: {
                districtId: input.districtId,
                appId: duplicate.id,
              },
            })
          }

          await ownerPrisma.app.delete({
            where: { id: duplicate.id },
          })
        }
      }

      const persistedApp = primaryApp
        ? await ownerPrisma.app.update({
            where: { id: primaryApp.id },
            data: {
              developerId: marker,
              name: app.name,
              description: buildDescription(app),
              toolDefinitions: mapToolDefinitions(app),
              uiManifest: mapUiManifest(app),
              permissions: { scopes: app.permissions },
              complianceMetadata: {
                source: 'developer_platform',
                pluginId: app.pluginId,
                trustTier: app.trustTier,
                networkDomains: app.networkDomains,
                collectsInput: app.collectsInput,
                inputFields: app.inputFields,
                ageRating: app.ageRating,
              },
              reviewStatus: app.status === 'suspended' ? 'suspended' : 'approved',
              version: app.version,
            },
          })
        : await ownerPrisma.app.create({
            data: {
              developerId: marker,
              name: app.name,
              description: buildDescription(app),
              toolDefinitions: mapToolDefinitions(app),
              uiManifest: mapUiManifest(app),
              permissions: { scopes: app.permissions },
              complianceMetadata: {
                source: 'developer_platform',
                pluginId: app.pluginId,
                trustTier: app.trustTier,
                networkDomains: app.networkDomains,
                collectsInput: app.collectsInput,
                inputFields: app.inputFields,
                ageRating: app.ageRating,
              },
              interactionModel: 'single_user',
              reviewStatus: app.status === 'suspended' ? 'suspended' : 'approved',
              version: app.version,
            },
          })

      const catalogStatus = app.status === 'suspended' ? 'suspended' : 'approved'
      await ownerPrisma.districtAppCatalog.upsert({
        where: {
          districtId_appId: {
            districtId: input.districtId,
            appId: persistedApp.id,
          },
        },
        create: {
          districtId: input.districtId,
          appId: persistedApp.id,
          status: catalogStatus,
        },
        update: {
          status: catalogStatus,
          approvedAt: catalogStatus === 'approved' ? new Date() : null,
          rejectionReason: catalogStatus === 'suspended' ? 'Suspended in developer platform registry' : null,
        },
      })

      if (catalogStatus !== 'approved') {
        await ownerPrisma.classroomAppConfig.updateMany({
          where: { districtId: input.districtId, appId: persistedApp.id },
          data: { enabled: false },
        })
      }
    }

    const importedApps = await ownerPrisma.app.findMany({
      where: {
        developerId: {
          startsWith: 'developer-platform:',
        },
      },
      select: {
        id: true,
        developerId: true,
      },
    })

    const staleImportedAppIds = importedApps
      .filter((app) => isDeveloperPlatformMarker(app.developerId) && !liveMarkers.has(app.developerId))
      .map((app) => app.id)

    if (staleImportedAppIds.length > 0) {
      await ownerPrisma.districtAppCatalog.updateMany({
        where: {
          districtId: input.districtId,
          appId: { in: staleImportedAppIds },
        },
        data: {
          status: 'suspended',
          approvedAt: null,
          rejectionReason: 'Removed from developer platform registry',
        },
      })

      await ownerPrisma.classroomAppConfig.updateMany({
        where: {
          districtId: input.districtId,
          appId: { in: staleImportedAppIds },
        },
        data: {
          enabled: false,
        },
      })

      await ownerPrisma.app.updateMany({
        where: {
          id: { in: staleImportedAppIds },
        },
        data: {
          reviewStatus: 'suspended',
        },
      })
    }

    return { synced: true, reason: 'ok' as const, count: registryApps.length }
  } catch (error) {
    input.logger?.warn({ err: error }, 'developer-platform registry sync failed')
    return { synced: false, reason: 'error' as const }
  }
}

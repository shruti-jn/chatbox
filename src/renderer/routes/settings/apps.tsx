import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Code,
  Divider,
  Flex,
  Grid,
  Loader,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core'
import { IconAlertCircle, IconCheck, IconCode, IconUpload } from '@tabler/icons-react'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

type QueueStatus = 'awaiting_review' | 'scan_failed' | 'approved' | 'published' | 'scanning' | 'draft' | 'rejected'

type AdminPluginListItem = {
  pluginId: string
  name: string
  description: string
  trustTier?: string
  queueStatus?: QueueStatus
  latestVersion?: {
    id: string
    version: string
    status: string
    hasArtifact: boolean
  } | null
}

type PluginCreateResponse = {
  pluginId: string
  slug: string
  name: string
  description: string
  trustTier?: string
}

type VersionCreateResponse = {
  id: string
  pluginId: string
  version: string
  status: string
  hasArtifact?: boolean
}

type SubmitResponse = {
  id: string
  pluginId: string
  version: string
  status: string
  hasArtifact?: boolean
}

const DEFAULT_MANIFEST = JSON.stringify(
  {
    pluginId: 'example-plugin',
    name: 'Example Plugin',
    version: '1.0.0',
    description: 'A classroom-safe plugin example.',
    entrypoint: '/index.html',
    ageRating: '8+',
    collectsInput: false,
    inputFields: [],
    permissions: [],
    networkDomains: [],
    dataPolicyUrl: 'https://example.com/privacy',
    externalResources: [],
    sriHashes: [],
    tools: [
      {
        name: 'example_tool',
        description: 'Runs an example tool',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  },
  null,
  2,
)

export const Route = createFileRoute('/settings/apps' as any)({
  component: RouteComponent,
})

function getSettings() {
  try {
    const raw = localStorage.getItem('settings')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function getDeveloperPlatformApiHost() {
  const settings = getSettings() as any
  return settings?.developerPlatformApiHost || 'http://localhost:3101'
}

function getDeveloperPlatformAdminApiKey() {
  const settings = getSettings() as any
  return settings?.developerPlatformAdminApiKey || ''
}

function statusColor(status?: string) {
  switch (status) {
    case 'published':
    case 'approved':
      return 'green'
    case 'awaiting_review':
    case 'scanning':
      return 'yellow'
    case 'scan_failed':
    case 'rejected':
      return 'red'
    default:
      return 'gray'
  }
}

export function RouteComponent() {
  const { t } = useTranslation()
  const apiHost = useMemo(() => getDeveloperPlatformApiHost(), [])
  const adminApiKey = useMemo(() => getDeveloperPlatformAdminApiKey(), [])

  const [plugins, setPlugins] = useState<AdminPluginListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<'plugin' | 'version' | 'artifact' | 'submit' | null>(null)

  const [pluginSlug, setPluginSlug] = useState('')
  const [pluginName, setPluginName] = useState('')
  const [pluginDescription, setPluginDescription] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [manifestJson, setManifestJson] = useState(DEFAULT_MANIFEST)
  const [bundleFile, setBundleFile] = useState<File | null>(null)

  const [draftPluginId, setDraftPluginId] = useState<string | null>(null)
  const [draftVersionId, setDraftVersionId] = useState<string | null>(null)
  const [draftStatus, setDraftStatus] = useState<string | null>(null)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [artifactStatus, setArtifactStatus] = useState<'missing' | 'uploaded'>('missing')

  useEffect(() => {
    const loadPlugins = async () => {
      try {
        setLoading(true)
        setError(null)

        const headers: Record<string, string> = {}
        if (adminApiKey) {
          headers['x-developer-platform-admin-key'] = adminApiKey
        }

        const response = await fetch(`${apiHost}/api/v1/admin/plugins`, { headers })
        if (!response.ok) {
          throw new Error(`Failed to fetch developer platform plugins (${response.status})`)
        }

        const data = await response.json()
        setPlugins(Array.isArray(data.plugins) ? data.plugins : [])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error loading developer portal')
      } finally {
        setLoading(false)
      }
    }

    loadPlugins()
  }, [apiHost, adminApiKey])

  async function createPluginDraft() {
    setBusy('plugin')
    setError(null)
    setSuccessMessage(null)

    try {
      const response = await fetch(`${apiHost}/api/v1/developer/plugins`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          slug: pluginSlug,
          name: pluginName,
          description: pluginDescription,
        }),
      })

      const data = (await response.json()) as PluginCreateResponse | { error?: string }
      if (!response.ok) {
        throw new Error((data as { error?: string }).error || 'Failed to create plugin draft')
      }

      setDraftPluginId(data.pluginId)
      setSuccessMessage(`Plugin draft created for ${data.name}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error creating plugin draft')
    } finally {
      setBusy(null)
    }
  }

  async function createVersionDraft() {
    setBusy('version')
    setError(null)
    setSuccessMessage(null)
    setManifestError(null)

    let manifest: unknown
    try {
      manifest = JSON.parse(manifestJson)
    } catch {
      setBusy(null)
      setManifestError('Manifest JSON is invalid.')
      return
    }

    if (!draftPluginId) {
      setBusy(null)
      setError('Create a plugin draft before creating a version draft.')
      return
    }

    try {
      const response = await fetch(`${apiHost}/api/v1/developer/plugins/${draftPluginId}/versions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          version,
          manifest,
        }),
      })

      const data = (await response.json()) as VersionCreateResponse | { error?: string }
      if (!response.ok) {
        throw new Error((data as { error?: string }).error || 'Failed to create version draft')
      }

      setDraftVersionId(data.id)
      setDraftStatus(data.status)
      setSuccessMessage(`Version draft ${data.version} created.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error creating version draft')
    } finally {
      setBusy(null)
    }
  }

  async function uploadArtifact() {
    setBusy('artifact')
    setError(null)
    setSuccessMessage(null)

    if (!draftPluginId || !draftVersionId) {
      setBusy(null)
      setError('Create a version draft before uploading an artifact.')
      return
    }

    if (!bundleFile) {
      setBusy(null)
      setError('Select a plugin bundle before uploading.')
      return
    }

    try {
      const formData = new FormData()
      formData.append('file', bundleFile)

      const response = await fetch(`${apiHost}/api/v1/developer/plugins/${draftPluginId}/versions/${draftVersionId}/artifact`, {
        method: 'POST',
        body: formData,
      })

      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to upload artifact')
      }

      setArtifactStatus('uploaded')
      setSuccessMessage(`Artifact uploaded: ${data.fileName}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error uploading artifact')
    } finally {
      setBusy(null)
    }
  }

  async function submitVersion() {
    setBusy('submit')
    setError(null)
    setSuccessMessage(null)

    if (!draftPluginId || !draftVersionId) {
      setBusy(null)
      setError('Create a version draft before submitting.')
      return
    }

    try {
      const response = await fetch(`${apiHost}/api/v1/developer/plugins/${draftPluginId}/versions/${draftVersionId}/submit`, {
        method: 'POST',
      })

      const data = (await response.json()) as SubmitResponse | { error?: string }
      if (!response.ok) {
        throw new Error((data as { error?: string }).error || 'Failed to submit version for review')
      }

      setDraftStatus(data.status)
      setSuccessMessage(`Version ${data.version} submitted for review.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error submitting version')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Stack p="md" gap="md">
      <Stack gap={4}>
        <Title order={4}>Developer Portal</Title>
        <Text c="dimmed" size="sm">
          Build a plugin draft, attach an artifact bundle, and push the version into the platform review pipeline.
        </Text>
      </Stack>

      <Card withBorder radius="md" padding="lg">
        <Stack gap="xs">
          <Text fw={600}>Connection</Text>
          <Text size="sm" c="dimmed">
            API host: <Code>{apiHost}</Code>
          </Text>
          <Text size="sm" c="dimmed">
            Admin listing: {adminApiKey ? 'enabled' : 'missing admin API key in local settings'}
          </Text>
        </Stack>
      </Card>

      {loading && (
        <Flex justify="center" align="center" py="xl" gap="sm">
          <Loader size="sm" />
          <Text>Loading developer portal…</Text>
        </Flex>
      )}

      {error && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" title="Portal error">
          {error}
        </Alert>
      )}

      {successMessage && (
        <Alert icon={<IconCheck size={16} />} color="green" title="Portal update">
          {successMessage}
        </Alert>
      )}

      <Grid>
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Card withBorder radius="md" padding="lg" h="100%">
            <Stack gap="md">
              <Flex justify="space-between" align="center">
                <Title order={5}>Submitted Plugins</Title>
                <Badge variant="light">{plugins.length}</Badge>
              </Flex>

              {!loading && plugins.length === 0 && (
                <Text c="dimmed" size="sm">
                  No submitted plugins yet.
                </Text>
              )}

              {plugins.map((plugin) => (
                <Card key={plugin.pluginId} withBorder radius="md" padding="md">
                  <Stack gap="xs">
                    <Flex justify="space-between" align="flex-start" gap="sm">
                      <Box>
                        <Text fw={600}>{plugin.name}</Text>
                        <Text size="xs" c="dimmed">
                          {plugin.description}
                        </Text>
                      </Box>
                      <Badge color={statusColor(plugin.queueStatus)} variant="light">
                        {plugin.queueStatus || 'draft'}
                      </Badge>
                    </Flex>

                    <Flex gap="xs" wrap="wrap">
                      <Badge variant="outline">{plugin.trustTier || 'dev-only'}</Badge>
                      {plugin.latestVersion && <Badge variant="outline">v{plugin.latestVersion.version}</Badge>}
                    </Flex>
                  </Stack>
                </Card>
              ))}
            </Stack>
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack gap="md">
            <Card withBorder radius="md" padding="lg">
              <Stack gap="md">
                <Flex justify="space-between" align="center">
                  <Title order={5}>Plugin Draft</Title>
                  {draftPluginId && <Badge variant="light">{draftPluginId}</Badge>}
                </Flex>

                <TextInput
                  label="Plugin Slug"
                  placeholder="dictionary-kit"
                  value={pluginSlug}
                  onChange={(event) => setPluginSlug(event.currentTarget.value)}
                />
                <TextInput
                  label="Plugin Name"
                  placeholder="Dictionary Kit"
                  value={pluginName}
                  onChange={(event) => setPluginName(event.currentTarget.value)}
                />
                <Textarea
                  label="Plugin Description"
                  placeholder="A concise description for reviewers and admins."
                  minRows={3}
                  value={pluginDescription}
                  onChange={(event) => setPluginDescription(event.currentTarget.value)}
                />

                <Button onClick={createPluginDraft} loading={busy === 'plugin'}>
                  Create Plugin Draft
                </Button>
              </Stack>
            </Card>

            <Card withBorder radius="md" padding="lg">
              <Stack gap="md">
                <Flex justify="space-between" align="center">
                  <Title order={5}>Version Submission</Title>
                  {draftStatus && (
                    <Badge color={statusColor(draftStatus)} variant="light">
                      {draftStatus}
                    </Badge>
                  )}
                </Flex>

                <TextInput
                  label="Version"
                  placeholder="1.0.0"
                  value={version}
                  onChange={(event) => setVersion(event.currentTarget.value)}
                />

                <Textarea
                  label="Manifest JSON"
                  minRows={16}
                  autosize
                  value={manifestJson}
                  onChange={(event) => setManifestJson(event.currentTarget.value)}
                  error={manifestError}
                />

                <Button leftSection={<IconCode size={16} />} onClick={createVersionDraft} loading={busy === 'version'}>
                  Create Version Draft
                </Button>

                <Divider />

                <Box>
                  <Text size="sm" fw={500} mb={6}>
                    Plugin Bundle
                  </Text>
                  <input
                    aria-label="Plugin Bundle"
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(event) => {
                      setBundleFile(event.currentTarget.files?.[0] ?? null)
                    }}
                  />
                </Box>

                <Flex gap="sm" wrap="wrap">
                  <Button
                    variant="light"
                    onClick={uploadArtifact}
                    loading={busy === 'artifact'}
                    disabled={!draftVersionId}
                  >
                    Upload Artifact
                  </Button>
                  <Badge variant="outline" color={artifactStatus === 'uploaded' ? 'green' : 'gray'}>
                    {artifactStatus === 'uploaded' ? 'artifact uploaded' : 'artifact missing'}
                  </Badge>
                </Flex>

                <Button
                  color="violet"
                  onClick={submitVersion}
                  loading={busy === 'submit'}
                  disabled={!draftVersionId}
                >
                  Submit Version for Review
                </Button>
              </Stack>
            </Card>
          </Stack>
        </Grid.Col>
      </Grid>

      <Alert icon={<IconAlertCircle size={16} />} color="blue" title={t('Review pipeline')}>
        Approved versions are published by the platform and later served from the platform-hosted plugin delivery domain.
      </Alert>
    </Stack>
  )
}

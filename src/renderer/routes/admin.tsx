import {
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Flex,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import Page from '@/components/layout/Page'

type QueueStatus = 'awaiting_review' | 'scan_failed' | 'approved' | 'published' | 'scanning' | 'draft' | 'rejected'

type AdminPluginListItem = {
  pluginId: string
  name: string
  description: string
  status: string
  trustTier: string
  createdAt: string
  versionCount: number
  queueStatus: QueueStatus
  latestVersion: {
    id: string
    version: string
    status: string
    submittedAt?: string
    approvedAt?: string
    hasArtifact: boolean
  } | null
  activePublishedVersion: {
    id: string
    version: string
    hostedUrl: string
  } | null
}

type PluginManifest = {
  name: string
  version: string
  description: string
  entrypoint: string
  ageRating: string
  permissions: string[]
  networkDomains: string[]
  collectsInput: boolean
  inputFields: Array<{ name: string; kind: string; required?: boolean }>
  tools: Array<{ name: string; description: string }>
}

type PluginVersionDetail = {
  id: string
  version: string
  status: string
  manifest: PluginManifest
  artifact?: {
    fileName: string
    sizeBytes: number
    sha256: string
    storageKey?: string
  } | null
  submittedAt?: string
  approvedAt?: string
  publishMetadata?: {
    hostedUrl: string
    publishedAt: string
  } | null
}

type AdminPluginDetail = {
  pluginId: string
  name: string
  description: string
  status: string
  trustTier: string
  createdAt: string
  activePublishedVersionId: string | null
  versions: PluginVersionDetail[]
}

type ScanRun = {
  id: string
  pluginVersionId: string
  rulesetVersion: string
  status: string
  overallDisposition: string
  createdAt: string
  completedAt?: string
  findings: Array<{ code: string; message: string; severity: string; category: string }>
}

type ReviewDecision = {
  id: string
  pluginVersionId: string
  decision: string
  reasonCode: string
  notes: string
  reviewerId: string
  createdAt: string
}

type ControlAction = {
  id: string
  type: string
  createdAt: string
  metadata?: Record<string, unknown>
}

type PluginAudit = {
  pluginId: string
  pluginStatus: string
  scanRuns: ScanRun[]
  reviewDecisions: ReviewDecision[]
  districtPluginOverrides: Array<{ districtId: string; enabled: boolean; updatedAt: string }>
  controlActions: ControlAction[]
}

type ArtifactInventory = {
  fileCount: number
  totalUncompressedBytes: number
  entries: Array<{ path: string; sizeBytes: number; sha256: string }>
}

type PolicyVerification = {
  overallDisposition: string
  observedNetworkDomains: string[]
  observedExternalResources: string[]
  observedInputSurfaces: Array<{ kind: string; path: string; identifier?: string }>
  findings: Array<{ code: string; message: string; severity: string }>
}

type ReviewRubric = {
  checklist: Array<{
    itemId: string
    label: string
    hardBlockOnFail: boolean
    waiverAllowed: boolean
  }>
}

type Analytics = {
  districtId: string
  messageCount: number
  safetyEventCount: number
  activeStudents: number
  classrooms: Array<{
    classroomId: string
    classroomName: string
    schoolId: string | null
    gradeBand: string
    conversationCount: number
    studentCount: number
  }>
}

type ChecklistState = Record<string, { status: 'pass' | 'fail' | 'waived'; notes: string }>

const reasonCodeOptions = [
  'clean_review',
  'manifest_mismatch',
  'undeclared_network_access',
  'undeclared_data_collection',
  'runtime_contract_mismatch',
  'artifact_integrity_failure',
  'security_scan_blocker',
  'student_safety_risk',
  'obfuscated_or_malformed_artifact',
  'missing_reviewer_evidence',
  'needs_security_escalation',
  'needs_legal_privacy_escalation',
  'needs_trust_safety_escalation',
  'needs_platform_escalation',
]

export const Route = createFileRoute('/admin')({
  component: AdminPage,
})

function getSettings() {
  try {
    const raw = localStorage.getItem('settings')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function getLegacyApiHost() {
  const settings = getSettings() as any
  return settings?.providers?.chatbridge?.apiHost || 'http://localhost:3001'
}

function getDeveloperPlatformApiHost() {
  const settings = getSettings() as any
  return settings?.developerPlatformApiHost || 'http://localhost:3101'
}

function getLegacyToken() {
  return localStorage.getItem('chatbridge:teacher_jwt') ?? ''
}

function formatTimestamp(value?: string | null) {
  if (!value) return 'Not yet'
  return new Date(value).toLocaleString()
}

function statusColor(status: string) {
  switch (status) {
    case 'approved':
    case 'published':
      return 'green'
    case 'awaiting_review':
    case 'scanning':
      return 'yellow'
    case 'scan_failed':
    case 'rejected':
    case 'suspended':
      return 'red'
    default:
      return 'gray'
  }
}

function AdminPage() {
  const [tab, setTab] = useState<'review' | 'analytics'>('review')
  const [plugins, setPlugins] = useState<AdminPluginListItem[]>([])
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AdminPluginDetail | null>(null)
  const [audit, setAudit] = useState<PluginAudit | null>(null)
  const [rubric, setRubric] = useState<ReviewRubric | null>(null)
  const [inventory, setInventory] = useState<ArtifactInventory | null>(null)
  const [verification, setVerification] = useState<PolicyVerification | null>(null)
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reviewerId, setReviewerId] = useState('reviewer-1')
  const [decision, setDecision] = useState<'approve' | 'reject' | 'waive' | 'escalate'>('approve')
  const [reasonCode, setReasonCode] = useState('clean_review')
  const [reviewNotes, setReviewNotes] = useState('')
  const [evidenceLocation, setEvidenceLocation] = useState('admin-review-console')
  const [evidenceSummary, setEvidenceSummary] = useState('Reviewer captured runtime evidence during manual review.')
  const [waiverRationale, setWaiverRationale] = useState('')
  const [rollbackVersionId, setRollbackVersionId] = useState<string | null>(null)
  const [suspensionReason, setSuspensionReason] = useState('')
  const [checklistState, setChecklistState] = useState<ChecklistState>({})

  const selectedVersion = useMemo(
    () => detail?.versions.find((version) => version.id === selectedVersionId) ?? null,
    [detail, selectedVersionId],
  )

  const selectedScanRuns = useMemo(
    () => audit?.scanRuns.filter((scanRun) => scanRun.pluginVersionId === selectedVersionId) ?? [],
    [audit, selectedVersionId],
  )

  const latestCompletedScanRun = useMemo(
    () => [...selectedScanRuns]
      .filter((scanRun) => scanRun.status === 'completed' || scanRun.status === 'failed')
      .sort((left, right) => (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt))[0] ?? null,
    [selectedScanRuns],
  )

  const rollbackOptions = useMemo(
    () => (detail?.versions ?? [])
      .filter((version) => ['approved', 'published', 'deprecated', 'rolled_back'].includes(version.status))
      .map((version) => ({ value: version.id, label: `${version.version} (${version.status})` })),
    [detail],
  )

  useEffect(() => {
    void fetchPlugins()
    void fetchRubric()
    void fetchAnalytics()
  }, [])

  useEffect(() => {
    if (!selectedPluginId && plugins.length > 0) {
      setSelectedPluginId(plugins[0].pluginId)
    }
  }, [plugins, selectedPluginId])

  useEffect(() => {
    if (!selectedPluginId) return
    void fetchDetail(selectedPluginId)
  }, [selectedPluginId])

  useEffect(() => {
    if (!detail) return
    const preferredVersion = detail.versions.find((version) => version.status === 'awaiting_review')
      ?? detail.versions.find((version) => version.status === 'approved')
      ?? detail.versions.find((version) => version.status === 'published')
      ?? detail.versions[0]
      ?? null
    setSelectedVersionId(preferredVersion?.id ?? null)
    setRollbackVersionId(detail.activePublishedVersionId)
  }, [detail])

  useEffect(() => {
    if (!selectedPluginId || !selectedVersionId) {
      setInventory(null)
      setVerification(null)
      return
    }
    void fetchVersionArtifacts(selectedPluginId, selectedVersionId)
  }, [selectedPluginId, selectedVersionId])

  useEffect(() => {
    if (!rubric) return
    const nextState: ChecklistState = {}
    for (const item of rubric.checklist) {
      nextState[item.itemId] = checklistState[item.itemId] ?? { status: 'pass', notes: item.label }
    }
    setChecklistState(nextState)
  }, [rubric])

  async function fetchPlugins() {
    setLoadingList(true)
    setError(null)
    try {
      const response = await fetch(`${getDeveloperPlatformApiHost()}/api/v1/admin/plugins`)
      if (!response.ok) {
        throw new Error(`Failed to fetch review queue (${response.status})`)
      }
      const data = await response.json()
      setPlugins(data.plugins ?? [])
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to fetch review queue')
      setPlugins([])
    } finally {
      setLoadingList(false)
    }
  }

  async function fetchDetail(pluginId: string) {
    setLoadingDetail(true)
    setError(null)
    try {
      const [detailResponse, auditResponse] = await Promise.all([
        fetch(`${getDeveloperPlatformApiHost()}/api/v1/admin/plugins/${pluginId}`),
        fetch(`${getDeveloperPlatformApiHost()}/api/v1/admin/plugins/${pluginId}/audit`),
      ])

      if (!detailResponse.ok) {
        throw new Error(`Failed to fetch plugin detail (${detailResponse.status})`)
      }
      if (!auditResponse.ok) {
        throw new Error(`Failed to fetch audit trail (${auditResponse.status})`)
      }

      setDetail(await detailResponse.json())
      setAudit(await auditResponse.json())
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to fetch plugin detail')
      setDetail(null)
      setAudit(null)
    } finally {
      setLoadingDetail(false)
    }
  }

  async function fetchVersionArtifacts(pluginId: string, versionId: string) {
    try {
      const [inventoryResponse, verificationResponse] = await Promise.all([
        fetch(`${getDeveloperPlatformApiHost()}/api/v1/admin/plugins/${pluginId}/versions/${versionId}/artifact-inventory`),
        fetch(`${getDeveloperPlatformApiHost()}/api/v1/admin/plugins/${pluginId}/versions/${versionId}/policy-verification`),
      ])

      setInventory(inventoryResponse.ok ? await inventoryResponse.json() : null)
      setVerification(verificationResponse.ok ? await verificationResponse.json() : null)
    } catch {
      setInventory(null)
      setVerification(null)
    }
  }

  async function fetchRubric() {
    try {
      const response = await fetch(`${getDeveloperPlatformApiHost()}/api/v1/admin/review-rubric`)
      if (response.ok) {
        setRubric(await response.json())
      }
    } catch {}
  }

  async function fetchAnalytics() {
    try {
      const response = await fetch(`${getLegacyApiHost()}/api/v1/admin/analytics`, {
        headers: { Authorization: `Bearer ${getLegacyToken()}` },
      })
      if (response.ok) {
        setAnalytics(await response.json())
      }
    } catch {}
  }

  async function runAction(actionId: string, request: () => Promise<Response>) {
    setBusyAction(actionId)
    setError(null)
    try {
      const response = await request()
      if (!response.ok) {
        const body = await response.text()
        throw new Error(body || `Action failed (${response.status})`)
      }
      await fetchPlugins()
      if (selectedPluginId) {
        await fetchDetail(selectedPluginId)
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Action failed')
    } finally {
      setBusyAction(null)
    }
  }

  async function submitReviewDecision() {
    if (!selectedPluginId || !selectedVersion || !latestCompletedScanRun) {
      setError('Select a version with a completed scan run before submitting review.')
      return
    }

    const checklist = Object.entries(checklistState).map(([itemId, value]) => ({
      itemId,
      status: value.status,
      notes: value.notes,
    }))
    const now = new Date().toISOString()

    const payload: Record<string, unknown> = {
      decision,
      reasonCode,
      notes: reviewNotes,
      reviewerId,
      scanContext: {
        rulesetVersion: latestCompletedScanRun.rulesetVersion,
        scanRunIds: [latestCompletedScanRun.id],
        referencedFindingRuleIds: [],
      },
      checklist,
      evidence: [
        {
          source: 'platform_scan',
          summary: `Scan ${latestCompletedScanRun.id} completed with ${latestCompletedScanRun.overallDisposition}.`,
          location: latestCompletedScanRun.id,
          capturedAt: now,
          findingIds: [],
        },
        {
          source: 'reviewer_runtime_capture',
          summary: evidenceSummary,
          location: evidenceLocation,
          capturedAt: now,
          findingIds: [],
        },
      ],
    }

    if (decision === 'waive') {
      payload.waiver = {
        rationale: waiverRationale || 'Temporary waiver approved with compensating controls documented by the reviewer.',
        approvedBy: reviewerId,
        scope: 'Admin review console waiver',
        compensatingControls: ['Manual monitoring'],
      }
    }

    if (decision === 'escalate') {
      payload.escalation = {
        path: 'security',
        severity: 'high',
        summary: reviewNotes || 'Escalated from admin review console.',
        blocking: true,
      }
    }

    await runAction('review', () => fetch(
      `${getDeveloperPlatformApiHost()}/api/v1/admin/plugins/${selectedPluginId}/versions/${selectedVersion.id}/review-decisions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    ))
  }

  return (
    <Page title="Admin Portal">
      <Stack p="md" gap="md" h="100%">
        <Group justify="space-between">
          <div>
            <Title order={3}>Admin Review Console</Title>
            <Text c="dimmed" size="sm">Review plugin submissions, inspect findings, and control publish/runtime state.</Text>
          </div>
          <Group>
            <Button variant={tab === 'review' ? 'filled' : 'light'} onClick={() => setTab('review')}>Review Console</Button>
            <Button variant={tab === 'analytics' ? 'filled' : 'light'} onClick={() => setTab('analytics')}>Analytics</Button>
          </Group>
        </Group>

        {error && (
          <Paper withBorder p="sm" bg="red.0">
            <Text c="red.8" size="sm">{error}</Text>
          </Paper>
        )}

        {tab === 'analytics' && analytics && (
          <Stack gap="md">
            <SimpleGrid cols={3}>
              <Card withBorder><Text size="sm" c="dimmed">Messages</Text><Title order={2}>{analytics.messageCount}</Title></Card>
              <Card withBorder><Text size="sm" c="dimmed">Active Students</Text><Title order={2}>{analytics.activeStudents}</Title></Card>
              <Card withBorder><Text size="sm" c="dimmed">Safety Events</Text><Title order={2}>{analytics.safetyEventCount}</Title></Card>
            </SimpleGrid>
            <Card withBorder>
              <Title order={5} mb="sm">Classrooms</Title>
              <Table striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Classroom</Table.Th>
                    <Table.Th>Grade</Table.Th>
                    <Table.Th>Students</Table.Th>
                    <Table.Th>Conversations</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {analytics.classrooms.map((classroom) => (
                    <Table.Tr key={classroom.classroomId}>
                      <Table.Td>{classroom.classroomName}</Table.Td>
                      <Table.Td>{classroom.gradeBand.toUpperCase()}</Table.Td>
                      <Table.Td>{classroom.studentCount}</Table.Td>
                      <Table.Td>{classroom.conversationCount}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Card>
          </Stack>
        )}

        {tab === 'review' && (
          <Flex gap="md" style={{ minHeight: 0, flex: 1 }}>
            <Card withBorder w={360} p={0}>
              <Stack gap={0} h="100%">
                <Group justify="space-between" p="md">
                  <div>
                    <Text fw={600}>Review Queue</Text>
                    <Text size="xs" c="dimmed">Developer platform submissions on port 3101</Text>
                  </div>
                  <Button size="xs" variant="light" onClick={() => void fetchPlugins()}>Refresh</Button>
                </Group>
                <Divider />
                <ScrollArea style={{ flex: 1 }}>
                  {loadingList ? (
                    <Flex justify="center" py="xl"><Loader size="sm" /></Flex>
                  ) : (
                    <Stack gap="xs" p="sm">
                      {plugins.map((plugin) => (
                        <Card
                          key={plugin.pluginId}
                          withBorder
                          p="sm"
                          bg={selectedPluginId === plugin.pluginId ? 'blue.0' : undefined}
                          style={{ cursor: 'pointer' }}
                          onClick={() => setSelectedPluginId(plugin.pluginId)}
                        >
                          <Group justify="space-between" align="flex-start">
                            <div>
                              <Text fw={600}>{plugin.name}</Text>
                              <Text size="xs" c="dimmed">{plugin.description}</Text>
                            </div>
                            <Badge color={statusColor(plugin.queueStatus)} variant="light">{plugin.queueStatus}</Badge>
                          </Group>
                          <Group mt="xs" gap="xs">
                            <Badge variant="outline">{plugin.status}</Badge>
                            <Badge variant="outline">v{plugin.latestVersion?.version ?? 'n/a'}</Badge>
                            <Badge variant="outline">{plugin.versionCount} versions</Badge>
                          </Group>
                        </Card>
                      ))}
                      {plugins.length === 0 && <Text size="sm" c="dimmed" p="md">No plugins found.</Text>}
                    </Stack>
                  )}
                </ScrollArea>
              </Stack>
            </Card>

            <Card withBorder style={{ flex: 1, minWidth: 0 }}>
              {loadingDetail ? (
                <Flex justify="center" py="xl"><Loader /></Flex>
              ) : !detail ? (
                <Flex justify="center" py="xl"><Text c="dimmed">Select a plugin to inspect.</Text></Flex>
              ) : (
                <ScrollArea h="100%">
                  <Stack gap="md">
                    <Group justify="space-between" align="flex-start">
                      <div>
                        <Title order={4}>{detail.name}</Title>
                        <Text c="dimmed" size="sm">{detail.pluginId}</Text>
                        <Text size="sm" mt={4}>{detail.description}</Text>
                      </div>
                      <Group>
                        <Badge color={statusColor(detail.status)}>{detail.status}</Badge>
                        <Badge variant="outline">{detail.trustTier}</Badge>
                      </Group>
                    </Group>

                    <Group>
                      <Select
                        label="Selected version"
                        value={selectedVersionId}
                        onChange={setSelectedVersionId}
                        data={detail.versions.map((version) => ({
                          value: version.id,
                          label: `${version.version} (${version.status})`,
                        }))}
                        style={{ minWidth: 260 }}
                      />
                      <Text size="sm" c="dimmed" mt={24}>Created {formatTimestamp(detail.createdAt)}</Text>
                    </Group>

                    {selectedVersion && (
                      <>
                        <SimpleGrid cols={2}>
                          <Card withBorder>
                            <Text fw={600} mb="xs">Manifest</Text>
                            <Text size="sm">Entrypoint: {selectedVersion.manifest.entrypoint}</Text>
                            <Text size="sm">Age rating: {selectedVersion.manifest.ageRating}</Text>
                            <Text size="sm">Collects input: {selectedVersion.manifest.collectsInput ? 'Yes' : 'No'}</Text>
                            <Text size="sm">Permissions: {selectedVersion.manifest.permissions.join(', ') || 'None'}</Text>
                            <Text size="sm">Network domains: {selectedVersion.manifest.networkDomains.join(', ') || 'None'}</Text>
                            <Text size="sm">Tools: {selectedVersion.manifest.tools.map((tool) => tool.name).join(', ')}</Text>
                          </Card>
                          <Card withBorder>
                            <Text fw={600} mb="xs">Version State</Text>
                            <Text size="sm">Status: {selectedVersion.status}</Text>
                            <Text size="sm">Submitted: {formatTimestamp(selectedVersion.submittedAt)}</Text>
                            <Text size="sm">Approved: {formatTimestamp(selectedVersion.approvedAt)}</Text>
                            <Text size="sm">Published: {formatTimestamp(selectedVersion.publishMetadata?.publishedAt)}</Text>
                            <Text size="sm">Hosted URL: {selectedVersion.publishMetadata?.hostedUrl ?? 'Not published'}</Text>
                          </Card>
                        </SimpleGrid>

                        <SimpleGrid cols={2}>
                          <Card withBorder>
                            <Text fw={600} mb="xs">Scan Runs</Text>
                            <Stack gap="xs">
                              {selectedScanRuns.map((scanRun) => (
                                <Paper key={scanRun.id} withBorder p="xs">
                                  <Group justify="space-between">
                                    <Text size="sm" fw={500}>{scanRun.id.slice(0, 8)}</Text>
                                    <Badge color={statusColor(scanRun.overallDisposition)} variant="light">
                                      {scanRun.status} / {scanRun.overallDisposition}
                                    </Badge>
                                  </Group>
                                  <Text size="xs" c="dimmed">{formatTimestamp(scanRun.completedAt ?? scanRun.createdAt)}</Text>
                                  <Text size="xs">{scanRun.findings.length} findings</Text>
                                </Paper>
                              ))}
                              {selectedScanRuns.length === 0 && <Text size="sm" c="dimmed">No scan runs for this version.</Text>}
                            </Stack>
                          </Card>
                          <Card withBorder>
                            <Text fw={600} mb="xs">Policy Verification</Text>
                            {verification ? (
                              <Stack gap={4}>
                                <Text size="sm">Disposition: {verification.overallDisposition}</Text>
                                <Text size="sm">Observed domains: {verification.observedNetworkDomains.join(', ') || 'None'}</Text>
                                <Text size="sm">External resources: {verification.observedExternalResources.length}</Text>
                                <Text size="sm">Input surfaces: {verification.observedInputSurfaces.length}</Text>
                                {verification.findings.slice(0, 4).map((finding) => (
                                  <Text key={finding.code} size="xs" c="dimmed">{finding.code}: {finding.message}</Text>
                                ))}
                              </Stack>
                            ) : (
                              <Text size="sm" c="dimmed">No verification data available.</Text>
                            )}
                          </Card>
                        </SimpleGrid>

                        <Card withBorder>
                          <Text fw={600} mb="sm">Review Decision</Text>
                          <SimpleGrid cols={2}>
                            <TextInput label="Reviewer ID" value={reviewerId} onChange={(event) => setReviewerId(event.currentTarget.value)} />
                            <Select label="Decision" value={decision} onChange={(value) => setDecision((value as any) ?? 'approve')} data={['approve', 'reject', 'waive', 'escalate']} />
                            <Select label="Reason code" value={reasonCode} onChange={(value) => setReasonCode(value ?? 'clean_review')} data={reasonCodeOptions} searchable />
                            <TextInput label="Evidence location" value={evidenceLocation} onChange={(event) => setEvidenceLocation(event.currentTarget.value)} />
                          </SimpleGrid>
                          <Textarea mt="sm" label="Evidence summary" value={evidenceSummary} onChange={(event) => setEvidenceSummary(event.currentTarget.value)} minRows={2} />
                          <Textarea mt="sm" label="Reviewer notes" value={reviewNotes} onChange={(event) => setReviewNotes(event.currentTarget.value)} minRows={3} />
                          {decision === 'waive' && (
                            <Textarea mt="sm" label="Waiver rationale" value={waiverRationale} onChange={(event) => setWaiverRationale(event.currentTarget.value)} minRows={2} />
                          )}

                          <Divider my="sm" />
                          <Text fw={500} size="sm" mb="xs">Checklist</Text>
                          <Stack gap="xs">
                            {(rubric?.checklist ?? []).map((item) => (
                              <Paper key={item.itemId} withBorder p="xs">
                                <Group align="flex-start" grow>
                                  <div>
                                    <Text size="sm" fw={500}>{item.label}</Text>
                                    <Text size="xs" c="dimmed">{item.itemId}</Text>
                                  </div>
                                  <Select
                                    value={checklistState[item.itemId]?.status ?? 'pass'}
                                    onChange={(value) => setChecklistState((current) => ({
                                      ...current,
                                      [item.itemId]: {
                                        ...(current[item.itemId] ?? { notes: item.label }),
                                        status: (value as 'pass' | 'fail' | 'waived') ?? 'pass',
                                      },
                                    }))}
                                    data={['pass', 'fail', 'waived']}
                                  />
                                </Group>
                                <Textarea
                                  mt="xs"
                                  value={checklistState[item.itemId]?.notes ?? ''}
                                  onChange={(event) => setChecklistState((current) => ({
                                    ...current,
                                    [item.itemId]: {
                                      status: current[item.itemId]?.status ?? 'pass',
                                      notes: event.currentTarget.value,
                                    },
                                  }))}
                                  minRows={2}
                                />
                              </Paper>
                            ))}
                          </Stack>

                          <Group mt="md">
                            <Button loading={busyAction === 'review'} onClick={() => void submitReviewDecision()} disabled={!latestCompletedScanRun}>
                              Submit Review
                            </Button>
                            <Button
                              variant="light"
                              loading={busyAction === 'publish'}
                              disabled={selectedVersion.status !== 'approved'}
                              onClick={() => void runAction('publish', () => fetch(
                                `${getDeveloperPlatformApiHost()}/api/v1/admin/plugins/${detail.pluginId}/versions/${selectedVersion.id}/publish`,
                                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
                              ))}
                            >
                              Publish
                            </Button>
                            <Button
                              color="red"
                              variant="light"
                              loading={busyAction === 'suspend'}
                              disabled={detail.status === 'suspended'}
                              onClick={() => void runAction('suspend', () => fetch(
                                `${getDeveloperPlatformApiHost()}/api/v1/admin/plugins/${detail.pluginId}/suspend`,
                                {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ reason: suspensionReason || 'Manual suspension from admin review console', actor: reviewerId }),
                                },
                              ))}
                            >
                              Suspend
                            </Button>
                            <Button
                              color="green"
                              variant="light"
                              loading={busyAction === 'reinstate'}
                              disabled={detail.status !== 'suspended'}
                              onClick={() => void runAction('reinstate', () => fetch(
                                `${getDeveloperPlatformApiHost()}/api/v1/admin/plugins/${detail.pluginId}/reinstate`,
                                {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ reason: suspensionReason || 'Manual reinstatement from admin review console', actor: reviewerId }),
                                },
                              ))}
                            >
                              Reinstate
                            </Button>
                          </Group>
                        </Card>

                        <SimpleGrid cols={2}>
                          <Card withBorder>
                            <Text fw={600} mb="sm">Rollback</Text>
                            <Group align="end">
                              <Select
                                label="Rollback target"
                                value={rollbackVersionId}
                                onChange={setRollbackVersionId}
                                data={rollbackOptions}
                                style={{ flex: 1 }}
                              />
                              <Button
                                loading={busyAction === 'rollback'}
                                disabled={!rollbackVersionId}
                                onClick={() => void runAction('rollback', () => fetch(
                                  `${getDeveloperPlatformApiHost()}/api/v1/admin/plugins/${detail.pluginId}/rollback`,
                                  {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ targetVersionId: rollbackVersionId }),
                                  },
                                ))}
                              >
                                Rollback
                              </Button>
                            </Group>
                            <TextInput mt="sm" label="Suspend/Reinstate note" value={suspensionReason} onChange={(event) => setSuspensionReason(event.currentTarget.value)} />
                          </Card>

                          <Card withBorder>
                            <Text fw={600} mb="sm">Artifact Inventory</Text>
                            {inventory ? (
                              <Stack gap={4}>
                                <Text size="sm">Files: {inventory.fileCount}</Text>
                                <Text size="sm">Uncompressed bytes: {inventory.totalUncompressedBytes}</Text>
                                {inventory.entries.slice(0, 6).map((entry) => (
                                  <Text key={entry.path} size="xs" c="dimmed">{entry.path} ({entry.sizeBytes} bytes)</Text>
                                ))}
                              </Stack>
                            ) : (
                              <Text size="sm" c="dimmed">No inventory data available.</Text>
                            )}
                          </Card>
                        </SimpleGrid>

                        <Card withBorder>
                          <Text fw={600} mb="sm">Audit Trail</Text>
                          <SimpleGrid cols={3}>
                            <div>
                              <Text size="sm" fw={500}>Review Decisions</Text>
                              <Stack gap="xs" mt="xs">
                                {(audit?.reviewDecisions ?? []).map((entry) => (
                                  <Paper key={entry.id} withBorder p="xs">
                                    <Text size="sm">{entry.decision} / {entry.reasonCode}</Text>
                                    <Text size="xs" c="dimmed">{entry.reviewerId} • {formatTimestamp(entry.createdAt)}</Text>
                                  </Paper>
                                ))}
                              </Stack>
                            </div>
                            <div>
                              <Text size="sm" fw={500}>Control Actions</Text>
                              <Stack gap="xs" mt="xs">
                                {(audit?.controlActions ?? []).map((entry) => (
                                  <Paper key={entry.id} withBorder p="xs">
                                    <Text size="sm">{entry.type}</Text>
                                    <Text size="xs" c="dimmed">{formatTimestamp(entry.createdAt)}</Text>
                                  </Paper>
                                ))}
                              </Stack>
                            </div>
                            <div>
                              <Text size="sm" fw={500}>District Overrides</Text>
                              <Stack gap="xs" mt="xs">
                                {(audit?.districtPluginOverrides ?? []).map((entry) => (
                                  <Paper key={`${entry.districtId}-${entry.updatedAt}`} withBorder p="xs">
                                    <Text size="sm">{entry.districtId}</Text>
                                    <Text size="xs" c="dimmed">{entry.enabled ? 'enabled' : 'disabled'} • {formatTimestamp(entry.updatedAt)}</Text>
                                  </Paper>
                                ))}
                              </Stack>
                            </div>
                          </SimpleGrid>
                        </Card>
                      </>
                    )}
                  </Stack>
                </ScrollArea>
              )}
            </Card>
          </Flex>
        )}
      </Stack>
    </Page>
  )
}

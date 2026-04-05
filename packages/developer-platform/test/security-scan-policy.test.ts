import { describe, expect, it } from 'vitest'
import type { ScanFinding } from '@chatbridge/shared'
import { buildDeveloperPlatformServer } from '../src/app.js'
import { createDeveloperPlatformStore } from '../src/store.js'

describe('security scan policy', () => {
  it('publishes a versioned ruleset with explicit blocked patterns and thresholds', async () => {
    const store = await createDeveloperPlatformStore()
    const policy = store.getSecurityScanPolicy()

    expect(policy.rulesetVersion).toBe('dp-sec-v1')
    expect(policy.staticAnalysisApproach).toEqual(
      expect.arrayContaining(['ast_and_signature_scan', 'dependency_sca']),
    )
    expect(policy.blockedPatterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'static-dynamic-code-exec',
          family: 'dynamic_code_execution',
          action: 'fail',
        }),
        expect.objectContaining({
          ruleId: 'network-undeclared-domain',
          family: 'undeclared_network_access',
          action: 'fail',
        }),
        expect.objectContaining({
          ruleId: 'bundle-obfuscation',
          action: 'manual_review',
        }),
      ]),
    )
  })

  it('fails findings that match hard-block patterns like dynamic execution or undeclared network access', async () => {
    const store = await createDeveloperPlatformStore()
    const findings: ScanFinding[] = [
      {
        code: 'DYN-001',
        ruleId: 'static-dynamic-code-exec',
        category: 'static_analysis',
        severity: 'critical',
        disposition: 'fail',
        message: 'eval() usage detected in app bootstrap',
      },
      {
        code: 'NET-001',
        ruleId: 'network-undeclared-domain',
        category: 'policy_mismatch',
        severity: 'high',
        disposition: 'fail',
        message: 'Request to undeclared analytics.evil.example',
      },
    ]

    const result = store.evaluateScanFindings(findings, 'dp-sec-v1')
    expect(result).toEqual(
      expect.objectContaining({
        rulesetVersion: 'dp-sec-v1',
        overallDisposition: 'fail',
      }),
    )
    expect(result.thresholdReason).toContain('DYN-001')
  })

  it('routes obfuscated bundles into manual review instead of silently passing them', async () => {
    const store = await createDeveloperPlatformStore()
    const findings: ScanFinding[] = [
      {
        code: 'BND-041',
        ruleId: 'bundle-obfuscation',
        category: 'artifact_integrity',
        severity: 'high',
        disposition: 'manual_review',
        message: 'Self-defending obfuscator signature found in runtime bootstrap',
      },
    ]

    const result = store.evaluateScanFindings(findings, 'dp-sec-v1')
    expect(result.overallDisposition).toBe('manual_review')
    expect(result.thresholdReason).toContain('bundle-obfuscation')
  })

  it('keeps lower-severity dependency hygiene findings at warn when they do not meet a hard-block rule', async () => {
    const store = await createDeveloperPlatformStore()
    const findings: ScanFinding[] = [
      {
        code: 'DEP-090',
        category: 'dependency',
        severity: 'warning',
        disposition: 'warn',
        message: 'Dependency is stale beyond the recommended update window',
      },
    ]

    const result = store.evaluateScanFindings(findings, 'dp-sec-v1')
    expect(result.overallDisposition).toBe('warn')
  })

  it('serves the policy and evaluation API over HTTP for reviewer and scanner consumers', async () => {
    const server = await buildDeveloperPlatformServer({ logger: false })

    try {
      const policyResponse = await server.inject({
        method: 'GET',
        url: '/api/v1/admin/security-scan-policy',
      })

      expect(policyResponse.statusCode).toBe(200)
      expect(policyResponse.json()).toEqual(
        expect.objectContaining({
          rulesetVersion: 'dp-sec-v1',
          blockedPatterns: expect.arrayContaining([
            expect.objectContaining({
              ruleId: 'static-tracking-sdk',
            }),
          ]),
        }),
      )

      const evaluationResponse = await server.inject({
        method: 'POST',
        url: '/api/v1/admin/security-scan-policy/evaluate',
        payload: {
          rulesetVersion: 'dp-sec-v1',
          findings: [
            {
              code: 'TRK-001',
              ruleId: 'static-tracking-sdk',
              category: 'static_analysis',
              severity: 'high',
              disposition: 'fail',
              message: 'Tracking SDK import detected',
            },
          ],
        },
      })

      expect(evaluationResponse.statusCode).toBe(200)
      expect(evaluationResponse.json()).toEqual(
        expect.objectContaining({
          rulesetVersion: 'dp-sec-v1',
          overallDisposition: 'fail',
        }),
      )
    } finally {
      await server.close()
    }
  })
})

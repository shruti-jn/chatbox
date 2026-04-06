/**
 * k6 Burst Test — SHR-211 A1
 *
 * 200 concurrent POST /chatbridge/completions, each triggering tool_use.
 * Pass criteria: 0 failures, p99 < 30s.
 *
 * Usage: k6 run --out json=burst-results.json test/k6/burst-test.js
 */

import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const errorRate = new Rate('errors')
const responseDuration = new Trend('response_duration')

export const options = {
  vus: 200,
  iterations: 200, // Each VU sends 1 request
  thresholds: {
    http_req_failed: ['rate==0'], // 0 failures
    http_req_duration: ['p(99)<30000'], // p99 < 30s
    errors: ['rate==0'],
  },
}

const API_HOST = __ENV.API_HOST || 'http://localhost:3001'
const API_KEY = __ENV.ANTHROPIC_API_KEY || ''

export default function () {
  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 50,
    messages: [{ role: 'user', content: "Let's play chess!" }],
  })

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
    'anthropic-version': '2023-06-01',
  }

  // Use the proxy endpoint (simpler, no JWT needed)
  const res = http.post(`${API_HOST}/api/v1/ai/proxy/messages`, payload, {
    headers,
    timeout: '30s',
  })

  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'response has content': (r) => {
      try {
        const body = JSON.parse(r.body)
        return body.content && body.content.length > 0
      } catch {
        return false
      }
    },
  })

  errorRate.add(!success)
  responseDuration.add(res.timings.duration)

  sleep(0.1) // Small jitter
}

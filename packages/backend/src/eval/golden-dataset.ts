import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

export type GoldenScenarioCategory = 'chat_quality' | 'routing_accuracy' | 'safety'

export interface GoldenScenario {
  id: string
  category: GoldenScenarioCategory
  input: string
  context?: Record<string, unknown>
  expected_behavior: string
  scoring_dimensions: string[]
  source: string
}

function loadGoldenDataset(): GoldenScenario[] {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const datasetPath = path.resolve(dir, '../../test/golden-dataset/scenarios.json')
  const raw = fs.readFileSync(datasetPath, 'utf8')
  return JSON.parse(raw) as GoldenScenario[]
}

export const GOLDEN_DATASET: GoldenScenario[] = loadGoldenDataset()

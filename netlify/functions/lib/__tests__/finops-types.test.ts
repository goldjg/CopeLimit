import { describe, expect, it } from 'vitest'
import type {
  AADLCPhaseEvent,
  AADLCRunManifest,
  AttributionRecord,
  UsageCheckpoint,
  ValidationResult
} from '../finops-types'

describe('finops-types — structural shape', () => {
  it('supports minimal FinOps domain objects', () => {
    const checkpoint: UsageCheckpoint = {
      checkpointId: 'checkpoint-1',
      source: 'copelimit_live',
      remaining: 80,
      used: 20,
      quota: 100,
      mode: 'ai_credits',
      capturedAt: '2026-06-01T00:00:00.000Z',
      confidence: 'high',
      freshness: 'fresh'
    }

    const validation: ValidationResult = {
      check: 'npm test',
      passed: true,
      summary: 'Vitest suite passed'
    }

    const phase: AADLCPhaseEvent = {
      phaseId: 'phase-1',
      phaseName: 'Planning',
      phaseType: 'planning',
      commandsRun: ['npm test'],
      filesRead: ['netlify/functions/lib/capture-types.ts'],
      filesChanged: ['netlify/functions/lib/finops-types.ts'],
      attributionConfidenceDeclared: 'declared',
      contaminationStatusDeclared: 'clean'
    }

    const manifest: AADLCRunManifest = {
      schemaVersion: '0.1',
      manifestId: 'manifest-1',
      repo: 'goldjg/CopeLimit',
      runType: 'implementation',
      taskTitle: 'Add FinOps domain types',
      taskIntent: 'Create type-only Horizon 3 FinOps definitions',
      emittedAt: '2026-06-01T00:10:00.000Z'
    }

    const manifestWithPhase: AADLCRunManifest = {
      ...manifest,
      manifestId: 'manifest-2',
      validationResults: [validation],
      phases: [phase],
      beforeCheckpointId: checkpoint.checkpointId,
      afterCheckpointId: 'checkpoint-2'
    }

    const attribution: AttributionRecord = {
      attributionId: 'attribution-1',
      manifestId: manifestWithPhase.manifestId,
      phaseId: phase.phaseId,
      beforeCheckpointId: checkpoint.checkpointId,
      afterCheckpointId: 'checkpoint-2',
      creditDelta: 7,
      confidence: 'observed',
      contaminationStatus: 'clean',
      createdAt: '2026-06-01T00:20:00.000Z'
    }

    expect(checkpoint.source).toBe('copelimit_live')
    expect(checkpoint.mode).toBe('ai_credits')
    expect(validation.passed).toBe(true)
    expect(phase.phaseType).toBe('planning')
    expect(manifest.schemaVersion).toBe('0.1')
    expect(manifestWithPhase.phases?.[0]?.commandsRun).toEqual(['npm test'])
    expect(attribution.confidence).toBe('observed')
  })
})

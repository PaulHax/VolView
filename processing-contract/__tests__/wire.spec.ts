import { describe, expect, it } from 'vitest';

import {
  JOB_STATES,
  RESULT_INTENTS,
  INTENT_VOCABULARY_VERSION,
  isKnownIntent,
  inputValueSchema,
  neutralJobStatusSchema,
  resultIntentSchema,
  neutralJobHandleSchema,
  jobResultsSchema,
  jobResultsErrorSchema,
} from '../wire';
import { loadFixtureDir } from './loadFixtures';

const wire = Object.fromEntries(
  loadFixtureDir('wire').map((f) => [f.name, f.data])
);

// ---------------------------------------------------------------------------
// Seam 1 — input values
// ---------------------------------------------------------------------------

describe('input value fixtures', () => {
  it.each([
    'input-value.dicom-series',
    'input-value.single-file',
    'input-value.labelmap',
  ])('validates %s', (name) => {
    expect(() => inputValueSchema.parse(wire[name])).not.toThrow();
  });

  it('carries multiple URIs for a dicom-series image', () => {
    const value = inputValueSchema.parse(wire['input-value.dicom-series']);
    expect(value.type).toBe('image');
    expect(value.uris.length).toBeGreaterThan(1);
  });

  it('accepts the open `labelmap` type tag (no closed server enum)', () => {
    const value = inputValueSchema.parse(wire['input-value.labelmap']);
    expect(value.type).toBe('labelmap');
  });

  it('accepts an unknown/open type tag', () => {
    expect(() =>
      inputValueSchema.parse({ type: 'pet', uris: ['/x'] })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Seam 3 — neutral status
// ---------------------------------------------------------------------------

describe('neutral job status fixtures', () => {
  it('has exactly the five v1 states, cancelled included', () => {
    // Runtime names (Chunk 12 -> Chunk 23 reconcile): the facade projects and the
    // client store consumes these; the canonical schema is named TO them.
    expect([...JOB_STATES]).toEqual([
      'pending',
      'running',
      'success',
      'error',
      'cancelled',
    ]);
  });

  it.each([
    'status.pending',
    'status.running',
    'status.success',
    'status.error',
    'status.cancelled',
    'status.error-tail',
  ])('validates %s', (name) => {
    expect(() => neutralJobStatusSchema.parse(wire[name])).not.toThrow();
  });

  it('accepts cancelled with no wire change', () => {
    const s = neutralJobStatusSchema.parse(wire['status.cancelled']);
    expect(s.state).toBe('cancelled');
  });

  it('carries an errorTail on an errored job', () => {
    const s = neutralJobStatusSchema.parse(wire['status.error-tail']);
    expect(s.state).toBe('error');
    expect(s.errorTail).toBeTruthy();
  });

  it('rejects a state outside the five (e.g. the retired `queued`)', () => {
    // `queued`/`succeeded`/`failed` are the pre-reconcile spellings and are now
    // rejected; the runtime names (`pending`/`success`/`error`) are the valid five.
    expect(
      neutralJobStatusSchema.safeParse({ jobId: 'j', state: 'queued' }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Seam 2 — result intents
// ---------------------------------------------------------------------------

describe('result intent fixtures', () => {
  it('exports vocabulary version 1 and the exactly-five v1 intents', () => {
    expect(INTENT_VOCABULARY_VERSION).toBe(1);
    expect([...RESULT_INTENTS]).toEqual([
      'add-base-image',
      'add-layer',
      'add-segment-group',
      'restore-state',
      'download',
    ]);
  });

  it.each([
    'intent.add-base-image',
    'intent.add-layer',
    'intent.add-segment-group.with-segments',
    'intent.add-segment-group.embedded',
    'intent.restore-state',
    'intent.download',
    'intent.unknown',
  ])('validates %s', (name) => {
    expect(() => resultIntentSchema.parse(wire[name])).not.toThrow();
  });

  it('parses add-segment-group WITH segments and a source provenance tag', () => {
    const parsed = resultIntentSchema.parse(
      wire['intent.add-segment-group.with-segments']
    ) as Record<string, unknown>;
    expect(parsed.intent).toBe('add-segment-group');
    expect(Array.isArray(parsed.segments)).toBe(true);
    expect(parsed.source).toEqual({
      jobId: 'job-abc123',
      outputId: 'outputLabelmap',
    });
  });

  it('parses add-segment-group WITHOUT segments (embedded metadata) but with source', () => {
    const parsed = resultIntentSchema.parse(
      wire['intent.add-segment-group.embedded']
    ) as Record<string, unknown>;
    expect(parsed.intent).toBe('add-segment-group');
    expect(parsed.segments).toBeUndefined();
    expect(parsed.source).toMatchObject({ outputId: 'outputLabelmap' });
  });

  it('ACCEPTS an unknown intent so the applier can degrade to download', () => {
    const parsed = resultIntentSchema.parse(wire['intent.unknown']) as Record<
      string,
      unknown
    >;
    // It parses (fail-open), but is not one of the known five.
    expect(isKnownIntent(parsed.intent as string)).toBe(false);
    expect(parsed.url).toBeTruthy();
    expect(parsed.name).toBeTruthy();
  });

  it('recognizes the five known intents via isKnownIntent', () => {
    expect(isKnownIntent('add-segment-group')).toBe(true);
    expect(isKnownIntent('download')).toBe(true);
    expect(isKnownIntent('attach-segment-group')).toBe(false);
  });

  it('still rejects a result that is not even a file reference', () => {
    expect(
      resultIntentSchema.safeParse({ intent: 'add-polygon' }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Seam 3 — tier-2 handle + result-read payloads
// ---------------------------------------------------------------------------

describe('tier-2 handle + result-read payloads', () => {
  it('validates a NeutralJobHandle carrying input URIs + finishedAt', () => {
    const handle = neutralJobHandleSchema.parse(wire['job-handle']);
    expect(handle.inputUris.length).toBeGreaterThan(0);
    expect(handle.taskId).toBeTruthy();
    expect(handle.finishedAt).toBeTruthy();
  });

  it('validates a getJobResults success payload with a missing count', () => {
    const results = jobResultsSchema.parse(wire['job-results.missing']);
    expect(results.missing).toBe(2);
    expect(results.intents.length).toBe(1);
  });

  it('validates a getJobResults error payload (non-success)', () => {
    const err = jobResultsErrorSchema.parse(wire['job-results.error']);
    expect(err.error).toBeTruthy();
    expect(err.state).toBe('error');
  });
});

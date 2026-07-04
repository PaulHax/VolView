import { describe, expect, it } from 'vitest';

import {
  SPEC_VERSION,
  taskSpecSchema,
  taskParameterSchema,
  type VolViewTaskSpec,
} from '../task-spec';
import { loadFixture, loadFixtureDir } from './loadFixtures';

// ---------------------------------------------------------------------------
// Golden task-spec fixtures (positive) — every one must validate.
// ---------------------------------------------------------------------------

describe('task-spec golden fixtures validate', () => {
  const fixtures = loadFixtureDir('task-spec');

  it('loads the expected fixtures', () => {
    expect(fixtures.map((f) => f.name).sort()).toEqual([
      'masked-median-filter',
      'median-filter',
      'otsu-segmentation',
      'synthetic-bounds-enum',
      'threshold-segmentation',
    ]);
  });

  it.each(fixtures.map((f) => [f.name, f.data] as const))(
    'validates %s',
    (_name, data) => {
      expect(() => taskSpecSchema.parse(data)).not.toThrow();
    }
  );

  it('pins specVersion as an integer on every fixture', () => {
    fixtures.forEach(({ data }) => {
      const spec = taskSpecSchema.parse(data);
      expect(Number.isInteger(spec.specVersion)).toBe(true);
      expect(spec.specVersion).toBe(SPEC_VERSION);
    });
  });
});

// ---------------------------------------------------------------------------
// Field-kind coverage against the real-CLI + synthetic fixtures.
// ---------------------------------------------------------------------------

describe('task-spec field kinds', () => {
  const specByName = Object.fromEntries(
    loadFixtureDir('task-spec').map((f) => [
      f.name,
      taskSpecSchema.parse(f.data),
    ])
  ) as Record<string, VolViewTaskSpec>;

  it('models a sourceRef input with an open `accepts` type-tag list', () => {
    const input = specByName['median-filter'].parameters.find(
      (p) => p.id === 'inputVolume'
    );
    expect(input).toMatchObject({ kind: 'sourceRef', accepts: ['image'] });
    expect(input).toMatchObject({ required: true });
  });

  it('models a labelmap-consuming task (Chunk 16): image input + labelmap input', () => {
    const spec = specByName['masked-median-filter'];
    const background = spec.parameters.find((p) => p.id === 'inputVolume');
    const mask = spec.parameters.find((p) => p.id === 'inputLabelmap');
    expect(background).toMatchObject({ kind: 'sourceRef', accepts: ['image'] });
    expect(mask).toMatchObject({ kind: 'sourceRef', accepts: ['labelmap'] });
    // v1 multi-input shape: exactly one background + one labelmap, no more.
    expect(spec.parameters.filter((p) => p.kind === 'sourceRef')).toHaveLength(
      2
    );
    // Its output loads back as a plain image (add-base-image intent).
    expect(spec.outputs.map((o) => o.type)).toEqual(['image']);
  });

  it('carries numeric constraints + default on an int param', () => {
    const radius = specByName['median-filter'].parameters.find(
      (p) => p.id === 'radius'
    );
    expect(radius).toMatchObject({
      kind: 'int',
      min: 1,
      max: 10,
      step: 1,
      default: 1,
    });
  });

  it('models float params (double in Slicer XML)', () => {
    const lower = specByName['threshold-segmentation'].parameters.find(
      (p) => p.id === 'lowerThreshold'
    );
    expect(lower).toMatchObject({ kind: 'float', default: 50 });
  });

  it('models a bounds field and an enum field with UI hints', () => {
    const spec = specByName['synthetic-bounds-enum'];
    const roi = spec.parameters.find((p) => p.id === 'roi');
    const method = spec.parameters.find((p) => p.id === 'method');
    expect(roi).toMatchObject({
      kind: 'bounds',
      section: 'Region and options',
    });
    expect(method).toMatchObject({
      kind: 'enum',
      options: ['otsu', 'kmeans', 'manual'],
      default: 'otsu',
      order: 2,
    });
  });

  it('declares outputs with a semantic type tag', () => {
    const outputs = specByName['otsu-segmentation'].outputs;
    expect(outputs.map((o) => o.type)).toEqual(['labelmap', 'file']);
  });

  it('accepts the optional `widget` renderer-override hint', () => {
    // `widget` has no Slicer-XML source so no golden fixture sets it; this pins
    // that the schema still accepts it (the renderer picks a default from
    // `kind` when it is absent).
    const parsed = taskParameterSchema.parse({
      kind: 'int',
      id: 'radius',
      title: 'Radius',
      widget: 'slider',
      min: 0,
      max: 10,
      default: 5,
    });
    expect(parsed).toMatchObject({ widget: 'slider' });
  });
});

// ---------------------------------------------------------------------------
// Negative fixtures — must FAIL validation (fail closed).
// ---------------------------------------------------------------------------

describe('task-spec negative fixtures fail validation', () => {
  it('rejects an unknown field kind', () => {
    const data = loadFixture('negative/unknown-field-kind.json');
    const result = taskSpecSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('rejects a constraint violation (default above max)', () => {
    const data = loadFixture('negative/constraint-violation.json');
    const result = taskSpecSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it('detects the unknown kind at the parameter level (Chunk 7 fail-closed-hide)', () => {
    // The whole spec is rejected above, but an individual param parse also
    // fails on the unknown kind — so the engine can hide that one param rather
    // than reject the whole spec.
    const badParam = { kind: 'color', id: 'tint', default: '#ff0000' };
    expect(taskParameterSchema.safeParse(badParam).success).toBe(false);
  });
});

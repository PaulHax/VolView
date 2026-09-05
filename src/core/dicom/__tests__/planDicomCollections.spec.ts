import { describe, it, expect } from 'vitest';
import {
  HARD_FACT_RULES,
  ORIENTATION_RULE,
  ORIENTATION_TOLERANCE,
  planDicomCollections,
  validateCollections,
} from '@/src/core/dicom/planDicomCollections';
import type {
  DicomCollection,
  InstanceFacts,
} from '@/src/core/dicom/planDicomCollections';
import {
  IDENTITY_ORIENTATION,
  clone,
  makeFacts,
  orientationKeyValue,
  tiltedOrientation,
} from '@/src/core/dicom/__tests__/instanceFactsFixture';

const SERIES_KEY = 'series-1';

const plan = (instances: InstanceFacts[], seriesKey = SERIES_KEY) =>
  planDicomCollections({ seriesKey, instances });

const uidsOf = (collection: DicomCollection) =>
  collection.members.map((m) => m.sopInstanceUid);

function collectionWith(collections: DicomCollection[], uid: string) {
  const found = collections.find((c) =>
    c.members.some((m) => m.sopInstanceUid === uid)
  );
  if (!found) throw new Error(`no collection holds ${uid}`);
  return found;
}

const partValue = (collection: DicomCollection, rule: string) => {
  const part = collection.key.parts.find(([name]) => name === rule);
  if (!part) throw new Error(`no key part named ${rule}`);
  return part[1];
};

const mentions = (diagnostics: string[], needle: string) =>
  diagnostics.some((d) => d.includes(needle));

// Second orientation row rotations, measured against the dot-product tolerance.
const WITHIN = Math.acos(1 - ORIENTATION_TOLERANCE / 2);
const BEYOND = Math.acos(1 - ORIENTATION_TOLERANCE * 2);
// cos(CHAIN) is inside the tolerance while cos(2 * CHAIN) is outside it.
const CHAIN = Math.sqrt(ORIENTATION_TOLERANCE);

describe('planDicomCollections', () => {
  it('plans nothing for an empty instance list', () => {
    expect(plan([])).toEqual({ collections: [] });
  });

  it('keeps one consistent series in a single collection', () => {
    const a = makeFacts('uid-a', { projectedPosition: 0, instanceNumber: 1 });
    const b = makeFacts('uid-b', { projectedPosition: 1, instanceNumber: 2 });

    const { collections } = plan([a, b]);

    expect(collections).toHaveLength(1);
    expect(collections[0].key.seriesKey).toBe(SERIES_KEY);
    expect(collections[0].members[0]).toBe(a);
    expect(collections[0].members[1]).toBe(b);
    expect(collections[0].order).toBe('spatial');
    expect(collections[0].diagnostics).toEqual([]);
  });

  it('names the hard facts then orientation, in a fixed key order', () => {
    const { collections } = plan([makeFacts('uid-a')]);

    expect(collections[0].key.parts.map(([rule]) => rule)).toEqual([
      ...HARD_FACT_RULES,
      ORIENTATION_RULE,
    ]);
    expect(collections[0].key.parts).toEqual([
      ['seriesNumber', '1'],
      ['sequenceName', null],
      ['sliceThickness', '1'],
      ['seriesDate', '20240101'],
      ['rows', '4'],
      ['columns', '4'],
      ['samplesPerPixel', '1'],
      ['numberOfFrames', null],
      ['orientation', orientationKeyValue(IDENTITY_ORIENTATION)],
    ]);
  });

  const differingFacts: Array<[string, Partial<InstanceFacts>, string]> = [
    ['seriesNumber', { seriesNumber: '2' }, '2'],
    ['sequenceName', { sequenceName: 'SEQ' }, 'SEQ'],
    ['sliceThickness', { sliceThickness: '5' }, '5'],
    ['seriesDate', { seriesDate: '20240102' }, '20240102'],
    ['rows', { rows: '8' }, '8'],
    ['columns', { columns: '8' }, '8'],
    ['samplesPerPixel', { samplesPerPixel: '3' }, '3'],
    ['numberOfFrames', { numberOfFrames: '2' }, '2'],
  ];

  it.each(differingFacts)(
    'partitions on a differing %s',
    (rule, overrides, expected) => {
      const a = makeFacts('uid-a');
      const b = makeFacts('uid-b', overrides);

      const { collections } = plan([a, b]);

      expect(collections).toHaveLength(2);
      expect(uidsOf(collectionWith(collections, 'uid-a'))).toEqual(['uid-a']);
      expect(uidsOf(collectionWith(collections, 'uid-b'))).toEqual(['uid-b']);
      expect(partValue(collectionWith(collections, 'uid-b'), rule)).toBe(
        expected
      );
    }
  );

  const missingFacts: Array<
    [string, Partial<InstanceFacts>, Partial<InstanceFacts>]
  > = [
    ['seriesNumber', { seriesNumber: '1' }, { seriesNumber: null }],
    ['sequenceName', { sequenceName: 'SEQ' }, { sequenceName: null }],
    ['sliceThickness', { sliceThickness: '1' }, { sliceThickness: null }],
    ['seriesDate', { seriesDate: '20240101' }, { seriesDate: null }],
    ['rows', { rows: '4' }, { rows: null }],
    ['columns', { columns: '4' }, { columns: null }],
    ['samplesPerPixel', { samplesPerPixel: '1' }, { samplesPerPixel: null }],
    ['numberOfFrames', { numberOfFrames: '2' }, { numberOfFrames: null }],
  ];

  it.each(missingFacts)(
    'buckets a missing %s on its own',
    (rule, present, absent) => {
      const a = makeFacts('uid-a', present);
      const b = makeFacts('uid-b', absent);

      const { collections } = plan([a, b]);

      expect(collections).toHaveLength(2);
      expect(partValue(collectionWith(collections, 'uid-b'), rule)).toBeNull();
      expect(
        partValue(collectionWith(collections, 'uid-a'), rule)
      ).not.toBeNull();
    }
  );

  it('does not partition on pixel spacing, position or instance number', () => {
    const a = makeFacts('uid-a', {
      pixelSpacing: [1, 1],
      position: [0, 0, 0],
      projectedPosition: 0,
      instanceNumber: 1,
    });
    const b = makeFacts('uid-b', {
      pixelSpacing: [0.5, 0.75],
      position: [0, 0, 3],
      projectedPosition: 3,
      instanceNumber: 9,
    });

    const { collections } = plan([a, b]);

    expect(collections).toHaveLength(1);
    expect(uidsOf(collections[0])).toEqual(['uid-a', 'uid-b']);
  });

  it('keys on the given series key, not the instances own series UID', () => {
    const a = makeFacts('uid-a', { seriesInstanceUid: 'somewhere-else' });

    const { collections } = plan([a], 'series-9');

    expect(collections[0].key.seriesKey).toBe('series-9');
  });

  it('buckets orientations whose rows agree within the tolerance', () => {
    const a = makeFacts('uid-a', { orientation: IDENTITY_ORIENTATION });
    const b = makeFacts('uid-b', { orientation: tiltedOrientation(WITHIN) });

    const { collections } = plan([a, b]);

    expect(collections).toHaveLength(1);
    expect(uidsOf(collections[0])).toEqual(['uid-a', 'uid-b']);
  });

  it('splits orientations whose rows disagree beyond the tolerance', () => {
    const a = makeFacts('uid-a', { orientation: IDENTITY_ORIENTATION });
    const b = makeFacts('uid-b', { orientation: tiltedOrientation(BEYOND) });

    const { collections } = plan([a, b]);

    expect(collections).toHaveLength(2);
    expect(
      partValue(collectionWith(collections, 'uid-b'), ORIENTATION_RULE)
    ).toBe(orientationKeyValue(tiltedOrientation(BEYOND)));
  });

  it('buckets identical cosines that are slightly over normalized', () => {
    const overNormalized = [1.0001, 0, 0, 0, 1, 0];
    const a = makeFacts('uid-a', { orientation: overNormalized });
    const b = makeFacts('uid-b', { orientation: overNormalized });

    const { collections } = plan([a, b]);

    expect(collections).toHaveLength(1);
    expect(uidsOf(collections[0])).toEqual(['uid-a', 'uid-b']);
    expect(partValue(collections[0], ORIENTATION_RULE)).toBe(
      orientationKeyValue(overNormalized)
    );
  });

  it('buckets a chain of near orientations the same way under permutation', () => {
    const a = makeFacts('uid-a', { orientation: IDENTITY_ORIENTATION });
    const b = makeFacts('uid-b', { orientation: tiltedOrientation(CHAIN) });
    const c = makeFacts('uid-c', { orientation: tiltedOrientation(2 * CHAIN) });

    const forward = plan([a, b, c]);
    const backward = plan([c, b, a]);
    const shuffled = plan([b, c, a]);

    expect(forward.collections).toHaveLength(2);
    expect(uidsOf(collectionWith(forward.collections, 'uid-a'))).toEqual([
      'uid-a',
      'uid-b',
    ]);
    expect(uidsOf(collectionWith(forward.collections, 'uid-c'))).toEqual([
      'uid-c',
    ]);
    expect(backward).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it('buckets a chain of anonymous near orientations the same under permutation', () => {
    const anonymousChain = () => [
      makeFacts(null, {
        orientation: IDENTITY_ORIENTATION,
        projectedPosition: 0,
      }),
      makeFacts(null, {
        orientation: tiltedOrientation(CHAIN),
        projectedPosition: 1,
      }),
      makeFacts(null, {
        orientation: tiltedOrientation(2 * CHAIN),
        projectedPosition: 2,
      }),
    ];

    const [x, y, z] = anonymousChain();
    const forward = plan([x, y, z]);

    expect(forward.collections.map((c) => c.members.length)).toEqual([2, 1]);
    expect(plan([z, y, x])).toEqual(forward);
    expect(plan([y, x, z])).toEqual(forward);
  });

  it('takes the orientation key from the smallest SOP UID, not the first input', () => {
    const late = makeFacts('uid-z', { orientation: IDENTITY_ORIENTATION });
    const early = makeFacts('uid-a', {
      orientation: tiltedOrientation(WITHIN),
    });

    const { collections } = plan([late, early]);

    expect(collections).toHaveLength(1);
    expect(partValue(collections[0], ORIENTATION_RULE)).toBe(
      orientationKeyValue(tiltedOrientation(WITHIN))
    );
  });

  it('never represents a bucket with an instance that has no SOP UID', () => {
    const anonymous = makeFacts(null, { orientation: IDENTITY_ORIENTATION });
    const identified = makeFacts('uid-z', {
      orientation: tiltedOrientation(WITHIN),
    });

    const { collections } = plan([anonymous, identified]);

    expect(collections).toHaveLength(1);
    expect(partValue(collections[0], ORIENTATION_RULE)).toBe(
      orientationKeyValue(tiltedOrientation(WITHIN))
    );
  });

  it('buckets an unreadable orientation on its own and diagnoses it', () => {
    const a = makeFacts('uid-a');
    const b = makeFacts('uid-b', { orientation: null });

    const { collections } = plan([a, b]);

    expect(collections).toHaveLength(2);
    const orphan = collectionWith(collections, 'uid-b');
    expect(partValue(orphan, ORIENTATION_RULE)).toBeNull();
    expect(mentions(orphan.diagnostics, 'uid-b')).toBe(true);
  });

  it('deduplicates by SOP Instance UID, keeping the last occurrence', () => {
    const stale = makeFacts('uid-a', { instanceNumber: 1 });
    const fresh = makeFacts('uid-a', { instanceNumber: 7 });

    const { collections } = plan([stale, fresh]);

    expect(collections).toHaveLength(1);
    expect(collections[0].members).toHaveLength(1);
    expect(collections[0].members[0]).toBe(fresh);
    expect(mentions(collections[0].diagnostics, 'uid-a')).toBe(true);
  });

  it('never merges instances that have no SOP Instance UID', () => {
    const a = makeFacts(null, { projectedPosition: 0, instanceNumber: 1 });
    const b = makeFacts(null, { projectedPosition: 1, instanceNumber: 2 });

    const { collections } = plan([a, b]);

    expect(collections).toHaveLength(1);
    expect(collections[0].members).toHaveLength(2);
  });

  it('keeps both entries when one anonymous instance is listed twice', () => {
    const shared = makeFacts(null);

    const { collections } = plan([shared, shared]);

    expect(collections).toHaveLength(1);
    expect(collections[0].members).toEqual([shared, shared]);
  });

  it('orders members by projected position ascending', () => {
    const high = makeFacts('uid-a', { projectedPosition: 10 });
    const low = makeFacts('uid-b', { projectedPosition: -5 });
    const mid = makeFacts('uid-c', { projectedPosition: 0 });

    const { collections } = plan([high, low, mid]);

    expect(uidsOf(collections[0])).toEqual(['uid-b', 'uid-c', 'uid-a']);
    expect(collections[0].order).toBe('spatial');
    expect(collections[0].diagnostics).toEqual([]);
  });

  it('breaks a shared projected position on SOP Instance UID', () => {
    const second = makeFacts('uid-b', { projectedPosition: 3 });
    const first = makeFacts('uid-a', { projectedPosition: 3 });

    const { collections } = plan([second, first]);

    expect(uidsOf(collections[0])).toEqual(['uid-a', 'uid-b']);
    expect(collections[0].order).toBe('spatial');
  });

  it('breaks a shared position between anonymous members on content', () => {
    const anonymousPair = () => [
      makeFacts(null, { projectedPosition: 0, instanceNumber: 1 }),
      makeFacts(null, { projectedPosition: 0, instanceNumber: 2 }),
    ];

    const [a, b] = anonymousPair();
    const forward = plan([a, b]);

    expect(forward.collections[0].members.map((m) => m.instanceNumber)).toEqual(
      [1, 2]
    );
    expect(plan([b, a])).toEqual(forward);
  });

  it('breaks an anonymous tie on facts outside the ordering keys', () => {
    const anonymousPair = () => [
      makeFacts(null, { position: [0, 0, 0] }),
      makeFacts(null, { position: [9, 9, 9] }),
    ];

    const [a, b] = anonymousPair();
    const forward = plan([a, b]);

    expect(forward.collections[0].members.map((m) => m.position)).toEqual([
      [0, 0, 0],
      [9, 9, 9],
    ]);
    expect(plan([b, a])).toEqual(forward);
  });

  it('falls back to instance number when a position is unreadable', () => {
    const blind = makeFacts('uid-a', {
      projectedPosition: null,
      instanceNumber: 3,
    });
    const seen = makeFacts('uid-b', {
      projectedPosition: 2,
      instanceNumber: 1,
    });

    const { collections } = plan([blind, seen]);

    expect(collections).toHaveLength(1);
    expect(uidsOf(collections[0])).toEqual(['uid-b', 'uid-a']);
    expect(collections[0].order).toBe('instance-number');
    expect(mentions(collections[0].diagnostics, 'uid-a')).toBe(true);
  });

  it('breaks a shared instance number on SOP Instance UID', () => {
    const second = makeFacts('uid-b', {
      projectedPosition: null,
      instanceNumber: 4,
    });
    const first = makeFacts('uid-a', {
      projectedPosition: null,
      instanceNumber: 4,
    });

    const { collections } = plan([second, first]);

    expect(uidsOf(collections[0])).toEqual(['uid-a', 'uid-b']);
    expect(collections[0].order).toBe('instance-number');
  });

  it('records input order when neither position nor instance number reads', () => {
    const second = makeFacts('uid-b', {
      projectedPosition: null,
      instanceNumber: null,
    });
    const first = makeFacts('uid-a', {
      projectedPosition: null,
      instanceNumber: null,
    });

    const { collections } = plan([second, first]);

    expect(uidsOf(collections[0])).toEqual(['uid-b', 'uid-a']);
    expect(collections[0].order).toBe('input');
    expect(mentions(collections[0].diagnostics, 'uid-a')).toBe(true);
    expect(mentions(collections[0].diagnostics, 'uid-b')).toBe(true);
  });

  const permutable = () => [
    makeFacts('uid-1', { projectedPosition: 2, instanceNumber: 2 }),
    makeFacts('uid-2', { projectedPosition: 1, instanceNumber: 1 }),
    makeFacts('uid-3', {
      projectedPosition: 0,
      instanceNumber: 3,
      sliceThickness: '5',
    }),
    makeFacts('uid-4', {
      projectedPosition: 4,
      instanceNumber: 4,
      sliceThickness: '5',
    }),
    makeFacts('uid-5', {
      projectedPosition: 3,
      instanceNumber: 5,
      orientation: tiltedOrientation(BEYOND),
    }),
    makeFacts('uid-6', {
      projectedPosition: 5,
      instanceNumber: 6,
      orientation: tiltedOrientation(BEYOND),
    }),
  ];

  it('is invariant to input permutation in membership and order', () => {
    const base = plan(permutable());
    const reversed = plan(permutable().reverse());
    const rotated = (() => {
      const items = permutable();
      return plan([...items.slice(2), ...items.slice(0, 2)]);
    })();
    const interleaved = (() => {
      const items = permutable();
      return plan([items[5], items[0], items[3], items[1], items[4], items[2]]);
    })();

    expect(base.collections).toHaveLength(3);
    expect(reversed).toEqual(base);
    expect(rotated).toEqual(base);
    expect(interleaved).toEqual(base);
  });

  it('does not mutate the instances it is given', () => {
    const instances = permutable();
    const before = clone(instances);

    plan(instances);

    expect(clone(instances)).toEqual(before);
  });

  it('holds every instance exactly once across the collections', () => {
    const instances = permutable();

    const { collections } = plan(instances);
    const members = collections.flatMap((c) => c.members);

    expect(members).toHaveLength(instances.length);
    expect(new Set(members).size).toBe(instances.length);
    instances.forEach((instance) => expect(members).toContain(instance));
    expect(() => validateCollections(instances, collections)).not.toThrow();
  });
});

describe('validateCollections', () => {
  const a = makeFacts('uid-a');
  const b = makeFacts('uid-b');

  const collectionOf = (
    members: InstanceFacts[],
    parts: Array<[string, string | null]>
  ): DicomCollection => ({
    key: { seriesKey: SERIES_KEY, parts },
    members,
    order: 'input',
    diagnostics: [],
  });

  const partsOne: Array<[string, string | null]> = [['orientation', 'one']];
  const partsTwo: Array<[string, string | null]> = [['orientation', 'two']];

  it('accepts a conserving, collision-free plan', () => {
    expect(() =>
      validateCollections(
        [a, b],
        [collectionOf([a], partsOne), collectionOf([b], partsTwo)]
      )
    ).not.toThrow();
  });

  it('rejects an instance that landed in no collection', () => {
    expect(() =>
      validateCollections([a, b], [collectionOf([a], partsOne)])
    ).toThrow('uid-b');
  });

  it('rejects an instance that landed in two collections', () => {
    expect(() =>
      validateCollections(
        [a],
        [collectionOf([a], partsOne), collectionOf([a], partsTwo)]
      )
    ).toThrow('uid-a');
  });

  it('accepts an instance listed twice when it is placed twice', () => {
    expect(() =>
      validateCollections([a, a], [collectionOf([a, a], partsOne)])
    ).not.toThrow();
  });

  it('rejects an instance listed twice but placed once', () => {
    expect(() =>
      validateCollections([a, a], [collectionOf([a], partsOne)])
    ).toThrow('uid-a');
  });

  it('rejects a member that was never one of the instances', () => {
    expect(() =>
      validateCollections([a], [collectionOf([a, b], partsOne)])
    ).toThrow('uid-b');
  });

  it('rejects two collections sharing a key', () => {
    expect(() =>
      validateCollections(
        [a, b],
        [collectionOf([a], partsOne), collectionOf([b], partsOne)]
      )
    ).toThrow(/key/i);
  });
});

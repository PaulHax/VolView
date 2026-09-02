import { describe, it, expect } from 'vitest';
import {
  assignIds,
  encodeCollectionKey,
} from '@/src/core/dicom/assignCollectionIds';
import type { CommittedCollection } from '@/src/core/dicom/assignCollectionIds';
import type {
  CollectionKey,
  DicomCollection,
} from '@/src/core/dicom/planDicomCollections';
import {
  clone,
  makeFacts,
} from '@/src/core/dicom/__tests__/instanceFactsFixture';

const SERIES_KEY = 'series-1';

const keyOf = (orientation: string): CollectionKey => ({
  seriesKey: SERIES_KEY,
  parts: [
    ['seriesNumber', '1'],
    ['sliceThickness', '1'],
    ['orientation', orientation],
  ],
});

const collectionOf = (
  uids: Array<string | null>,
  key = keyOf('1,0,0,0,1,0')
): DicomCollection => ({
  key,
  members: uids.map((uid) => makeFacts(uid)),
  order: 'spatial',
  diagnostics: [],
});

const planOf = (...collections: DicomCollection[]) => ({ collections });

const idsOf = (collections: Array<{ id: string }>) =>
  collections.map((c) => c.id);

describe('encodeCollectionKey', () => {
  it('encodes equal keys identically', () => {
    expect(encodeCollectionKey(keyOf('1,0,0,0,1,0'))).toBe(
      encodeCollectionKey(keyOf('1,0,0,0,1,0'))
    );
  });

  it.each(['|', '/', ':', ',', '\\', '-', '.', ' ', '#'])(
    'escapes %s so a shifted separator changes the encoding',
    (separator) => {
      const left: CollectionKey = {
        seriesKey: SERIES_KEY,
        parts: [
          ['rows', `x${separator}y`],
          ['columns', 'z'],
        ],
      };
      const right: CollectionKey = {
        seriesKey: SERIES_KEY,
        parts: [
          ['rows', 'x'],
          ['columns', `y${separator}z`],
        ],
      };

      expect(encodeCollectionKey(left)).not.toBe(encodeCollectionKey(right));
    }
  );

  it('separates a missing value from the literal strings for it', () => {
    const missing: CollectionKey = {
      seriesKey: SERIES_KEY,
      parts: [['rows', null]],
    };
    const literalNull: CollectionKey = {
      seriesKey: SERIES_KEY,
      parts: [['rows', 'null']],
    };
    const empty: CollectionKey = {
      seriesKey: SERIES_KEY,
      parts: [['rows', '']],
    };

    const encodings = [missing, literalNull, empty].map(encodeCollectionKey);

    expect(new Set(encodings).size).toBe(3);
  });

  it('separates keys differing only in series key or rule name', () => {
    const base: CollectionKey = {
      seriesKey: 'series-1',
      parts: [['rows', '4']],
    };
    const otherSeries: CollectionKey = {
      seriesKey: 'series-2',
      parts: [['rows', '4']],
    };
    const otherRule: CollectionKey = {
      seriesKey: 'series-1',
      parts: [['columns', '4']],
    };

    const encodings = [base, otherSeries, otherRule].map(encodeCollectionKey);

    expect(new Set(encodings).size).toBe(3);
  });
});

describe('assignIds', () => {
  it('mints the encoded key when nothing is committed', () => {
    const collection = collectionOf(['a', 'b']);

    const { collections } = assignIds(planOf(collection), []);

    expect(collections[0].id).toBe(encodeCollectionKey(collection.key));
  });

  it('gives distinct collections distinct ids', () => {
    const first = collectionOf(['a'], keyOf('1,0,0,0,1,0'));
    const second = collectionOf(['b'], keyOf('0,1,0,0,0,1'));

    const { collections } = assignIds(planOf(first, second), []);

    expect(new Set(idsOf(collections)).size).toBe(2);
  });

  it('keeps the committed id when key and members are unchanged', () => {
    const collection = collectionOf(['a', 'b']);
    const committed: CommittedCollection[] = [
      { id: 'visible-1', sopInstanceUids: ['a', 'b'] },
    ];

    const { collections } = assignIds(planOf(collection), committed);

    expect(collections[0].id).toBe('visible-1');
  });

  it('keeps the committed id when the key changed but the members did not', () => {
    const collection = collectionOf(['a', 'b', 'c'], keyOf('0.9999,0,0,0,1,0'));
    const committed: CommittedCollection[] = [
      { id: 'visible-1', sopInstanceUids: ['a', 'b', 'c'] },
    ];

    const { collections } = assignIds(planOf(collection), committed);

    expect(collections[0].id).toBe('visible-1');
  });

  it('gives a committed id to the collection holding most of its members', () => {
    const majority = collectionOf(['a', 'b', 'c'], keyOf('1,0,0,0,1,0'));
    const remainder = collectionOf(['d'], keyOf('0,1,0,0,0,1'));
    const committed: CommittedCollection[] = [
      { id: 'visible-1', sopInstanceUids: ['a', 'b', 'c', 'd'] },
    ];

    const { collections } = assignIds(planOf(majority, remainder), committed);

    expect(collections[0].id).toBe('visible-1');
    expect(collections[1].id).not.toBe('visible-1');
  });

  it('mints for both halves of an evenly split committed collection', () => {
    const left = collectionOf(['a', 'b'], keyOf('1,0,0,0,1,0'));
    const right = collectionOf(['c', 'd'], keyOf('0,1,0,0,0,1'));
    const committed: CommittedCollection[] = [
      { id: 'visible-1', sopInstanceUids: ['a', 'b', 'c', 'd'] },
    ];

    const { collections } = assignIds(planOf(left, right), committed);

    expect(idsOf(collections)).not.toContain('visible-1');
    expect(new Set(idsOf(collections)).size).toBe(2);
  });

  it('mints when nothing overlaps, without reusing a committed id', () => {
    const collection = collectionOf(['a']);
    const committed: CommittedCollection[] = [
      { id: 'visible-1', sopInstanceUids: ['x', 'y'] },
    ];

    const { collections } = assignIds(planOf(collection), committed);

    expect(collections[0].id).not.toBe('visible-1');
    expect(collections[0].id).toBe(encodeCollectionKey(collection.key));
  });

  it('never mints an id already taken by a committed collection', () => {
    const collection = collectionOf(['a']);
    const committed: CommittedCollection[] = [
      {
        id: encodeCollectionKey(collection.key),
        sopInstanceUids: ['x'],
      },
    ];

    const { collections } = assignIds(planOf(collection), committed);

    expect(collections[0].id).not.toBe(committed[0].id);
  });

  it('prefers the committed collection it overlaps most', () => {
    const collection = collectionOf(['a', 'b', 'c', 'd', 'e']);
    const committed: CommittedCollection[] = [
      { id: 'small', sopInstanceUids: ['a', 'b'] },
      { id: 'large', sopInstanceUids: ['c', 'd', 'e'] },
    ];

    const { collections } = assignIds(planOf(collection), committed);

    expect(collections[0].id).toBe('large');
  });

  it('breaks an equal overlap on the smallest committed id', () => {
    const collection = collectionOf(['a', 'b', 'c', 'd']);
    const committed: CommittedCollection[] = [
      { id: 'zeta', sopInstanceUids: ['a', 'b'] },
      { id: 'alpha', sopInstanceUids: ['c', 'd'] },
    ];

    const { collections } = assignIds(planOf(collection), committed);

    expect(collections[0].id).toBe('alpha');
  });

  it('measures overlap only on members that have a SOP Instance UID', () => {
    const collection = collectionOf([null, 'a']);
    const committed: CommittedCollection[] = [
      { id: 'visible-1', sopInstanceUids: ['a'] },
    ];

    const { collections } = assignIds(planOf(collection), committed);

    expect(collections[0].id).toBe('visible-1');
  });

  it('mints for a collection whose members all lack a SOP Instance UID', () => {
    const collection = collectionOf([null, null]);
    const committed: CommittedCollection[] = [
      { id: 'visible-1', sopInstanceUids: ['a'] },
    ];

    const { collections } = assignIds(planOf(collection), committed);

    expect(collections[0].id).not.toBe('visible-1');
  });

  it('carries the planned collections through in order, only adding an id', () => {
    const first = collectionOf(['a'], keyOf('1,0,0,0,1,0'));
    const second: DicomCollection = {
      ...collectionOf(['b'], keyOf('0,1,0,0,0,1')),
      order: 'instance-number',
      diagnostics: ['b has no position'],
    };

    const { collections } = assignIds(planOf(first, second), []);

    expect(collections).toHaveLength(2);
    expect(collections[0].key).toEqual(first.key);
    expect(collections[0].members).toEqual(first.members);
    expect(collections[1].order).toBe('instance-number');
    expect(collections[1].diagnostics).toEqual(['b has no position']);
    expect(collections[1].members[0]).toBe(second.members[0]);
  });

  it('does not mutate the plan or the committed collections', () => {
    const plan = planOf(
      collectionOf(['a', 'b'], keyOf('1,0,0,0,1,0')),
      collectionOf(['c'], keyOf('0,1,0,0,0,1'))
    );
    const committed: CommittedCollection[] = [
      { id: 'visible-1', sopInstanceUids: ['a', 'b'] },
    ];
    const planBefore = clone(plan);
    const committedBefore = clone(committed);

    assignIds(plan, committed);

    expect(clone(plan)).toEqual(planBefore);
    expect(clone(committed)).toEqual(committedBefore);
  });
});

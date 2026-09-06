import dcmjs, { DicomDataElement, DicomElement, DicomReadStream } from 'dcmjs';

const { encodingMapping } = dcmjs.constants;
const {
  DicomMessage,
  DicomMetaDictionary,
  ReadBufferStream,
  DeflatedReadBufferStream,
} = dcmjs.data;

const PREAMBLE_LENGTH = 128;
const MAGIC = 'DICM';
const FILE_META_GROUP_LENGTH = '00020000';
const TRANSFER_SYNTAX_UID = '00020010';
const PIXEL_DATA = '7FE00010';
const IMPLICIT_VR_LITTLE_ENDIAN = '1.2.840.10008.1.2';
const EXPLICIT_VR_LITTLE_ENDIAN = '1.2.840.10008.1.2.1';
const EXPLICIT_VR_BIG_ENDIAN = '1.2.840.10008.1.2.2';
const DEFLATED_EXPLICIT_VR_LITTLE_ENDIAN = '1.2.840.10008.1.2.1.99';
const RESERVED_LENGTH = 2;
const UNDEFINED_LENGTH = 0xffffffff;

/** VRs whose explicit form carries two reserved bytes and a 32 bit length. */
const LENGTH_32_VRS = new Set([
  'OB',
  'OD',
  'OF',
  'OL',
  'OV',
  'OW',
  'SQ',
  'SV',
  'UC',
  'UN',
  'UR',
  'UT',
]);

/** Bound on one `String.fromCharCode` spread, which is an argument list. */
const SPREAD_LIMIT = 4096;

/** A byte string holds one code unit per byte, which `toBytes` reverses. */
export const binaryString = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += SPREAD_LIMIT)
    text += String.fromCharCode(...bytes.subarray(i, i + SPREAD_LIMIT));
  return text;
};

export const toBytes = (raw: string) =>
  Uint8Array.from(raw, (char) => char.charCodeAt(0) & 0xff);

/** DICOM character set name to `TextDecoder` label, as dcmjs tabulates it. */
export const encodingLabel = (name: string) =>
  encodingMapping[name.trim().replace(/[_ ]/g, '-').toLowerCase()];

/**
 * One value as the file wrote it. A text VR is a byte string, so the Specific
 * Character Set can be applied once the whole data set is known.
 */
export type ParsedValue = string | number | Uint8Array;

/** One element, with no dcmjs object left in it. */
export type ParsedElement = {
  group: number;
  element: number;
  vr: string;
  values: ParsedValue[];
  /** Items of a sequence, each a list of elements. */
  items?: ParsedElement[][];
  /** Set when the element's header was read but its value was not. */
  unread?: { bytes: Uint8Array; reason: string };
};

/**
 * Keeps one code unit per byte so the Specific Character Set can be applied
 * once the whole data set is read. dcmjs otherwise picks a single decoder from
 * character set value 1, which is the default repertoire rather than the
 * extension that covers the non-ASCII characters.
 */
const byteDecoder = {
  decode: (view: ArrayBufferView) =>
    binaryString(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
};

/**
 * dcmjs reads a sequence item from a stream of its own, whose decoder defaults
 * to windows-1252 and which its item reader replaces with one of its own when
 * the item declares a character set. Both lose the bytes a data set wide
 * character set needs, so every derived stream keeps the byte decoder.
 */
const readsBytes = (stream: DicomReadStream) => {
  stream.setDecoder(byteDecoder);
  const derive = stream.more.bind(stream);
  stream.more = (length: number) => readsBytes(derive(length));
  stream.setDecoder = () => {};
  return stream;
};

const viewBytes = (value: unknown) => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
};

const hex4 = (value: number) =>
  value.toString(16).padStart(4, '0').toUpperCase();

const dictionaryVr = (group: number, element: number) =>
  DicomMetaDictionary.dictionary[`(${hex4(group)},${hex4(element)})`]?.vr;

/** dcmjs reads from an ArrayBuffer, which a whole-buffer view already is. */
const bufferOf = (bytes: Uint8Array) =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);

const openFile = (bytes: Uint8Array) => {
  if (bytes.byteLength <= PREAMBLE_LENGTH + MAGIC.length)
    throw new Error('Not a DICOM file: too short to hold a preamble');

  const stream = new ReadBufferStream(bufferOf(bytes));
  stream.reset();
  stream.increment(PREAMBLE_LENGTH);
  if (stream.readAsciiString(MAGIC.length) !== MAGIC)
    throw new Error('Not a DICOM file: the DICM prefix is missing');

  const groupLength = DicomMessage._readTag(stream, EXPLICIT_VR_LITTLE_ENDIAN);
  if (groupLength.tag.toCleanString() !== FILE_META_GROUP_LENGTH)
    throw new Error('Not a DICOM file: the file meta group length is missing');

  const [metaLength] = groupLength.values as number[];
  const meta = DicomMessage._read(
    stream.more(metaLength),
    EXPLICIT_VR_LITTLE_ENDIAN
  );
  const syntax = meta[TRANSFER_SYNTAX_UID]?.Value[0];
  if (typeof syntax !== 'string')
    throw new Error('Not a DICOM file: the transfer syntax is missing');

  const dataSet =
    syntax === DEFLATED_EXPLICIT_VR_LITTLE_ENDIAN
      ? new DeflatedReadBufferStream(stream)
      : stream;
  return {
    dataSet: readsBytes(dataSet),
    syntax: DicomMessage._normalizeSyntax(syntax),
  };
};

/**
 * Where a defined length sequence's value starts and ends, or null when the
 * next element is not one. Reading items can fail on a nested element whose VR
 * differs from the dictionary, and only a defined length can be stepped over.
 */
const peekSequence = (dataSet: DicomReadStream, syntax: string) => {
  const start = dataSet.offset;
  const implicit = syntax === IMPLICIT_VR_LITTLE_ENDIAN;
  dataSet.setEndian(syntax !== EXPLICIT_VR_BIG_ENDIAN);
  const group = dataSet.readUint16();
  const element = dataSet.readUint16();
  const vr = implicit ? dictionaryVr(group, element) : dataSet.readVR();
  const length32 = implicit || LENGTH_32_VRS.has(vr ?? '');
  if (length32 && !implicit) dataSet.increment(RESERVED_LENGTH);
  const length = length32 ? dataSet.readUint32() : dataSet.readUint16();
  const valueStart = dataSet.offset;
  dataSet.offset = start;
  return vr === 'SQ' && length !== UNDEFINED_LENGTH
    ? { group, element, valueStart, end: valueStart + length }
    : null;
};

/**
 * dcmjs drops the trailing byte that padded a value to an even length, which
 * the file wrote. A UI's pad is a null byte and carries no value, so only the
 * space that pads a text VR is put back.
 */
const restorePadByte = (vr: string, values: string[]) => {
  const byteLength = values.reduce(
    (total, value) => total + value.length,
    values.length - 1
  );
  return vr !== 'UI' && byteLength % 2 === 1
    ? values.map((value, index) =>
        index === values.length - 1 ? `${value} ` : value
      )
    : values;
};

const rawValuesOf = (rawValues: unknown) => {
  if (rawValues == null) return [];
  return Array.isArray(rawValues) ? (rawValues as unknown[]) : [rawValues];
};

const parsedValues = (vr: string, rawValues: unknown): ParsedValue[] => {
  const values = rawValuesOf(rawValues);
  if (values.every((value): value is string => typeof value === 'string'))
    return restorePadByte(vr, values);
  return values.map((value) => {
    const bytes = viewBytes(value);
    if (bytes) return bytes;
    return typeof value === 'number' ? value : String(value);
  });
};

const groupOf = (tag: string) => Number.parseInt(tag.slice(0, 4), 16);
const elementOf = (tag: string) => Number.parseInt(tag.slice(4), 16);

/**
 * dcmjs returns a sequence item as a dictionary keyed by tag, so a duplicate
 * tag in one item collapses and a tag whose eight hex digits read as an integer
 * sorts ahead of the rest.
 */
const itemElements = (
  item: Record<string, DicomDataElement | undefined>
): ParsedElement[] =>
  Object.entries(item).flatMap(([tag, data]) =>
    data == null ? [] : [dictElement(tag, data)]
  );

const dictElement = (tag: string, data: DicomDataElement): ParsedElement => ({
  group: groupOf(tag),
  element: elementOf(tag),
  vr: data.vr,
  values: data.vr === 'SQ' ? [] : parsedValues(data.vr, data._rawValue),
  ...(data.vr === 'SQ'
    ? {
        items: (
          data.Value as Array<Record<string, DicomDataElement | undefined>>
        ).map(itemElements),
      }
    : {}),
});

const parsedElement = (element: DicomElement): ParsedElement => {
  const tag = element.tag.toCleanString();
  const vr = element.vr === 0 ? '' : element.vr.type;
  return {
    group: groupOf(tag),
    element: elementOf(tag),
    vr,
    values: vr === 'SQ' ? [] : parsedValues(vr, element.rawValues),
    ...(vr === 'SQ'
      ? {
          items: (
            element.values as Array<
              Record<string, DicomDataElement | undefined>
            >
          ).map(itemElements),
        }
      : {}),
  };
};

const READ_OPTIONS = {
  untilTag: PIXEL_DATA,
  includeUntilTagValue: false,
  forceStoreRaw: true,
};

const readSequence = (
  dataSet: DicomReadStream,
  syntax: string,
  sequence: { group: number; element: number; valueStart: number; end: number }
): ParsedElement => {
  try {
    return parsedElement(DicomMessage._readTag(dataSet, syntax, READ_OPTIONS));
  } catch (error) {
    const bytes = new Uint8Array(
      dataSet.slice(sequence.valueStart, sequence.end)
    );
    dataSet.offset = sequence.end;
    return {
      group: sequence.group,
      element: sequence.element,
      vr: 'SQ',
      values: [],
      unread: { bytes, reason: String(error) },
    };
  }
};

const readElements = (dataSet: DicomReadStream, syntax: string) => {
  const elements: ParsedElement[] = [];
  let done = false;
  while (!done && !dataSet.end()) {
    const sequence = peekSequence(dataSet, syntax);
    if (sequence) {
      elements.push(readSequence(dataSet, syntax, sequence));
    } else {
      const element = DicomMessage._readTag(dataSet, syntax, READ_OPTIONS);
      done = element.tag.toCleanString() === PIXEL_DATA;
      if (!done && element.vr !== 0) elements.push(parsedElement(element));
    }
  }
  return elements;
};

/** Reads a Part 10 file's data set elements, stopping before Pixel Data. */
export const parseDicomElements = (bytes: Uint8Array) => {
  const { dataSet, syntax } = openFile(bytes);
  return readElements(dataSet, syntax);
};

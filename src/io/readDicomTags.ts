import dcmjs, { DicomReadStream } from 'dcmjs';

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
const SPECIFIC_CHARACTER_SET = '00080005';
const PIXEL_DATA = '7FE00010';
const IMPLICIT_VR_LITTLE_ENDIAN = '1.2.840.10008.1.2';
const EXPLICIT_VR_LITTLE_ENDIAN = '1.2.840.10008.1.2.1';
const EXPLICIT_VR_BIG_ENDIAN = '1.2.840.10008.1.2.2';
const DEFLATED_EXPLICIT_VR_LITTLE_ENDIAN = '1.2.840.10008.1.2.1.99';
const VALUE_DELIMITER = '\\';
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

/** VRs whose values are binary floats rather than text. */
const FLOAT_VRS = new Set(['FD', 'FL', 'OD', 'OF']);

/** Significant digits of a C++ `ostream`, which is what GDCM printed with. */
const FLOAT_PRECISION = 6;

/** Bound on one `String.fromCharCode` spread, which is an argument list. */
const SPREAD_LIMIT = 4096;

const binaryString = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += SPREAD_LIMIT)
    text += String.fromCharCode(...bytes.subarray(i, i + SPREAD_LIMIT));
  return text;
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

const viewBytes = (value: unknown) => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
};

const toBytes = (raw: string) =>
  Uint8Array.from(raw, (char) => char.charCodeAt(0) & 0xff);

const encodingLabel = (name: string) =>
  encodingMapping[name.trim().replace(/[_ ]/g, '-').toLowerCase()];

const tryDecode = (decoder: TextDecoder, bytes: Uint8Array) => {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
};

const ESCAPE_BYTE = 0x1b;

/** Bytes a conforming writer resets the repertoire before. */
const DELIMITER_BYTES = new Set([0x0a, 0x0c, 0x0d, 0x3d, 0x5c, 0x5e]);

/** A repertoire in force over one run of bytes. */
type Repertoire = {
  decode: (bytes: Uint8Array) => string;
  multibyte: boolean;
};

const highHalf = (bytes: Uint8Array) => bytes.map((byte) => byte | 0x80);

/** JIS X 0212 rides EUC-JP's third plane, one 0x8f before each high half pair. */
const jisX0212Bytes = (bytes: Uint8Array) =>
  Uint8Array.from(
    Array.from({ length: Math.floor(bytes.length / 2) }, (_, pair) => [
      0x8f,
      bytes[pair * 2] | 0x80,
      bytes[pair * 2 + 1] | 0x80,
    ]).flat()
  );

const repertoire = (
  label: string,
  {
    multibyte = false,
    mapBytes = (bytes: Uint8Array) => bytes,
  }: { multibyte?: boolean; mapBytes?: (bytes: Uint8Array) => Uint8Array } = {}
): Repertoire => {
  const decoder = new TextDecoder(label);
  return { decode: (bytes) => decoder.decode(mapBytes(bytes)), multibyte };
};

/** Final byte of an `ESC -` designation to the decoder for its high half. */
const G1_LABELS: Record<string, string> = {
  A: 'latin1',
  B: 'iso-8859-2',
  C: 'iso-8859-3',
  D: 'iso-8859-4',
  F: 'iso-ir-126',
  G: 'iso-ir-127',
  H: 'iso-ir-138',
  L: 'iso-ir-144',
  M: 'iso-ir-148',
  T: 'tis-620',
};

/**
 * The ISO 2022 designations DICOM allows, keyed by the bytes following the
 * escape. `ESC ( B` and `ESC ( J` return to the default repertoire, so they are
 * added per file where that default is known.
 */
const DESIGNATIONS: Record<string, Repertoire> = {
  '(I': repertoire('shift-jis', { mapBytes: highHalf }),
  ')I': repertoire('shift-jis'),
  $B: repertoire('euc-jp', { multibyte: true, mapBytes: highHalf }),
  $A: repertoire('gbk', { multibyte: true, mapBytes: highHalf }),
  '$(D': repertoire('euc-jp', { multibyte: true, mapBytes: jisX0212Bytes }),
  '$)C': repertoire('euc-kr', { multibyte: true }),
  '$)A': repertoire('gbk', { multibyte: true }),
  ...Object.fromEntries(
    Object.entries(G1_LABELS).map(([final, label]) => [
      `-${final}`,
      repertoire(label),
    ])
  ),
};

/** Designations are two or three bytes wide, longest match first. */
const designationAt = (
  bytes: Uint8Array,
  at: number,
  table: Record<string, Repertoire>
) =>
  [3, 2]
    .map((width) => ({
      width,
      mode: table[String.fromCharCode(...bytes.subarray(at, at + width))],
    }))
    .find(({ mode }) => mode != null);

/**
 * Reads a value whose repertoire switches mid stream. Every run between two
 * escapes decodes under the repertoire the earlier escape designated, and a
 * delimiter returns a single byte repertoire to the default, as the standard
 * requires a writer to do explicitly.
 */
const decodeDesignations = (
  bytes: Uint8Array,
  initial: Repertoire,
  table: Record<string, Repertoire>
) => {
  const runs: string[] = [];
  let mode = initial;
  let start = 0;
  let at = 0;
  const flush = (end: number) => {
    if (end > start) runs.push(mode.decode(bytes.subarray(start, end)));
  };

  while (at < bytes.length) {
    const designation =
      bytes[at] === ESCAPE_BYTE
        ? designationAt(bytes, at + 1, table)
        : undefined;
    if (designation) {
      flush(at);
      mode = designation.mode;
      at += 1 + designation.width;
      start = at;
    } else {
      if (
        mode !== initial &&
        !mode.multibyte &&
        DELIMITER_BYTES.has(bytes[at])
      ) {
        flush(at);
        mode = initial;
        start = at;
      }
      at += 1;
    }
  }
  flush(bytes.length);
  return runs.join('');
};

/**
 * Value 1 of Specific Character Set is the default repertoire and values 2 and
 * up are extensions, so the last declared set is tried first and an earlier one
 * is used only for bytes it cannot decode. ISO 2022 IR 13 holds half width
 * katakana as raw bytes that the escape driven ISO 2022 IR 87 decoder rejects,
 * so no single decoder covers every value of such a file.
 */
const characterSetDecoder = (specificCharacterSet: string) => {
  const declared = specificCharacterSet
    .split(VALUE_DELIMITER)
    .filter((name) => name.trim().length > 0)
    .map(encodingLabel)
    .filter((label): label is string => label != null)
    .reverse();
  const labels = declared.length > 0 ? declared : ['utf-8'];
  const strict = labels.map((label) => new TextDecoder(label, { fatal: true }));
  const lenient = new TextDecoder(labels[0]);
  // JIS X 0201 has no backslash or tilde; those code points are the yen sign
  // and the overline, which is what GDCM emitted for such a file.
  const jisRoman = labels.includes('shift-jis');

  const initial: Repertoire = {
    decode: (bytes) =>
      strict.reduce<string | undefined>(
        (text, decoder) => text ?? tryDecode(decoder, bytes),
        undefined
      ) ?? lenient.decode(bytes),
    multibyte: false,
  };
  const table = { ...DESIGNATIONS, '(B': initial, '(J': initial };

  return (raw: string) => {
    const bytes = toBytes(raw);
    const decoded = bytes.includes(ESCAPE_BYTE)
      ? decodeDesignations(bytes, initial, table)
      : initial.decode(bytes);
    return jisRoman
      ? decoded.replace(/\\/g, '\u00a5').replace(/~/g, '\u203e')
      : decoded;
  };
};

const hexTag = (value: number) => value.toString(16).padStart(4, '0');

/** An AT value is a packed tag, which GDCM printed as `(gggg,eeee)`. */
const attributeTagText = (packed: number) =>
  `(${hexTag(packed >>> 16)},${hexTag(packed & 0xffff)})`;

/** C++ `ostream` default formatting, which is `%g` with six significant digits. */
const floatText = (value: number) => {
  if (!Number.isFinite(value)) return String(value);
  const trim = (text: string) =>
    text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
  const [mantissa, exponent] = value
    .toExponential(FLOAT_PRECISION - 1)
    .split('e');
  const power = Number(exponent);
  return power < -4 || power >= FLOAT_PRECISION
    ? `${trim(mantissa)}e${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`
    : trim(value.toFixed(Math.max(0, FLOAT_PRECISION - 1 - power)));
};

const nonTextValue = (vr: string, value: unknown) => {
  const bytes = viewBytes(value);
  if (bytes) return btoa(binaryString(bytes));
  if (typeof value !== 'number') return String(value);
  if (vr === 'AT') return attributeTagText(value);
  return FLOAT_VRS.has(vr) || !Number.isInteger(value)
    ? floatText(value)
    : String(value);
};

const byTag = (a: [string, string], b: [string, string]) =>
  Number(a[0] > b[0]) - Number(a[0] < b[0]);

const itkTag = (cleanString: string) =>
  `${cleanString.slice(0, 4)}|${cleanString.slice(4)}`.toLowerCase();

const hex4 = (value: number) =>
  value.toString(16).padStart(4, '0').toUpperCase();

const dictionaryVr = (group: number, element: number) =>
  DicomMetaDictionary.dictionary[`(${hex4(group)},${hex4(element)})`]?.vr;

const openFile = (bytes: Uint8Array) => {
  if (bytes.byteLength <= PREAMBLE_LENGTH + MAGIC.length)
    throw new Error('Not a DICOM file: too short to hold a preamble');

  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const stream = new ReadBufferStream(buffer);
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
  dataSet.setDecoder(byteDecoder);
  return { dataSet, syntax: DicomMessage._normalizeSyntax(syntax) };
};

/**
 * Where a sequence's value ends, or null when the next element is not a
 * sequence of defined length. The flat tag list holds no sequence, and
 * descending into one costs a parse that a nested element whose VR differs from
 * the dictionary can fail, so a sequence is stepped over rather than read.
 */
const peekSequenceEnd = (dataSet: DicomReadStream, syntax: string) => {
  const start = dataSet.offset;
  const implicit = syntax === IMPLICIT_VR_LITTLE_ENDIAN;
  dataSet.setEndian(syntax !== EXPLICIT_VR_BIG_ENDIAN);
  const group = dataSet.readUint16();
  const element = dataSet.readUint16();
  const vr = implicit ? dictionaryVr(group, element) : dataSet.readVR();
  const length32 = implicit || LENGTH_32_VRS.has(vr ?? '');
  if (length32 && !implicit) dataSet.increment(RESERVED_LENGTH);
  const length = length32 ? dataSet.readUint32() : dataSet.readUint16();
  const end = dataSet.offset + length;
  dataSet.offset = start;
  return vr === 'SQ' && length !== UNDEFINED_LENGTH ? end : null;
};

/**
 * dcmjs drops the trailing pad byte that made an element's value length even,
 * which ITK kept. An odd total byte length, delimiters included, is exactly that
 * dropped pad. UI pads with a null byte, which ITK stripped as well.
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

/** Bytes of a VR the Specific Character Set does not reach are code points. */
const defaultRepertoire = (raw: string) => raw;

/**
 * The VRs a Specific Character Set applies to, from PS3.5 6.1.2 and PS3.3
 * C.12.1.1.2. Every other string VR, DS and IS included, stays in the default
 * repertoire, so no charset transform can reach a numeric value.
 */
const CHARSET_VRS = new Set(['SH', 'LO', 'ST', 'PN', 'LT', 'UC', 'UT']);

/**
 * Decodes each value on its own and joins afterwards, so the backslash that
 * separates them is never part of a decoded run.
 */
const textValue = (
  vr: string,
  values: string[],
  decode: (raw: string) => string
) =>
  restorePadByte(vr, values)
    .map(CHARSET_VRS.has(vr) ? decode : defaultRepertoire)
    .join(VALUE_DELIMITER);

const rawValuesOf = (rawValues: unknown) => {
  if (rawValues == null) return [];
  return Array.isArray(rawValues) ? (rawValues as unknown[]) : [rawValues];
};

const isPrivateTag = (tag: string) =>
  (Number.parseInt(tag.slice(0, 4), 16) & 1) === 1;

const readElements = (dataSet: DicomReadStream, syntax: string) => {
  const elements: Array<{ tag: string; vr: string; values: unknown[] }> = [];
  let done = false;
  while (!done && !dataSet.end()) {
    const sequenceEnd = peekSequenceEnd(dataSet, syntax);
    if (sequenceEnd != null) {
      dataSet.offset = sequenceEnd;
    } else {
      const element = DicomMessage._readTag(dataSet, syntax, {
        untilTag: PIXEL_DATA,
        includeUntilTagValue: false,
        forceStoreRaw: true,
      });
      const tag = element.tag.toCleanString();
      done = tag === PIXEL_DATA;
      // A sequence of undefined length is still read; its items are not tags.
      // GDCM reported no private element, so an odd group is dropped here too.
      if (
        !done &&
        element.vr !== 0 &&
        element.vr.type !== 'SQ' &&
        !isPrivateTag(tag)
      )
        elements.push({
          tag,
          vr: element.vr.type,
          values: rawValuesOf(element.rawValues),
        });
    }
  }
  return elements;
};

/**
 * Reads a DICOM file's header tags, stopping before Pixel Data, in the shape
 * and value formatting `@itk-wasm/dicom`'s `readDicomTags` produced: `gggg|eeee`
 * keys sorted by tag, multiple values joined with a backslash, binary VRs as
 * plain decimals, and text padding left as the file wrote it.
 */
export function readDicomTags(bytes: Uint8Array): Array<[string, string]> {
  const { dataSet, syntax } = openFile(bytes);
  const elements = readElements(dataSet, syntax);

  const charset = elements.find(({ tag }) => tag === SPECIFIC_CHARACTER_SET);
  const decoder = characterSetDecoder(
    charset?.values.map(String).join(VALUE_DELIMITER) ?? ''
  );

  const pairs = elements.map(({ tag, vr, values }): [string, string] => [
    itkTag(tag),
    values.every((value) => typeof value === 'string')
      ? textValue(vr, values as string[], decoder)
      : values.map((value) => nonTextValue(vr, value)).join(VALUE_DELIMITER),
  ]);

  // GDCM reported an empty Specific Character Set for a file that declares none.
  const withCharset: Array<[string, string]> = charset
    ? pairs
    : [...pairs, [itkTag(SPECIFIC_CHARACTER_SET), '']];

  return withCharset.sort(byTag);
}

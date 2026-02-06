import { describe, it, expect } from 'vitest';
import { sanitizeJsonStringValues } from '@/src/io/sanitizeJsonStringValues';

describe('sanitizeJsonStringValues', () => {
  it('should not modify valid JSON', () => {
    const input = '{"name": "hello", "value": 42}';
    expect(sanitizeJsonStringValues(input)).toBe(input);
  });

  it('should preserve valid escape sequences', () => {
    const input = '{"a": "hello\\nworld\\t\\"quoted\\""}';
    expect(sanitizeJsonStringValues(input)).toBe(input);
  });

  it('should preserve valid unicode escapes', () => {
    const input = '{"a": "\\u0041\\u00e4"}';
    expect(sanitizeJsonStringValues(input)).toBe(input);
  });

  it('should preserve valid backslash escapes', () => {
    const input = '{"a": "hello\\\\world"}';
    expect(sanitizeJsonStringValues(input)).toBe(input);
  });

  it('should escape invalid backslash sequences', () => {
    const input = '{"a": "test\\xvalue"}';
    const result = sanitizeJsonStringValues(input);
    expect(JSON.parse(result)).toEqual({ a: 'test\\xvalue' });
  });

  it('should escape backslash before non-escape character (unterminated string fix)', () => {
    // Simulates the pattern from ISO 2022 IR 87 encoded DICOM data where
    // a backslash byte (0x5C) appears as part of JIS X 0208 character codes.
    // Without sanitization, this causes "Unterminated string in JSON" errors
    // because the parser misinterprets the invalid escape sequence.
    const input = '{"a": "test\\太郎", "b": 1}';
    const result = sanitizeJsonStringValues(input);
    expect(JSON.parse(result)).toEqual({ a: 'test\\太郎', b: 1 });
  });

  it('should handle unescaped backslash in Japanese text', () => {
    const input = '{"PatientName": "山田\\太郎"}';
    const result = sanitizeJsonStringValues(input);
    expect(JSON.parse(result)).toEqual({ PatientName: '山田\\太郎' });
  });

  it('should handle DICOM metadata with Japanese characters and backslash', () => {
    const input =
      '{"metadata": [["0008|0005", "ISO 2022 IR 87"], ["0010|0010", "山田\\太郎"]]}';
    const result = sanitizeJsonStringValues(input);
    const parsed = JSON.parse(result);
    expect(parsed.metadata[1]).toEqual(['0010|0010', '山田\\太郎']);
  });

  it('should escape control characters within strings', () => {
    const input = '{"a": "hello\x01world"}';
    const result = sanitizeJsonStringValues(input);
    expect(JSON.parse(result)).toEqual({ a: 'hello\x01world' });
  });

  it('should escape literal newlines within strings', () => {
    const input = '{"a": "hello\nworld"}';
    const result = sanitizeJsonStringValues(input);
    expect(JSON.parse(result)).toEqual({ a: 'hello\nworld' });
  });

  it('should escape literal carriage returns within strings', () => {
    const input = '{"a": "hello\rworld"}';
    const result = sanitizeJsonStringValues(input);
    expect(JSON.parse(result)).toEqual({ a: 'hello\rworld' });
  });

  it('should handle complex Image JSON with problematic metadata', () => {
    const input =
      '{"imageType":{"dimension":3},"name":"output","origin":[0,0,0],' +
      '"spacing":[1,1,1],"size":[512,512,100],' +
      '"metadata":[["0008|0005","ISO 2022 IR 87"],["0010|0010","山田\\太郎"]]}';
    const result = sanitizeJsonStringValues(input);
    const parsed = JSON.parse(result);
    expect(parsed.imageType.dimension).toBe(3);
    expect(parsed.metadata[1][1]).toBe('山田\\太郎');
  });

  it('should preserve Japanese UTF-8 characters without backslashes', () => {
    const input = '{"a": "日本語テスト"}';
    expect(sanitizeJsonStringValues(input)).toBe(input);
  });
});

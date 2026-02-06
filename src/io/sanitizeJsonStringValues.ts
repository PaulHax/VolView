/**
 * Sanitizes a raw JSON string by fixing invalid escape sequences and
 * unescaped control characters within JSON string values.
 *
 * This is needed because the itk-wasm C++ pipeline (using the glaze JSON
 * library) may produce JSON with improperly escaped characters in string
 * values, particularly when processing DICOM files with non-ASCII character
 * sets like ISO 2022 IR 87 (Japanese).
 *
 * For example, JIS X 0208 encoded bytes may include 0x5C (backslash) as
 * part of character codes. If these are not properly escaped in the JSON
 * output, they cause "Unterminated string" or "Bad escaped character"
 * JSON parse errors.
 */
export function sanitizeJsonStringValues(jsonStr: string): string {
  let result = '';
  let inString = false;
  let i = 0;
  while (i < jsonStr.length) {
    const char = jsonStr[i];
    if (inString) {
      if (char === '\\') {
        if (i + 1 < jsonStr.length) {
          const nextChar = jsonStr[i + 1];
          // Valid JSON escape sequences: \" \\ \/ \b \f \n \r \t \uXXXX
          if ('"\\bfnrt/'.includes(nextChar)) {
            result += char + nextChar;
            i += 2;
            continue;
          } else if (
            nextChar === 'u' &&
            i + 5 < jsonStr.length &&
            /^[0-9a-fA-F]{4}$/.test(jsonStr.substring(i + 2, i + 6))
          ) {
            result += jsonStr.substring(i, i + 6);
            i += 6;
            continue;
          }
          // Invalid escape sequence - escape the backslash itself
          result += '\\\\';
          i += 1;
          continue;
        }
        // Backslash at end of string value - escape it
        result += '\\\\';
        i += 1;
        continue;
      } else if (char === '"') {
        result += char;
        inString = false;
      } else {
        const code = char.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) {
          // Control character - escape as unicode
          result += '\\u' + ('0000' + code.toString(16)).slice(-4);
          i += 1;
          continue;
        }
        result += char;
      }
    } else {
      if (char === '"') {
        inString = true;
      }
      result += char;
    }
    i += 1;
  }
  return result;
}

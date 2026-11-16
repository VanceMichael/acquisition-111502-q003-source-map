const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Int16Array(128).fill(-1);
for (let index = 0; index < BASE64.length; index += 1) BASE64_VALUES[BASE64.charCodeAt(index)] = index;

export class MapProblem extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = 'MapProblem';
    this.reason = reason;
    this.detail = detail;
  }
}

export function decodeVlq(text) {
  const values = [];
  let value = 0;
  let place = 1;
  let continuation = false;
  let shifted = 0;
  for (const character of text) {
    const digit = character.charCodeAt(0) < 128 ? BASE64_VALUES[character.charCodeAt(0)] : -1;
    if (digit < 0) throw new MapProblem('map-invalid-vlq', 'unexpected base64 character');
    continuation = (digit & 32) !== 0;
    value += (digit & 31) * place;
    place *= 32;
    shifted += 1;
    if (shifted > 11) throw new MapProblem('map-invalid-vlq', 'value is too large');
    if (!continuation) {
      const negative = value % 2 === 1;
      const magnitude = Math.floor(value / 2);
      values.push(negative ? -magnitude : magnitude);
      value = 0;
      place = 1;
      shifted = 0;
    }
  }
  if (continuation) throw new MapProblem('map-invalid-vlq', 'unterminated value');
  return values;
}

// Decode a version=3 mappings string into per-line segment starts. State is
// carried across lines exactly as the source-map format specifies; generated
// columns reset on every line.
export function decodeMappings(mappings) {
  if (typeof mappings !== 'string') throw new MapProblem('map-invalid-mappings', 'mappings is not a string');
  const lines = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;
  const rawLines = mappings.split(';');
  for (let lineNumber = 0; lineNumber < rawLines.length; lineNumber += 1) {
    const lineText = rawLines[lineNumber];
    let generatedColumn = 0;
    const segments = [];
    if (lineText.length > 0) {
      for (const segmentText of lineText.split(',')) {
        if (segmentText.length === 0) throw new MapProblem('map-invalid-mappings', 'empty segment');
        const values = decodeVlq(segmentText);
        if (![1, 4, 5].includes(values.length)) {
          throw new MapProblem('map-invalid-mappings', 'segment has ' + values.length + ' fields');
        }
        generatedColumn += values[0];
        if (generatedColumn < 0) throw new MapProblem('map-invalid-mappings', 'negative generated column');
        if (values.length === 1) {
          segments.push({ generatedLine: lineNumber, generatedColumn, unmapped: true });
        } else {
          sourceIndex += values[1];
          originalLine += values[2];
          originalColumn += values[3];
          if (values.length === 5) nameIndex += values[4];
          if (sourceIndex < 0 || originalLine < 0 || originalColumn < 0) {
            throw new MapProblem('map-invalid-mappings', 'negative decoded field');
          }
          segments.push({
            generatedLine: lineNumber, generatedColumn, unmapped: false,
            sourceIndex, originalLine, originalColumn,
            ...(values.length === 5 ? { nameIndex } : {})
          });
        }
      }
    }
    lines.push(segments);
  }
  return lines;
}

export function classifyMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'map-not-an-object' };
  }
  if (value.version !== 3) {
    return { kind: 'unsupported', reason: 'map-version-unsupported', version: value.version ?? null };
  }
  if (value.sections !== undefined) {
    if (!Array.isArray(value.sections)) return { kind: 'invalid', reason: 'map-sections-not-an-array' };
    if (value.mappings !== undefined) return { kind: 'invalid', reason: 'map-has-both-sections-and-mappings' };
    return { kind: 'indexed' };
  }
  if (typeof value.mappings !== 'string') return { kind: 'invalid', reason: 'map-missing-mappings' };
  return { kind: 'flat' };
}

export function sectionOffset(offset) {
  if (!offset || typeof offset !== 'object') return null;
  if (!Number.isInteger(offset.line) || offset.line < 0) return null;
  if (!Number.isInteger(offset.column) || offset.column < 0) return null;
  return { line: offset.line, column: offset.column };
}

// The section column offset is added only on the section's first generated
// line; the line offset applies to every line in the section. This also
// composes correctly for nested sections.
export function composeOffset(outer, inner) {
  return {
    line: outer.line + inner.line,
    column: inner.column + (inner.line === 0 ? outer.column : 0)
  };
}

export function generatedPosition(offset, line, column) {
  return {
    generatedLine: offset.line + line + 1,
    generatedColumn: column + (line === 0 ? offset.column : 0)
  };
}

export function resolveSourceUrl(mapUrl, sourceRoot, source) {
  let base = mapUrl;
  if (typeof sourceRoot === 'string' && sourceRoot.length > 0) {
    try { base = new URL(sourceRoot, mapUrl).href; } catch { base = mapUrl; }
  }
  try {
    const resolved = new URL(source, base);
    return { sourceUrl: resolved.href, sourcePath: sourcePathOf(resolved), raw: source };
  } catch {
    return { sourceUrl: null, sourcePath: String(source), raw: source };
  }
}

export function sourcePathOf(url) {
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.pathname + url.search;
  return url.href;
}

export function displayUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.pathname + url.search;
    return url.href;
  } catch {
    return rawUrl;
  }
}

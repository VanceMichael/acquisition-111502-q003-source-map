// Interpret a generated position against the records already archived for a
// collection. Only segment starts are known, so a position is resolved to the
// nearest preceding segment on the same line. Nothing is carried over from a
// previous line, and an unmapped segment never inherits the previous source.
export function explainPosition(records, generatedLine, generatedColumn) {
  if (!Number.isInteger(generatedLine) || generatedLine < 1 ||
      !Number.isInteger(generatedColumn) || generatedColumn < 0) {
    throw Object.assign(new Error('invalid_position'), { status: 400 });
  }
  const line = records
    .filter(record => record.kind === 'mapped-position' || record.kind === 'unmapped-range')
    .filter(record => record.value?.generatedLine === generatedLine)
    .sort((left, right) => left.value.generatedColumn - right.value.generatedColumn);
  const preceding = line.filter(record => record.value.generatedColumn <= generatedColumn);
  if (preceding.length === 0) {
    return {
      generatedLine, generatedColumn,
      state: 'unknown',
      reason: 'no-segment-before-position',
      // A line without a preceding segment is not evidence that this range is
      // explicitly unmapped; do not borrow another line's mapping either.
      detail: 'no segment starts at or before this generated position'
    };
  }
  const start = preceding[preceding.length - 1].value.generatedColumn;
  const candidates = preceding.filter(record => record.value.generatedColumn === start);
  const mapped = candidates.filter(record => record.kind === 'mapped-position');
  const unmapped = candidates.filter(record => record.kind === 'unmapped-range');
  if (mapped.length > 0 && unmapped.length > 0) {
    // Two archived map versions disagree about this start; do not pick one.
    return {
      generatedLine, generatedColumn,
      state: 'ambiguous',
      reason: 'conflicting-map-versions',
      candidates: candidates.map(record => record.value)
    };
  }
  if (unmapped.length > 0) {
    return {
      generatedLine, generatedColumn,
      state: 'unmapped',
      rangeStart: { generatedLine, generatedColumn: start },
      section: unmapped[0].value.section || null,
      provenance: unmapped[0].provenance
    };
  }
  if (mapped.length > 1) {
    const unique = new Set(mapped.map(record => JSON.stringify({
      sourcePath: record.value.sourcePath,
      originalLine: record.value.originalLine,
      originalColumn: record.value.originalColumn
    })));
    if (unique.size > 1) {
      return {
        generatedLine, generatedColumn,
        state: 'ambiguous',
        reason: 'several-maps-claim-position',
        candidates: mapped.map(record => record.value)
      };
    }
  }
  const chosen = mapped[0];
  return {
    generatedLine, generatedColumn,
    state: 'mapped',
    mapped: {
      generatedLine: chosen.value.generatedLine,
      generatedColumn: chosen.value.generatedColumn,
      sourcePath: chosen.value.sourcePath,
      sourceUrl: chosen.value.sourceUrl ?? null,
      originalLine: chosen.value.originalLine,
      originalColumn: chosen.value.originalColumn,
      section: chosen.value.section || null
    },
    provenance: chosen.provenance
  };
}

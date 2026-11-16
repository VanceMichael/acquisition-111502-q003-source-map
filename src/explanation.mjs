function emptySources() {
  return { embedded: 0, external: 0, unavailable: 0 };
}

function addSources(total, value) {
  total.embedded += (value?.embedded || 0);
  total.external += (value?.external || 0);
  total.unavailable += (value?.unavailable || 0);
}

function uniqueBy(values, keyOf) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

// Build the explanation summary for a single acquisition. The state describes
// this entry only; merging combines several entries so a later success cannot
// hide an earlier gap.
export function summarizeAcquisition({ entry, entryReceiptId, maps, issues }) {
  const leaves = maps.filter(map => map.kind !== 'indexed');
  const mappedPositions = leaves.reduce((total, map) => total + (map.mappedPositions || 0), 0);
  const unmappedRanges = leaves.reduce((total, map) => total + (map.unmappedRanges || 0), 0);
  const sources = leaves.reduce((total, map) => {
    addSources(total, map.sources);
    return total;
  }, emptySources());
  const sections = maps.flatMap(map => map.sections || []);
  const explained = sections.filter(section => section.state === 'explained').length;
  const missing = sections.filter(section => section.state === 'missing').length;
  const invalid = sections.filter(section => section.state === 'invalid').length;
  // A recorded problem always leaves the acquisition partial: a successful
  // receipt must never be read as a full, reliable mapping.
  const complete = maps.length > 0 &&
    maps.every(map => map.state === 'explained') &&
    sections.every(section => section.state === 'explained') &&
    issues.length === 0;
  return {
    entry: entry || null,
    entryReceiptId: entryReceiptId || null,
    state: complete ? 'explained' : 'partial',
    complete,
    maps,
    mappedPositions,
    unmappedRanges,
    sources,
    sections: { total: sections.length, explained, missing, invalid, items: sections },
    issues
  };
}

// Combine per-entry summaries into the collection view. Explanations are keyed
// by entry URL so re-acquiring the same entry replaces its earlier summary
// instead of duplicating it, while separate entries accumulate.
export function mergeExplanations(entries) {
  const byEntry = new Map();
  for (const entry of entries) {
    if (!entry) continue;
    byEntry.set(entry.entry || '(inline)', entry);
  }
  const acquisitions = [...byEntry.values()];
  const maps = uniqueBy(acquisitions.flatMap(acquisition => acquisition.maps || []),
    map => map.receiptId + ':' + map.location);
  const issues = uniqueBy(acquisitions.flatMap(acquisition => acquisition.issues || []),
    value => JSON.stringify(value));
  const sections = acquisitions.flatMap(acquisition => acquisition.sections?.items || []);
  const sources = acquisitions.reduce((total, acquisition) => {
    addSources(total, acquisition.sources);
    return total;
  }, emptySources());
  const mappedPositions = acquisitions.reduce((total, acquisition) => total + acquisition.mappedPositions, 0);
  const unmappedRanges = acquisitions.reduce((total, acquisition) => total + acquisition.unmappedRanges, 0);
  const complete = acquisitions.length > 0 && acquisitions.every(acquisition => acquisition.complete);
  return {
    state: complete ? 'explained' : 'partial',
    complete,
    acquisitions,
    maps,
    mappedPositions,
    unmappedRanges,
    sources,
    sections: {
      total: acquisitions.reduce((total, acquisition) => total + acquisition.sections.total, 0),
      explained: acquisitions.reduce((total, acquisition) => total + acquisition.sections.explained, 0),
      missing: acquisitions.reduce((total, acquisition) => total + acquisition.sections.missing, 0),
      invalid: acquisitions.reduce((total, acquisition) => total + acquisition.sections.invalid, 0),
      items: sections
    },
    issues
  };
}

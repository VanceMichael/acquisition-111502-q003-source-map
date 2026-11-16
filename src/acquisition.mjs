import { summarize } from './summary.mjs';
import { retrieve } from './transport.mjs';
import { mergeExplanations, summarizeAcquisition } from './explanation.mjs';
import {
  MapProblem, classifyMap, composeOffset, decodeMappings, displayUrl,
  generatedPosition, resolveSourceUrl, sectionOffset
} from './sourcemap.mjs';

function issue(reason, location, detail) {
  return detail ? { reason, location, detail } : { reason, location };
}

function isDeliveryIndex(value) {
  return Boolean(value) && typeof value === 'object' &&
    typeof value.deliveryId === 'string' && Array.isArray(value.roots);
}

function parseJson(bytes) {
  try { return { value: JSON.parse(bytes.toString('utf8')) }; } catch { return null; }
}

function originOf(href) {
  try { return new URL(href).origin; } catch { return null; }
}

function pointer(base, ...steps) {
  let value = base || '';
  for (const step of steps) value += '/' + String(step).replaceAll('~', '~0').replaceAll('/', '~1');
  return value || '/';
}

function emptySources() {
  return { embedded: 0, external: 0, unavailable: 0 };
}

function addSources(total, value) {
  total.embedded += value.embedded || 0;
  total.external += value.external || 0;
  total.unavailable += value.unavailable || 0;
}

// Association and explanation for source-map deliveries. Every dependent
// payload becomes an ordinary archived receipt; no delivered code is executed
// and no address outside the frozen authorized origin is contacted.
export class Acquisition {
  constructor({ archive, collectionId, allowedOrigin }) {
    this.archive = archive;
    this.collectionId = collectionId;
    this.allowedOrigin = allowedOrigin;
    this.receiptIds = [];
    this.records = [];
    this.issues = [];
    this.issueKeys = new Set();
    this.recordKeys = new Set();
    this.fetched = new Map();
    this.maps = [];
  }

  addIssue(reason, location, detail) {
    const value = issue(reason, location, detail);
    const key = JSON.stringify(value);
    if (this.issueKeys.has(key)) return;
    this.issueKeys.add(key);
    this.issues.push(value);
  }

  addRecord(record) {
    if (this.recordKeys.has(record.key)) return;
    this.recordKeys.add(record.key);
    this.records.push(record);
  }

  async store(sourceKey, revision, mediaType, bytes) {
    const receipt = await this.archive.receive({
      collectionId: this.collectionId, sourceKey, revision: revision || 'unversioned',
      mediaType: mediaType || 'application/octet-stream', bytes,
      summary: summarize(bytes, mediaType || 'application/octet-stream')
    });
    if (!this.receiptIds.includes(receipt.receiptId)) this.receiptIds.push(receipt.receiptId);
    return receipt;
  }

  // Authorization is the origin for every dependent payload. A URL outside it
  // is refused before any request is made and recorded as an issue.
  async fetch(url, location) {
    if (this.fetched.has(url)) return this.fetched.get(url);
    if (originOf(url) !== this.allowedOrigin) {
      const entry = { item: null, outside: true };
      this.fetched.set(url, entry);
      this.addIssue('source-outside-authorization', location, displayUrl(url));
      return entry;
    }
    let entry;
    try {
      const result = await retrieve(url, this.allowedOrigin);
      const receipt = await this.store(url, result.revision, result.mediaType, result.bytes);
      entry = { item: { url, receipt, bytes: result.bytes, mediaType: result.mediaType }, outside: false };
    } catch (error) {
      entry = { item: null, error, outside: false };
    }
    this.fetched.set(url, entry);
    return entry;
  }

  async acquire(entry) {
    this.entry = entry;
    const fetched = await this.fetch(entry, 'entry');
    if (!fetched.item) {
      if (fetched.outside) throw Object.assign(new Error('source_not_allowed'), { status: 403 });
      throw Object.assign(new Error(fetched.error?.message || 'source_response_failed'), { status: 502 });
    }
    this.entryReceiptId = fetched.item.receipt.receiptId;
    const parsed = parseJson(fetched.item.bytes);
    if (!parsed) {
      this.addIssue('unsupported-entry', 'entry', 'entry payload is not JSON');
      return this.result();
    }
    if (isDeliveryIndex(parsed.value)) {
      await this.delivery(parsed.value, fetched);
      return this.result();
    }
    await this.explain(parsed.value, {
      mapUrl: entry,
      mapReceiptId: fetched.item.receipt.receiptId,
      mapPointer: '',
      inline: false,
      depth: 0,
      offset: { line: 0, column: 0 },
      baseOffset: { line: 0, column: 0 },
      offsetProvenance: [],
      visited: new Set([entry])
    });
    return this.result();
  }

  async delivery(value, fetched) {
    if (value.revision !== undefined && typeof value.revision !== 'string') {
      this.addIssue('delivery-invalid', '/revision', 'revision is not a string');
    }
    for (const [index, root] of value.roots.entries()) {
      const location = pointer('', 'roots', index);
      if (!root || typeof root !== 'object' || typeof root.href !== 'string') {
        this.addIssue('delivery-entry-invalid', location, 'root needs an href');
        continue;
      }
      const url = this.resolve(root.href, fetched.item.url, location);
      if (!url) continue;
      const rootFetched = await this.fetch(url, location);
      if (!rootFetched.item) {
        if (!rootFetched.outside) this.addIssue('map-unavailable', location, displayUrl(url));
        // Keep the root in the map index even when its bytes are missing, so
        // the gap is visible next to the explanations that did succeed.
        this.maps.push({
          url: displayUrl(url), receiptId: null, location, kind: 'unknown', state: 'missing',
          reason: rootFetched.outside ? 'source-outside-authorization' : 'map-unavailable',
          mappedPositions: 0, unmappedRanges: 0,
          sources: emptySources(), sections: []
        });
        continue;
      }
      const parsed = parseJson(rootFetched.item.bytes);
      if (!parsed) {
        this.addIssue('source-map-unparseable', location, displayUrl(url));
        continue;
      }
      await this.explain(parsed.value, {
        mapUrl: url,
        mapReceiptId: rootFetched.item.receipt.receiptId,
        mapPointer: '',
        inline: false,
        depth: 0,
        offset: { line: 0, column: 0 },
        baseOffset: { line: 0, column: 0 },
        offsetProvenance: [],
        visited: new Set([url])
      });
    }
    // Resources are the delivery's claim about what belongs to the package.
    // They are not fetched eagerly and are never executed; they only make the
    // association explicit in the archived index.
    for (const [index, resource] of (value.resources || []).entries()) {
      const location = pointer('', 'resources', index);
      if (!resource || typeof resource !== 'object' || typeof resource.href !== 'string') {
        this.addIssue('delivery-entry-invalid', location, 'resource needs an href');
      } else if (originOf(this.resolve(resource.href, fetched.item.url, location)) !== this.allowedOrigin) {
        this.addIssue('source-outside-authorization', location, String(resource.href));
      }
    }
  }

  resolve(href, relativeTo, location) {
    try {
      const url = new URL(href, relativeTo);
      return url.href;
    } catch {
      this.addIssue('delivery-entry-invalid', location, 'href cannot be resolved');
      return null;
    }
  }

  async explain(map, context) {
    if ((context.depth || 0) > 32) {
      this.addIssue('section-nesting-too-deep', context.mapPointer || '/', 'depth ' + context.depth);
      return this.mapReport(context, map, 'invalid', 'section-nesting-too-deep', emptySources());
    }
    const classification = classifyMap(map);
    if (classification.kind === 'invalid') {
      this.addIssue(classification.reason, context.mapPointer || '/', classification.detail);
      return this.mapReport(context, map, 'invalid', classification.reason, emptySources());
    }
    if (classification.kind === 'unsupported') {
      this.addIssue(classification.reason, context.mapPointer || '/', 'version ' + String(classification.version));
      return this.mapReport(context, map, 'unsupported', classification.reason, emptySources());
    }
    if (classification.kind === 'indexed') {
      const report = await this.explainSections(map, context);
      return this.mapReport(context, map, report.state, null, report.sources, report);
    }
    const report = await this.explainFlat(map, context);
    return this.mapReport(context, map, report.state, null, report.sources, report);
  }

  mapReport(context, map, state, reason, sources, report = {}) {
    const value = {
      url: displayUrl(context.mapUrl),
      receiptId: context.mapReceiptId,
      location: context.mapPointer || '/',
      kind: map && typeof map === 'object' && map.sections !== undefined ? 'indexed' : 'flat',
      state,
      ...(reason ? { reason } : {}),
      ...(context.offsetProvenance.length > 0
        ? { offsetProvenance: context.offsetProvenance.map(item => ({ receiptId: item.receiptId, location: item.location })) }
        : {}),
      mappedPositions: report.mappedPositions || 0,
      unmappedRanges: report.unmappedRanges || 0,
      sources: { ...sources },
      sections: report.segments || []
    };
    this.maps.push(value);
    // Nested maps are also listed individually, so an explanation can point at
    // the exact payload that a position came from.
    return value;
  }

  async explainSections(map, context) {
    const segments = [];
    const sources = emptySources();
    let mappedPositions = 0;
    let unmappedRanges = 0;
    let complete = true;
    for (const [index, section] of map.sections.entries()) {
      const location = pointer(context.mapPointer, 'sections', index);
      const offset = sectionOffset(section?.offset);
      const record = { index, location, offset: offset || null };
      segments.push(record);
      if (!offset) {
        complete = false;
        record.state = 'invalid';
        this.addIssue('section-invalid-offset', location, 'offset needs non-negative integer line and column');
        continue;
      }
      if (section.map !== undefined && section.url !== undefined) {
        complete = false;
        record.state = 'invalid';
        this.addIssue('section-ambiguous', location, 'section declares both map and url');
        continue;
      }
      if (section.map === undefined && section.url === undefined) {
        complete = false;
        record.state = 'missing';
        this.addIssue('section-missing-map', location);
        continue;
      }
      const composed = composeOffset(context.baseOffset, offset);
      const offsetProvenance = [
        ...context.offsetProvenance,
        { receiptId: context.mapReceiptId, location: pointer(context.mapPointer, 'sections', index, 'offset') }
      ];
      let report;
      if (section.map !== undefined) {
        report = await this.explain(section.map, {
          ...context,
          mapPointer: pointer(context.mapPointer, 'sections', index, 'map'),
          inline: true,
          depth: (context.depth || 0) + 1,
          offset,
          baseOffset: composed,
          offsetProvenance
        });
        record.inline = true;
        record.baseUrl = displayUrl(context.mapUrl);
      } else {
        const url = this.resolve(section.url, context.mapUrl, location);
        if (!url) {
          complete = false;
          record.state = 'invalid';
          continue;
        }
        record.url = displayUrl(url);
        if (context.visited.has(url)) {
          complete = false;
          record.state = 'invalid';
          this.addIssue('section-cycle', location, displayUrl(url));
          continue;
        }
        const fetched = await this.fetch(url, location);
        if (!fetched.item) {
          // A missing external segment is an explicit gap; it must not be
          // mistaken for a successfully explained section.
          complete = false;
          record.state = 'missing';
          this.addIssue('section-unavailable', location, displayUrl(url));
          continue;
        }
        const parsed = parseJson(fetched.item.bytes);
        if (!parsed) {
          complete = false;
          record.state = 'invalid';
          this.addIssue('section-unparseable', location, displayUrl(url));
          continue;
        }
        const visited = new Set(context.visited);
        visited.add(url);
        report = await this.explain(parsed.value, {
          mapUrl: url,
          mapReceiptId: fetched.item.receipt.receiptId,
          mapPointer: '',
          inline: false,
          depth: (context.depth || 0) + 1,
          offset,
          baseOffset: composed,
          offsetProvenance,
          visited
        });
        record.inline = false;
        record.baseUrl = displayUrl(url);
      }
      record.state = report.state;
      record.mappedPositions = report.mappedPositions || 0;
      record.unmappedRanges = report.unmappedRanges || 0;
      record.sources = { ...(report.sources || emptySources()) };
      mappedPositions += record.mappedPositions;
      unmappedRanges += record.unmappedRanges;
      addSources(sources, record.sources);
      if (report.state !== 'explained') complete = false;
    }
    return {
      state: complete ? 'explained' : 'partial',
      complete, segments, mappedPositions, unmappedRanges, sources
    };
  }

  async explainFlat(map, context) {
    let lines;
    try {
      lines = decodeMappings(map.mappings);
    } catch (error) {
      const reason = error instanceof MapProblem ? error.reason : 'map-invalid-mappings';
      this.addIssue(reason, pointer(context.mapPointer, 'mappings'), error.detail || error.message);
      return { state: 'invalid', mappedPositions: 0, unmappedRanges: 0, sources: emptySources() };
    }
    const sources = Array.isArray(map.sources) ? map.sources : [];
    const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
    const infos = sources.map((source, index) => {
      const resolved = resolveSourceUrl(context.mapUrl, map.sourceRoot, source);
      const embedded = contents[index];
      return { index, ...resolved, embedded: typeof embedded === 'string' ? embedded : null };
    });

    const observed = new Map();
    let mappedPositions = 0;
    let unmappedRanges = 0;
    let problem = null;
    for (const segments of lines) {
      for (const segment of segments) {
        const position = generatedPosition(context.baseOffset, segment.generatedLine, segment.generatedColumn);
        const location = pointer(context.mapPointer, 'mappings') + '@' + position.generatedLine + ':' + position.generatedColumn;
        const address = {
          baseUrl: displayUrl(context.mapUrl),
          inline: context.inline,
          offset: context.offset,
          composedOffset: context.baseOffset
        };
        if (segment.unmapped) {
          this.addRecord({
            kind: 'unmapped-range',
            key: 'unmapped:' + context.mapReceiptId + ':' + location,
            value: {
              generatedLine: position.generatedLine,
              generatedColumn: position.generatedColumn,
              section: address
            },
            provenance: [
              { receiptId: context.mapReceiptId, location },
              ...context.offsetProvenance
            ]
          });
          unmappedRanges += 1;
          continue;
        }
        const info = infos[segment.sourceIndex];
        if (!info) {
          problem = 'map-source-index-invalid';
          this.addIssue(problem, location, 'index ' + segment.sourceIndex);
          continue;
        }
        const sourceIdentity = info.sourcePath;
        // Deduplicate per map entry, not by file name: the same path in two
        // maps can belong to different revisions of the delivery.
        const scope = info.index;
        if (!observed.has(scope)) {
          observed.set(scope, await this.observeSource(info, context, address));
        }
        const source = observed.get(scope);
        this.addRecord({
          kind: 'mapped-position',
          key: 'mapped:' + context.mapReceiptId + ':' + location + ':' + sourceIdentity + ':' +
            (segment.originalLine + 1) + ':' + segment.originalColumn,
          value: {
            generatedLine: position.generatedLine,
            generatedColumn: position.generatedColumn,
            sourcePath: info.sourcePath,
            sourceUrl: info.sourceUrl ? displayUrl(info.sourceUrl) : null,
            originalLine: segment.originalLine + 1,
            originalColumn: segment.originalColumn,
            section: address
          },
          provenance: [
            { receiptId: context.mapReceiptId, location },
            ...context.offsetProvenance,
            ...source.provenance
          ]
        });
        mappedPositions += 1;
      }
    }
    return {
      state: problem ? 'partial' : 'explained', mappedPositions, unmappedRanges,
      sources: tallySources(infos, observed)
    };
  }

  // Embedded text, retrievable source files and unavailable source files are
  // recorded distinctly. A missing source never loses its mapping, and
  // sourcesContent is never invented.
  async observeSource(info, context, address) {
    const sourceLocation = info.embedded !== null
      ? pointer(context.mapPointer, 'sourcesContent', info.index)
      : pointer(context.mapPointer, 'sources', info.index);
    let kind;
    let value;
    let provenance;
    let sourceReceiptId = null;
    if (info.embedded !== null) {
      kind = 'embedded';
      value = {
        sourcePath: info.sourcePath,
        sourceUrl: info.sourceUrl ? displayUrl(info.sourceUrl) : null,
        sourceKind: 'embedded',
        text: info.embedded,
        map: { receiptId: context.mapReceiptId, location: context.mapPointer || '/' }
      };
      provenance = [{ receiptId: context.mapReceiptId, location: sourceLocation }];
    } else if (!info.sourceUrl) {
      kind = 'unavailable';
      value = {
        sourcePath: info.sourcePath, sourceUrl: null, sourceKind: 'unavailable',
        map: { receiptId: context.mapReceiptId, location: context.mapPointer || '/' }
      };
      provenance = [{ receiptId: context.mapReceiptId, location: sourceLocation }];
      this.addIssue('source-unavailable', sourceLocation, info.raw);
    } else {
      const fetched = await this.fetch(info.sourceUrl, sourceLocation);
      if (!fetched.item) {
        kind = 'unavailable';
        value = {
          sourcePath: info.sourcePath, sourceUrl: displayUrl(info.sourceUrl),
          sourceKind: 'unavailable',
          map: { receiptId: context.mapReceiptId, location: context.mapPointer || '/' }
        };
        provenance = [{ receiptId: context.mapReceiptId, location: sourceLocation }];
        // The mapping is retained; only the source body is missing. Do not
        // invent sourcesContent and do not silently drop the position.
        this.addIssue('source-unavailable', sourceLocation, displayUrl(info.sourceUrl));
      } else {
        kind = 'external';
        sourceReceiptId = fetched.item.receipt.receiptId;
        value = {
          sourcePath: info.sourcePath, sourceUrl: displayUrl(info.sourceUrl),
          sourceKind: 'external', receiptId: sourceReceiptId,
          byteLength: fetched.item.bytes.length, mediaType: fetched.item.mediaType,
          map: { receiptId: context.mapReceiptId, location: context.mapPointer || '/' }
        };
        provenance = [
          { receiptId: sourceReceiptId, location: 'byte:0-' + Math.max(0, fetched.item.bytes.length - 1) },
          { receiptId: context.mapReceiptId, location: sourceLocation }
        ];
      }
    }
    const record = {
      kind: 'source-content',
      key: 'source:' + context.mapReceiptId + ':' + sourceLocation + ':' + (sourceReceiptId || kind),
      value, provenance
    };
    this.addRecord(record);
    return { kind, provenance, sourceReceiptId, address };
  }

  result() {
    return {
      collectionId: this.collectionId,
      entry: this.entry || null,
      entryReceiptId: this.entryReceiptId || null,
      receiptIds: this.receiptIds,
      records: this.records,
      issues: this.issues,
      explanation: summarizeAcquisition({
        entry: this.entry || null,
        entryReceiptId: this.entryReceiptId || null,
        maps: this.maps,
        issues: this.issues
      })
    };
  }
}

function tallySources(infos, observed) {
  const value = emptySources();
  for (const info of infos) {
    const reference = observed.get(info.index);
    if (reference) value[reference.kind] += 1;
  }
  return value;
}

export async function acquire({ archive, collectionId, entry, allowedOrigin }) {
  const acquisition = new Acquisition({ archive, collectionId, allowedOrigin });
  const result = await acquisition.acquire(entry);
  const collection = await archive.integrate(collectionId, result);
  return {
    collectionId,
    receiptIds: result.receiptIds,
    explanation: collection.explanation,
    issues: collection.issues,
    records: collection.records
  };
}

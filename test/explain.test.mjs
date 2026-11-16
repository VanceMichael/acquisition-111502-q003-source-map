import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import descriptor from '../fixtures/descriptor.json' with { type: 'json' };
import { acquire } from '../src/acquisition.mjs';
import { Archive } from '../src/archive.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function temporaryArchive() {
  const directory = await mkdtemp(join(tmpdir(), 'explain-'));
  const archive = new Archive(directory);
  await archive.initialize();
  return archive;
}

test('完整交付解释分段位置，各段使用自己的地址基准', async () => {
  const context = await harness();
  try {
    const result = await context.call('/acquisitions', { collectionId: 'complete', entry: context.source + descriptor.entry });
    assert.equal(result.status, 201);
    const positions = result.value.records.filter(record => record.kind === 'mapped-position');
    assert.deepEqual(positions.map(record => record.value).sort((a, b) => a.generatedLine - b.generatedLine), [
      { generatedLine: 1, generatedColumn: 3, sourcePath: '/src/a.ts', sourceUrl: '/src/a.ts', originalLine: 1, originalColumn: 0,
        section: { baseUrl: '/files/app.map', inline: true, offset: { line: 0, column: 3 }, composedOffset: { line: 0, column: 3 } } },
      { generatedLine: 2, generatedColumn: 0, sourcePath: '/src/a.ts', sourceUrl: '/src/a.ts', originalLine: 2, originalColumn: 0,
        section: { baseUrl: '/files/app.map', inline: true, offset: { line: 0, column: 3 }, composedOffset: { line: 0, column: 3 } } },
      { generatedLine: 3, generatedColumn: 5, sourcePath: '/src/b.ts', sourceUrl: '/src/b.ts', originalLine: 1, originalColumn: 0,
        section: { baseUrl: '/maps/tail.map', inline: false, offset: { line: 2, column: 5 }, composedOffset: { line: 2, column: 5 } } }
    ]);
    assert.equal(result.value.explanation.state, 'explained');
    assert.equal(result.value.explanation.complete, true);
    assert.equal(result.value.explanation.sections.total, 2);
    assert.equal(result.value.explanation.sections.missing, 0);
    // External map tail used its own URL as base; sourceRoot is relative to it.
    assert.ok(result.value.explanation.maps.some(map => map.url === '/maps/tail.map'));
  } finally { await context.close(); }
});

test('段起始列偏移只施加在该段首行', async () => {
  const archive = await temporaryArchive();
  const { createServer } = await import('node:http');
  // offset line=1, column=7; the inline map's second line must start at column 0.
  const map = {
    version: 3,
    sections: [{
      offset: { line: 1, column: 7 },
      map: { version: 3, sources: ['x.ts'], names: [], mappings: 'AAAA;AACA' }
    }]
  };
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', etag: '"m"' });
    response.end(JSON.stringify(request.url === '/x.ts' ? 'x' : map));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await acquire({ archive, collectionId: 'offset', entry: origin + '/bundle.map', allowedOrigin: origin });
    const positions = result.records.filter(record => record.kind === 'mapped-position').map(record => record.value);
    assert.deepEqual(positions.map(value => [value.generatedLine, value.generatedColumn]), [[2, 7], [3, 0]]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('未映射区间不从上一个源码位置续用，且保留起点', async () => {
  const context = await harness();
  try {
    const result = await context.call('/acquisitions', { collectionId: 'gaps', entry: context.source + descriptor.entry });
    const ranges = result.value.records.filter(record => record.kind === 'unmapped-range');
    assert.equal(ranges.length, 1);
    assert.deepEqual(
      { generatedLine: ranges[0].value.generatedLine, generatedColumn: ranges[0].value.generatedColumn },
      { generatedLine: 1, generatedColumn: 8 }
    );
    // No mapped-position may claim that unmapped generated area.
    assert.ok(!result.value.records.some(record => record.kind === 'mapped-position' &&
      record.value.generatedLine === 1 && record.value.generatedColumn === 8));
  } finally { await context.close(); }
});

test('内嵌正文、可另取源文件与暂缺源文件分别记录', async () => {
  const context = await harness('partial');
  try {
    const result = await context.call('/acquisitions', { collectionId: 'sources', entry: context.source + descriptor.entry });
    const sources = result.value.records.filter(record => record.kind === 'source-content');
    const embedded = sources.find(record => record.value.sourceKind === 'embedded');
    assert.ok(embedded, '内嵌正文没有单独记录');
    assert.equal(embedded.value.sourcePath, '/src/a.ts');
    assert.match(embedded.value.text, /export const a/);
    assert.ok(embedded.provenance.every(origin => origin.receiptId));
    // tail.map is unavailable in partial mode, so /src/b.ts is never claimed.
    assert.ok(!sources.some(record => record.value.sourcePath === '/src/b.ts'));
  } finally { await context.close(); }
});

test('缺少外置分段时给出已解释位置与明确缺口', async () => {
  const context = await harness('partial');
  try {
    const result = await context.call('/acquisitions', { collectionId: 'gap', entry: context.source + descriptor.entry });
    assert.equal(result.status, 201);
    const explanation = result.value.explanation;
    assert.equal(explanation.state, 'partial');
    assert.equal(explanation.complete, false);
    assert.equal(explanation.maps.length > 0, true);
    const indexed = explanation.maps.find(map => map.kind === 'indexed');
    assert.equal(indexed.state, 'partial');
    const segment = indexed.sections.find(section => section.index === 1);
    assert.equal(segment.state, 'missing');
    assert.equal(indexed.sections.find(section => section.index === 0).state, 'explained');
    assert.ok(result.value.issues.some(value => value.reason === 'section-unavailable' && value.location === '/sections/1'));
    // Explanation retains the reachable positions; it does not roll them back.
    assert.ok(result.value.records.some(record => record.kind === 'mapped-position' && record.value.sourcePath === '/src/a.ts'));
    assert.ok(!result.value.records.some(record => record.value.sourcePath === '/src/b.ts'));
  } finally { await context.close(); }
});

test('解释结果跨重启保留，并与收件正文绑定', async () => {
  const context = await harness();
  try {
    const result = await context.call('/acquisitions', { collectionId: 'restart', entry: context.source + descriptor.entry });
    await context.restart();
    const collection = await context.call('/collections/restart');
    assert.equal(collection.status, 200);
    assert.deepEqual(collection.value.records.map(record => record.key), result.value.records.map(record => record.key));
    assert.equal(collection.value.explanation.state, 'explained');
    for (const record of collection.value.records) {
      for (const origin of record.provenance) {
        const receipt = await context.call('/receipts/' + origin.receiptId);
        assert.equal(receipt.status, 200);
        assert.equal(receipt.value.collectionId, 'restart');
      }
    }
    const external = collection.value.records.find(record => record.kind === 'source-content' && record.value.sourceKind === 'external');
    const body = await fetch(context.base + '/receipts/' + external.value.receiptId + '/body').then(response => response.text());
    assert.equal(body, 'export const tail = 3;\n');
  } finally { await context.close(); }
});

test('外部源码写入另一版本时按各自取件结果记录，不覆盖同名文件', async () => {
  const archive = await temporaryArchive();
  const { createServer } = await import('node:http');
  const versions = new Map([
    ['/one.map', { version: 3, sourceRoot: 'src/', sources: ['same.ts'], names: [], mappings: 'AAAA' }],
    ['/two.map', { version: 3, sourceRoot: 'src/', sources: ['same.ts'], names: [], mappings: 'AAAA' }],
    ['/src/same.ts', 'first revision']
  ]);
  let current = 'first revision';
  const server = createServer((request, response) => {
    if (request.url === '/src/same.ts') {
      response.writeHead(200, { 'content-type': 'text/plain', etag: '"' + current + '"' });
      response.end(current);
      return;
    }
    const body = JSON.stringify(versions.get(request.url));
    response.writeHead(200, { 'content-type': 'application/json', etag: '"' + body.length + '"' });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await acquire({ archive, collectionId: 'many', entry: origin + '/one.map', allowedOrigin: origin });
    current = 'second revision';
    const second = await acquire({ archive, collectionId: 'many', entry: origin + '/two.map', allowedOrigin: origin });
    const firstSource = first.records.find(record => record.kind === 'source-content' &&
      record.value.map?.receiptId === first.explanation.maps[0].receiptId);
    const secondSource = second.records.filter(record => record.kind === 'source-content')
      .find(record => record.value.receiptId && record.value.receiptId !== firstSource.value.receiptId);
    assert.ok(firstSource && secondSource, '同名文件的两个版本应分别记录');
    const collection = await archive.collection('many');
    assert.equal(collection.records.filter(record => record.kind === 'source-content').length, 2);
    assert.equal((await archive.body(firstSource.value.receiptId)).toString(), 'first revision');
    assert.equal((await archive.body(secondSource.value.receiptId)).toString(), 'second revision');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('分段或源地址超出授权 origin 时不发起请求并说明缺口', async () => {
  const archive = await temporaryArchive();
  const { createServer } = await import('node:http');
  const external = 'http://outside.invalid/secret.map';
  const map = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, url: external },
      { offset: { line: 4, column: 0 }, map: { version: 3, sourceRoot: 'http://outside.invalid/', sources: ['x.ts'], names: [], mappings: 'AAAA' } }
    ]
  };
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json', etag: '"m"' });
    response.end(JSON.stringify(map));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await acquire({ archive, collectionId: 'scope', entry: origin + '/bundle.map', allowedOrigin: origin });
    assert.deepEqual(requests, ['/bundle.map']);
    assert.equal(result.explanation.state, 'partial');
    assert.ok(result.issues.some(value => value.reason === 'source-outside-authorization'));
    // The first segment is reported missing rather than silently dropped.
    const indexed = result.explanation.maps.find(value => value.kind === 'indexed');
    assert.equal(indexed.sections[0].state, 'missing');
    const source = result.records.find(record => record.kind === 'source-content');
    assert.equal(source.value.sourceKind, 'unavailable');
    assert.ok(!('text' in source.value), '不能伪造 unavailable 源正文');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('未支持的版本明确标注，不假装已解释', async () => {
  const archive = await temporaryArchive();
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', etag: '"m"' });
    response.end(JSON.stringify({ version: 4, mappings: 'AAAA' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await acquire({ archive, collectionId: 'version', entry: origin + '/bundle.map', allowedOrigin: origin });
    assert.equal(result.explanation.state, 'partial');
    assert.ok(result.issues.some(value => value.reason === 'map-version-unsupported'));
    assert.equal(result.records.filter(record => record.kind === 'mapped-position').length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('位置解释只依赖本段已知起点，不跨行或跨未映射区间继承源码', async () => {
  const context = await harness();
  try {
    await context.call('/acquisitions', { collectionId: 'query', entry: context.source + descriptor.entry });
    // Inline map section at line 0/column 3: segment starts at 1:3 (a.ts:1:0),
    // unmapped at 1:8, then 2:0 (a.ts:2:0).
    const mapped = await context.call('/collections/query/positions?line=1&column=3');
    assert.equal(mapped.status, 200);
    assert.equal(mapped.value.state, 'mapped');
    assert.equal(mapped.value.mapped.sourcePath, '/src/a.ts');
    assert.equal(mapped.value.mapped.originalLine, 1);

    const unmapped = await context.call('/collections/query/positions?line=1&column=9');
    assert.equal(unmapped.value.state, 'unmapped');
    assert.deepEqual(unmapped.value.rangeStart, { generatedLine: 1, generatedColumn: 8 });
    assert.ok(!('mapped' in unmapped.value), '未映射区间不能沿用上一个源码位置');

    // Column offset applies only to the first line of a section.
    const secondLine = await context.call('/collections/query/positions?line=2&column=0');
    assert.equal(secondLine.value.state, 'mapped');
    assert.equal(secondLine.value.mapped.originalLine, 2);

    const unknown = await context.call('/collections/query/positions?line=9&column=0');
    assert.equal(unknown.value.state, 'unknown');
    assert.ok(!('mapped' in unknown.value));

    const before = await context.call('/collections/query/positions?line=1&column=1');
    assert.equal(before.value.state, 'unknown');

    const invalid = await context.call('/collections/query/positions?line=1');
    assert.equal(invalid.status, 400);
  } finally { await context.close(); }
});

test('同一资料集多次领取时，较晚的成功不会掩盖较早分段的缺口', async () => {
  const archive = await temporaryArchive();
  const { createServer } = await import('node:http');
  const partialMap = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['ok.ts'], names: [], mappings: 'AAAA' } },
      { offset: { line: 1, column: 0 }, url: '/missing.map' }
    ]
  };
  const completeMap = { version: 3, sources: ['ok2.ts'], names: [], mappings: 'AAAA' };
  const server = createServer((request, response) => {
    if (request.url === '/missing.map') { response.writeHead(404); response.end('nope'); return; }
    const value = request.url === '/partial.map' ? partialMap : request.url === '/complete.map' ? completeMap : 'source';
    response.writeHead(200, { 'content-type': request.url.endsWith('.map') ? 'application/json' : 'text/plain', etag: '"' + request.url + '"' });
    response.end(typeof value === 'string' ? value : JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await acquire({ archive, collectionId: 'mixed', entry: origin + '/partial.map', allowedOrigin: origin });
    assert.equal(first.explanation.state, 'partial');
    const second = await acquire({ archive, collectionId: 'mixed', entry: origin + '/complete.map', allowedOrigin: origin });
    assert.equal(second.explanation.state, 'partial', '后续完整条目不能把资料集宣称为完整');
    assert.equal(second.explanation.acquisitions.length, 2);
    const missing = second.explanation.sections.items.filter(section => section.state === 'missing');
    assert.equal(missing.length, 1);
    const collection = await archive.collection('mixed');
    assert.equal(collection.explanation.complete, false);
    assert.ok(collection.issues.some(value => value.reason === 'section-unavailable'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('缺失的根 map 在解释结果中单独列出，而不是只留下收件成功', async () => {
  const archive = await temporaryArchive();
  const { createServer } = await import('node:http');
  const delivery = { deliveryId: 'd', revision: 'r', roots: [{ href: '/missing.map' }], resources: [] };
  const server = createServer((request, response) => {
    if (request.url === '/missing.map') { response.writeHead(404); response.end('gone'); return; }
    response.writeHead(200, { 'content-type': 'application/json', etag: '"d"' });
    response.end(JSON.stringify(delivery));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await acquire({ archive, collectionId: 'lost', entry: origin + '/deliveries', allowedOrigin: origin });
    assert.equal(result.explanation.state, 'partial');
    assert.equal(result.explanation.maps.length, 1);
    assert.equal(result.explanation.maps[0].state, 'missing');
    assert.equal(result.explanation.maps[0].receiptId, null);
    assert.ok(result.issues.some(value => value.reason === 'map-unavailable'));
    assert.equal(result.records.filter(record => record.kind === 'mapped-position').length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

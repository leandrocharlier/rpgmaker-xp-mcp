// Synthetic regression fixtures; never open or execute a game or payload.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { PNG } from 'pngjs';
import { deflateSync } from 'node:zlib';
import { updateGameTitle } from '../dist/tools/systemTools.js';
import { decodePng } from '../dist/utils/tiles.js';
import { validateAssets } from '../dist/tools/assetTools.js';
import { writeRxdataFile, toPlain, toRuby } from '../dist/utils/rxdata.js';
import { runProjectOperation, checkValue, boundedStdioInput } from '../dist/utils/security.js';
import { blobCells, pathCells } from '../dist/tools/mapTools.js';
import { MAX_TABLE_BYTES } from '../dist/utils/tableValidation.js';

const root = await mkdtemp(join(tmpdir(), 'mcp-review-'));
const project = join(root, 'project');
await mkdir(join(project, 'Data'), { recursive: true });
await mkdir(join(project, 'Graphics'));
const run = fn => runProjectOperation(project, undefined, true, fn);
const findings = [];
async function test(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { findings.push(name); console.error('FAIL', name, e.message); }
}

await test('Latin-1 title conversion cannot inject INI keys', async () => {
  const ini = join(project, 'Game.ini');
  const original = '[Game]\r\nTitle=Original\r\nLibrary=original.dll\r\n';
  await writeFile(ini, original);
  await assert.rejects(run(() => updateGameTitle(project, 'Safe\u010aInjectedKey=marker')));
  assert.equal(await readFile(ini, 'utf8'), original);
  await run(() => updateGameTitle(project, 'Caf\u00e9 $&'));
  assert.ok((await readFile(ini, 'latin1')).includes('Title=Caf\u00e9 $&'));
});

await test('Fractional path coordinates reject instead of hanging', async () => {
  const workerFile = join(root, 'path-worker.mjs');
  await writeFile(workerFile, `import { parentPort } from 'node:worker_threads';
import { pathCells } from ${JSON.stringify(new URL('../dist/tools/mapTools.js', import.meta.url).href)};
parentPort.postMessage('started');
try { pathCells([[0,0],[0.5,0]], 1); parentPort.postMessage('accepted'); }
catch { parentPort.postMessage('rejected'); }`);
  const outcome = await new Promise((resolve, reject) => {
    const worker = new Worker(workerFile); let timer;
    worker.on('message', msg => {
      if (msg === 'started') timer = setTimeout(async () => { await worker.terminate(); resolve('timeout'); }, 500);
      else { clearTimeout(timer); resolve(msg); }
    });
    worker.on('error', e => { clearTimeout(timer); reject(e); });
  });
  assert.equal(outcome, 'rejected');
});

await test('Geometry work budgets reject oversized requests', async () => {
  // Do not run unbounded generators on an unfixed checkout.
  const source = await readFile(new URL('../src/tools/mapTools.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('Geometry work exceeds safety limits'));
  assert.throws(() => blobCells(0, 0, 1000000, 1000000), /safety limits/);
  assert.throws(() => pathCells([[0,0], [1000000,0]], 500), /safety limits/);
  assert.ok(pathCells([[0,0], [3,2]], 2).length > 0);
  assert.ok(blobCells(10, 10, 3, 4).length > 0);
});

function chunk(type, data) {
  const typeBytes = Buffer.from(type);
  const input = Buffer.concat([typeBytes, data]);
  let crc = 0xffffffff;
  for (const b of input) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); input.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}
const small = PNG.sync.write(new PNG({ width: 1, height: 1 }));
await test('Duplicate PNG headers rejected before decoding', async () => {
  const large = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  const file = join(project, 'duplicate.png');
  await writeFile(file, Buffer.concat([small.subarray(0,33), large.subarray(8)]));
  await assert.rejects(decodePng(file), /PNG/);
});
await test('Interlaced PNG inflation is bounded', async () => {
  const header = Buffer.from(small.subarray(16,29)); header[12] = 1;
  const file = join(project, 'interlaced-overflow.png');
  await writeFile(file, Buffer.concat([small.subarray(0,8), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(1024*1024))), chunk('IEND', Buffer.alloc(0))]));
  await assert.rejects(decodePng(file), /PNG decompression exceeds safety limits/);
  const normal = join(project, 'normal.png'); await writeFile(normal, small);
  assert.equal((await decodePng(normal)).width, 1);
  const valid = join(project, 'interlaced-valid.png');
  await writeFile(valid, Buffer.concat([small.subarray(0,8), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(5))), chunk('IEND', Buffer.alloc(0))]));
  assert.equal((await decodePng(valid)).width, 1);
});
await test('Asset directory junction cannot inspect external names', async () => {
  const outside = join(root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'private-marker.png'), 'marker');
  await symlink(outside, join(project, 'Graphics', 'Titles'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeRxdataFile(join(project, 'Data', 'System.rxdata'), { _class: 'RPG::System', title_name: 'private-marker' });
  await assert.rejects(run(() => validateAssets(project, { includeMaps: false })), /Linked|authorized/);
});
await test('Repeated strings cannot expand into unbounded JSON', async () => {
  const repeated = Array(20).fill('x'.repeat(1024 * 1024));
  assert.throws(() => toPlain(repeated), /expanded text/);
  assert.throws(() => checkValue(repeated), /Aggregate text/);
  const table = toRuby({ _class: 'Table', dim: 1, xsize: 100000, ysize: 1, zsize: 1, data: Array(100000).fill(0) });
  assert.throws(() => toPlain([table], 0, { nodes: 0, text: 0, tableBytes: MAX_TABLE_BYTES }), /Expanded Table/);
});
await test('Transport limits fragmented lines and permits separate messages', async () => {
  const stream = boundedStdioInput(16); stream.resume();
  const error = new Promise(resolve => stream.once('error', resolve));
  stream.write(Buffer.from('123456789\n123456789\n'));
  stream.write(Buffer.from('123456789'));
  stream.write(Buffer.from('123456789'));
  assert.match((await error).message, /input line/);
});
console.log('Scratch fixtures:', root);
if (findings.length) { console.error('Failed:', findings.join(', ')); process.exitCode = 1; }

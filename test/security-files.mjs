import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, link, open, unlink } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { runProjectOperation, readLimited, atomicWriteFile, contained } from '../dist/utils/security.js';
import { decodePng } from '../dist/utils/tiles.js';
import { load } from '../dist/vendor/marshal/index.js';
import { readRxdataFile, writeRxdataRaw } from '../dist/utils/rxdata.js';
import { deflateSync } from 'node:zlib';
import { getScript } from '../dist/tools/scriptTools.js';

assert.ok(process.argv[2], 'Pass an existing scratch parent directory');
const project = await mkdtemp(join(resolve(process.argv[2]), 'mcp-files-'));
await mkdir(join(project, 'Data'));
const file = join(project, 'Game.ini');
await writeFile(file, 'original');
const run = fn => runProjectOperation(project, undefined, true, fn);
await assert.rejects(run(async () => {
  await atomicWriteFile(file, 'must not persist');
  throw new Error('simulated tool failure');
}), /simulated tool failure/);
assert.equal(await readFile(file, 'utf8'), 'original');
await assert.rejects(run(async () => {
  await readLimited(file);
  await writeFile(file, 'external editor changed this');
  await atomicWriteFile(file, 'stale update');
}), /changed outside/);
assert.equal(await readFile(file, 'utf8'), 'external editor changed this');
await run(() => atomicWriteFile(file, 'revision one'));
await run(() => atomicWriteFile(file, 'revision two'));
const backups = await readdir(join(project, '.mcp-backup'));
assert.equal(backups.length, 2);
const contents = await Promise.all(backups.map(f => readFile(join(project, '.mcp-backup', f), 'utf8')));
assert.ok(contents.includes('external editor changed this') && contents.includes('revision one'));

await mkdir(join(project, 'bad-destination'));
await assert.rejects(run(async () => {
  await atomicWriteFile(file, 'partial change');
  await atomicWriteFile(join(project, 'bad-destination'), 'not a regular file');
}));
assert.equal(await readFile(file, 'utf8'), 'revision two');

// Simulate a failure after the first rename, verifying actual rollback.
const second = join(project, 'Data', 'second.ini');
await writeFile(second, 'second original');
const realRename = fs.promises.rename;
let injected = false;
try {
  fs.promises.rename = async (from, to) => {
    if (to === second && !injected) { injected = true; throw new Error('injected rename failure'); }
    return realRename(from, to);
  };
  syncBuiltinESMExports();
  await assert.rejects(run(async () => {
    await atomicWriteFile(file, 'partial change');
    await atomicWriteFile(second, 'second change');
  }), /injected rename failure/);
} finally { fs.promises.rename = realRename; syncBuiltinESMExports(); }
assert.ok(injected);
assert.equal(await readFile(file, 'utf8'), 'revision two');
assert.equal(await readFile(second, 'utf8'), 'second original');
const lock = join(project, 'Data', '.mcp-write.lock');
await writeFile(lock, 'other process');
await assert.rejects(run(() => atomicWriteFile(second, 'must not persist')), /locked/);
assert.equal(await readFile(lock, 'utf8'), 'other process');
await unlink(lock);

const alias = join(project, 'hardlink.ini');
await link(file, alias);
assert.throws(() => contained(project, alias), /Linked/);
const huge = join(project, 'oversized.dat');
const handle = await open(huge, 'wx');
await handle.truncate(64 * 1024 * 1024 + 1); await handle.close();
await assert.rejects(run(() => readLimited(huge)), /64 MiB/);
const png = Buffer.alloc(24);
Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
png.writeUInt32BE(100000, 16); png.writeUInt32BE(100000, 20);
await writeFile(join(project, 'oversized.png'), png);
await assert.rejects(decodePng(join(project, 'oversized.png')), /megapixel/);
assert.throws(() => load(Buffer.from([4, 8, 91, 4, 255, 255, 255, 127])), /safety limits/);
await writeFile(join(project, 'cycle.rxdata'), Buffer.from([4, 8, 91, 6, 64, 0]));
await assert.rejects(readRxdataFile(join(project, 'cycle.rxdata')), /safety limits/);
await writeRxdataRaw(join(project, 'Data', 'Scripts.rxdata'), [[1, Buffer.from('large'), deflateSync(Buffer.alloc(4 * 1024 * 1024 + 1))]]);
await assert.rejects(getScript(project, 0), /larger than|size|length/i);
assert.ok(!(await readdir(join(project, 'Data'))).includes('.mcp-write.lock'));
console.log('PASS staging rollback, external changes, versioned backups, hardlinks, bounded files/PNG/Marshal/zlib and lock cleanup');

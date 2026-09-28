import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteFile, safeMkdir, runProjectOperation, readLimited, guardProjectReads } from '../dist/utils/security.js';

const root = await mkdtemp(join(tmpdir(),'mcp-dependencies-'));
await mkdir(join(root,'Data'));
const source = join(root,'Data','source.txt'), target = join(root,'Data','target.txt');
await writeFile(source,'source-v1'); await writeFile(target,'target-v1');
await assert.rejects(() => runProjectOperation(root,undefined,false,()=>atomicWriteFile(target,'bad')), /Read-only/);
await assert.rejects(() => runProjectOperation(root,undefined,false,()=>safeMkdir(join(root,'should-not-exist'))), /Read-only/);
await assert.rejects(() => access(join(root,'should-not-exist')));
assert.equal(await readFile(target,'utf8'),'target-v1');
console.log('PASS read-only operations cannot stage files or create directories');

await assert.rejects(() => runProjectOperation(root,undefined,true,async()=>{
  await readLimited(source);
  guardProjectReads([source]);
  await atomicWriteFile(target,'derived');
  await writeFile(source,'external-change');
}), /changed outside/);
assert.equal(await readFile(target,'utf8'),'target-v1');
await runProjectOperation(root,undefined,true,async()=>{
  await readLimited(source); await readLimited(target);
  guardProjectReads([source,target]);
  await atomicWriteFile(target,'derived-safe');
});
assert.equal(await readFile(target,'utf8'),'derived-safe');
console.log('PASS source changes block commit and guarded staged destinations do not self-conflict');
await assert.rejects(() => runProjectOperation(root,undefined,true,async()=>guardProjectReads([join(root,'unread')])), /must be read/);
await assert.rejects(() => access(join(root,'Data','.mcp-write.lock')));
console.log('PASS unread dependencies rejected and locks released');

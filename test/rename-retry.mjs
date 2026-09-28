// Inject only filesystem rename failures on disposable synthetic data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProjectOperation, atomicWriteFile } from '../dist/utils/security.js';
import { writeRxdataFile, readRxdataFile } from '../dist/utils/rxdata.js';
import { makeTable } from '../dist/utils/types.js';
import { cloneTileset } from '../dist/tools/tilesetTools.js';

const root=await mkdtemp(join(tmpdir(),'mcp-rename-retry-'));
await mkdir(join(root,'Data'));
const db=join(root,'Data','Tilesets.rxdata');
await writeRxdataFile(db,[null,{_class:'RPG::Tileset',id:1,name:'Synthetic',tileset_name:'synthetic',autotile_names:[],passages:makeTable(392,1,1),priorities:makeTable(392,1,1),terrain_tags:makeTable(392,1,1)}]);
const a=join(root,'Data','a.bin'),b=join(root,'Data','b.bin'),fresh=join(root,'Data','new.bin');
const aOld=Buffer.from([0,255,10,32,123]),bOld=Buffer.from([255,0,10,33]);
const lock=join(root,'Data','.mcp-write.lock');
const realRename=fs.promises.rename;
const error=code=>Object.assign(new Error(`injected ${code}`),{code});
const run=fn=>runProjectOperation(root,undefined,true,fn);
async function withRename(hook,fn) {
  try {fs.promises.rename=hook;syncBuiltinESMExports();return await fn();}
  finally {fs.promises.rename=realRename;syncBuiltinESMExports();}
}
async function clean() {
  const files=await readdir(join(root,'Data'));
  assert.ok(!files.some(f=>f.endsWith('.tmp')));
  assert.ok(!files.includes('.mcp-write.lock'));
}
async function reset() {await writeFile(a,aOld);await writeFile(b,bOld);}

let attempts=0,calls=0;const temps=new Set();
await withRename(async(from,to)=>{
  if(to===db){await access(lock);temps.add(from);attempts++;if(attempts<3)throw error(attempts===1?'EPERM':'EBUSY');}
  return realRename(from,to);
},()=>run(async()=>{calls++;return cloneTileset(root,1,{name:'Only one clone'});}));
assert.equal(calls,1);assert.equal(attempts,3);assert.equal(temps.size,1);
const entries=await readRxdataFile(db);assert.equal(entries.length,3);assert.equal(entries[2].id,2);
assert.equal((await readdir(join(root,'Data','.mcp-backup'))).filter(f=>f.startsWith('Tilesets.rxdata.')).length,1);
await clean();console.log('PASS EPERM/EBUSY retry succeeds with one tool execution, one temp, one backup and no duplicate clone');

await reset();let failures=0,restoreTries=0;
await withRename(async(from,to)=>{
  if(to===b){failures++;throw error('EPERM');}
  if(to===a&&(await readFile(from)).equals(aOld)){restoreTries++;if(restoreTries===1)throw error('EBUSY');}
  return realRename(from,to);
},()=>assert.rejects(run(async()=>{await atomicWriteFile(a,'new a');await atomicWriteFile(b,'new b');}),/EPERM/));
assert.equal(failures,5);assert.equal(restoreTries,2);
assert.deepEqual(await readFile(a),aOld);assert.deepEqual(await readFile(b),bOld);
await clean();console.log('PASS persistent failure is bounded; rollback also retries and restores exact bytes');

await reset();attempts=0;
await withRename(async(from,to)=>{
  if(to===b){attempts++;await writeFile(b,'external edit');throw error('EBUSY');}
  return realRename(from,to);
},()=>assert.rejects(run(async()=>{await atomicWriteFile(a,'new a');await atomicWriteFile(b,'new b');}),/changed outside/));
assert.equal(attempts,1);assert.deepEqual(await readFile(a),aOld);assert.equal(await readFile(b,'utf8'),'external edit');
await clean();console.log('PASS recheck during retry preserves external edits and rolls back earlier replacement');

attempts=0;
await withRename(async(from,to)=>{
  if(to===fresh){attempts++;await writeFile(fresh,'external creation');throw error('EPERM');}
  return realRename(from,to);
},()=>assert.rejects(run(()=>atomicWriteFile(fresh,'must not replace')),/changed outside/));
assert.equal(attempts,1);assert.equal(await readFile(fresh,'utf8'),'external creation');
await clean();console.log('PASS external creation at previously absent destination is not overwritten');

await reset();attempts=0;
await withRename(async(from,to)=>{
  if(to===b){attempts++;if(attempts===1)await writeFile(a,'external after first commit');throw error('EBUSY');}
  return realRename(from,to);
},()=>assert.rejects(run(async()=>{await atomicWriteFile(a,'new a');await atomicWriteFile(b,'new b');}),/restore versioned backups/));
assert.equal(attempts,5);assert.equal(await readFile(a,'utf8'),'external after first commit');assert.deepEqual(await readFile(b),bOld);
await clean();console.log('PASS rollback refuses to clobber an external edit and reports manual recovery');

await reset();attempts=0;
await withRename(async()=>{attempts++;throw error('EACCES');},()=>assert.rejects(run(()=>atomicWriteFile(a,'new a')),/EACCES/));
assert.equal(attempts,1);assert.deepEqual(await readFile(a),aOld);await clean();
console.log('PASS other errors are not retried; no residual temp files or locks');
console.log('Synthetic fixtures:',root);

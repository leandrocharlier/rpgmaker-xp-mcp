import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink, access } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readRxdataFile, writeRxdataFile } from '../dist/utils/rxdata.js';
import { makeMap, makeMapInfo, makeTable } from '../dist/utils/types.js';
import { truncateUnusedTilesets } from '../dist/tools/tilesetPruneTools.js';
import { runProjectOperation, atomicWriteFile } from '../dist/utils/security.js';

const root=await mkdtemp(join(tmpdir(),'mcp-truncate-'));const data=join(root,'Data');await mkdir(data);
const db=join(data,'Tilesets.rxdata'),infos=join(data,'MapInfos.rxdata'),map1=join(data,'Map001.rxdata'),orphan=join(data,'Map777.rxdata');
const entries=[null,...Array.from({length:5},(_,i)=>({_class:'RPG::Tileset',id:i+1,name:`Synthetic ${i+1}`,tileset_name:'unchanged',passages:makeTable(392,1,1),priorities:makeTable(392,1,1),terrain_tags:makeTable(392,1,1)}))];
await writeRxdataFile(db,entries);await writeRxdataFile(infos,{'1':makeMapInfo('Listed')});
await writeRxdataFile(map1,makeMap(20,15,1));await writeRxdataFile(orphan,makeMap(20,15,4));
const system=join(data,'System.rxdata');await writeRxdataFile(system,{_class:'RPG::System',magic_number:1});
await writeFile(join(root,'asset.png'),'synthetic asset sentinel');
const original=await readFile(db),systemBefore=await readFile(system),infosBefore=await readFile(infos);
const client=new Client({name:'truncate-test',version:'1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,RPGMAKER_PROJECT_PATH:root},stderr:'pipe'}));
const call=args=>client.callTool({name:'truncate_unused_tilesets',arguments:args});
const value=r=>{assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
const lock=join(data,'.mcp-write.lock');
try {
  await writeFile(lock,'existing lock');
  const dry=value(await call({fromId:3}));assert.equal(dry.dryRun,true);assert.equal(dry.canTruncate,false);assert.equal(dry.mapsScanned,2);
  assert.deepEqual(dry.references,[{mapId:777,file:'Map777.rxdata',tilesetId:4}]);
  assert.equal(await readFile(lock,'utf8'),'existing lock');await unlink(lock);
  assert.equal((await call({fromId:3,dryRun:false})).isError,true);assert.deepEqual(await readFile(db),original);
  await assert.rejects(access(join(data,'.mcp-backup')));
  console.log('PASS dry-run is read-only and finds references in maps absent from MapInfos; mutation refused');

  await writeRxdataFile(orphan,makeMap(20,15,2));
  const bad=join(data,'Map778.rxdata');await writeFile(bad,'invalid map');
  assert.equal((await call({fromId:3})).isError,true);await unlink(bad);
  await writeRxdataFile(infos,{'1':makeMapInfo('Listed'),'2':makeMapInfo('Missing')});
  assert.equal((await call({fromId:3,dryRun:false})).isError,true);await writeFile(infos,infosBefore);
  assert.deepEqual(await readFile(db),original);
  console.log('PASS unreadable on-disk maps and missing indexed maps fail closed');

  const mapsBefore=await Promise.all([map1,orphan].map(p=>readFile(p)));
  const result=value(await call({fromId:3,dryRun:false}));assert.equal(result.removedSlots,3);
  assert.deepEqual(await readRxdataFile(db),entries.slice(0,3));
  assert.deepEqual(await Promise.all([map1,orphan].map(p=>readFile(p))),mapsBefore);
  assert.deepEqual(await readFile(system),systemBefore);assert.deepEqual(await readFile(infos),infosBefore);
  assert.equal(await readFile(join(root,'asset.png'),'utf8'),'synthetic asset sentinel');
  const backups=await readdir(join(data,'.mcp-backup'));
  assert.ok((await Promise.all(backups.map(p=>readFile(join(data,'.mcp-backup',p))))).some(b=>b.equals(original)));
  assert.equal(value(await call({fromId:3,dryRun:false})).removedSlots,0);
  assert.equal((await call({fromId:4,dryRun:false})).isError,true);
  console.log('PASS suffix truncated, preceding IDs/flags/maps/assets preserved, backup intact and repeat is a no-op');
} finally {await client.close();}

const run=fn=>runProjectOperation(root,undefined,true,fn);
await writeFile(db,original);const mapBefore=await readFile(map1);
await assert.rejects(run(async()=>{await truncateUnusedTilesets(root,3,false);await writeRxdataFile(map1,makeMap(20,15,4));}),/reference data changed/);
// The synthetic map write above was staged: guard must also notice it before commit.
assert.deepEqual(await readFile(db),original);assert.deepEqual(await readFile(map1),mapBefore);
const added=join(data,'Map999.rxdata');
await assert.rejects(run(async()=>{await truncateUnusedTilesets(root,3,false);await writeFile(added,mapBefore);}),/inventory changed/);
assert.deepEqual(await readFile(db),original);await unlink(added);
console.log('PASS commit guards reject changed maps and newly added files');

const realRename=fs.promises.rename;let attempts=0;
try {
  fs.promises.rename=async(from,to)=>{if(to===db){attempts++;await writeFile(map1,Buffer.from(await readFile(orphan)));throw Object.assign(new Error('busy'),{code:'EPERM'});}return realRename(from,to);};syncBuiltinESMExports();
  await assert.rejects(run(()=>truncateUnusedTilesets(root,3,false)),/reference data changed/);
} finally {fs.promises.rename=realRename;syncBuiltinESMExports();}
assert.equal(attempts,1);assert.deepEqual(await readFile(db),original);await writeFile(map1,mapBefore);
console.log('PASS reference hashes rechecked during rename backoff');

const marker=join(root,'after.bin');let injected=false;
try {
  fs.promises.rename=async(from,to)=>{if(to===marker){injected=true;throw new Error('injected later failure');}return realRename(from,to);};syncBuiltinESMExports();
  await assert.rejects(run(async()=>{await truncateUnusedTilesets(root,3,false);await atomicWriteFile(marker,'later');}),/injected later failure/);
} finally {fs.promises.rename=realRename;syncBuiltinESMExports();}
assert.ok(injected);assert.deepEqual(await readFile(db),original);await assert.rejects(access(marker));
assert.ok(!(await readdir(data)).some(p=>p.endsWith('.tmp')||p==='.mcp-write.lock'));
console.log('PASS byte-for-byte rollback and no residual locks/temporaries');
console.log('Synthetic fixtures:',root);

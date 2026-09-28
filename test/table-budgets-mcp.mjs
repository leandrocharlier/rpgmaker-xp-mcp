import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeTable } from '../dist/utils/types.js';
import { writeRxdataFile, readRxdataFile, toRuby, toPlain } from '../dist/utils/rxdata.js';
import { RubyObject } from '../dist/vendor/marshal/index.js';
import { checkValue, runProjectOperation, atomicWriteFile } from '../dist/utils/security.js';
import { MAX_TABLE_BYTES } from '../dist/utils/tableValidation.js';
import { updateTileProperties } from '../dist/tools/tilesetTools.js';

const root=await mkdtemp(join(tmpdir(),'mcp-table-budgets-'));
await mkdir(join(root,'Data'));await mkdir(join(root,'Graphics','Tilesets'),{recursive:true});
await writeFile(join(root,'Graphics','Tilesets','base.png'),PNG.sync.write(new PNG({width:256,height:32})));
await writeFile(join(root,'piece.png'),PNG.sync.write(new PNG({width:32,height:32})));
await writeRxdataFile(join(root,'Data','System.rxdata'),{_class:'RPG::System',magic_number:1});
const entries=[null];
for(let id=1;id<=116;id++) {
  const entry={_class:'RPG::Tileset',id,name:`Synthetic ${id}`,tileset_name:'base',autotile_names:[],custom:'keep'};
  for(const [field,mod] of [['passages',256],['priorities',6],['terrain_tags',100]]) {
    entry[field]=makeTable(12000,1,1);
    for(let i=0;i<12000;i++)entry[field].data[i]=(i+id)%mod;
  }
  entries.push(entry);
}
const path=join(root,'Data','Tilesets.rxdata');
await writeRxdataFile(path,entries);
assert.deepEqual(await readRxdataFile(path),entries);
console.log('PASS roundtrip 116 tilesets with 4,176,000 signed table cells; all flags and records intact');
const client=new Client({name:'table-budgets-test',version:'1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,RPGMAKER_PROJECT_PATH:root},stderr:'pipe'}));
const value=r=>{assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
try {
  const listed=value(await client.callTool({name:'get_database',arguments:{kind:'tilesets'}}));assert.equal(listed.length,116);
  const clone=value(await client.callTool({name:'clone_tileset',arguments:{sourceTilesetId:116,name:'Resume'}}));assert.equal(clone.id,117);
  const composed=value(await client.callTool({name:'compose_tileset_atlas',arguments:{outputName:'appended',appendToTilesetId:117,pieces:[{sourcePath:'piece.png',rect:{x:0,y:0,width:32,height:32}}]}}));
  assert.equal(composed.tableSize,12008);
  const after=await readRxdataFile(path);assert.deepEqual(after.slice(0,117),entries);
  for(const field of ['passages','priorities','terrain_tags']) {
    assert.deepEqual(after[117][field].data.slice(0,12000),entries[116][field].data);
    assert.deepEqual(after[117][field].data.slice(12000),Array(8).fill(0));
  }
  console.log('PASS real MCP listing, cloning and composition beyond 116 records, preserving original flags');
} finally {await client.close();}

const table=makeTable(1,1,1);
for(const invalid of [{...table,dim:0},{...table,ysize:2},{...table,data:[]},{...table,data:['0']},{...table,data:[{}]},
  ...[32768,-32769,1.5,NaN,Infinity].map(n=>({...table,data:[n]}))]) assert.throws(()=>toRuby(invalid),/Table/);
const raw=new RubyObject(Symbol.for('Table'));raw.userDefined=new Uint8Array(10);
assert.throws(()=>toPlain(raw),/Truncated Table/);
raw.userDefined=new Uint8Array(20);assert.throws(()=>toPlain(raw),/Table/);
const million=makeTable(1000000,1,1);
assert.throws(()=>checkValue(Array(17).fill(million)),/Expanded Table/);
assert.throws(()=>toPlain(toRuby(table),0,{nodes:0,text:0,tableBytes:MAX_TABLE_BYTES}),/Expanded Table/);
assert.throws(()=>checkValue(Array(1000001).fill(0)),/structure/);
let nested=0;for(let i=0;i<66;i++)nested=[nested];assert.throws(()=>checkValue(nested),/structure/);
assert.throws(()=>checkValue(['x'.repeat(4*1024*1024+1)]),/String/);
assert.throws(()=>checkValue(JSON.parse('{"__proto__":{}}')),/Unsafe/);
const badPath=join(root,'Data','invalid.rxdata');
await assert.rejects(writeRxdataFile(badPath,{...table,data:[32768]}),/Table/);await assert.rejects(access(badPath));
console.log('PASS malformed table shape/cells/payloads, aggregate alias expansion, generic nodes/depth/text and unsafe-key limits');

const stable=await readFile(path), realRename=fs.promises.rename, second=join(root,'after.bin');let injected=false;
try {
  fs.promises.rename=async(from,to)=>{if(to===second&&!injected){injected=true;throw new Error('injected large-database rollback');}return realRename(from,to);};syncBuiltinESMExports();
  await assert.rejects(runProjectOperation(root,undefined,true,async()=>{
    await updateTileProperties(root,117,{tileIds:[0],passage:123});await atomicWriteFile(second,'marker');
  }),/injected large-database/);
} finally {fs.promises.rename=realRename;syncBuiltinESMExports();}
assert.ok(injected);assert.deepEqual(await readFile(path),stable);await assert.rejects(access(second));
console.log('PASS late commit failure rolls back the large database byte-for-byte');
console.log('Synthetic fixtures:',root);

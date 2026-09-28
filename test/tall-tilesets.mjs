import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { canvasBudget, hardenSchema, runProjectOperation } from '../dist/utils/security.js';
import { makeCanvas, encodePng, decodePng } from '../dist/utils/tiles.js';
import { makeTable, makeMap } from '../dist/utils/types.js';
import { readRxdataFile, writeRxdataFile } from '../dist/utils/rxdata.js';

const root = await mkdtemp(join(tmpdir(), 'mcp-tall-'));
await mkdir(join(root, 'Data'));
await mkdir(join(root, 'Graphics', 'Tilesets'), { recursive: true });
const graphic = name => join(root, 'Graphics', 'Tilesets', name + '.png');
delete process.env.RPGMAKER_ALLOW_TALL_XP_TILESETS;
assert.throws(() => canvasBudget(256,65568,true));
process.env.RPGMAKER_ALLOW_TALL_XP_TILESETS = '1';
canvasBudget(256,129536,true);
for (const [w,h,profile] of [[256,129568,true],[256,65569,true],[257,65536,true],[256,65568,false]]) {
  assert.throws(() => canvasBudget(w,h,profile));
}
canvasBudget(4096,4096);
const schema = {type:'object',properties:{height:{type:'integer'},rect:{type:'object',properties:{height:{type:'integer',maximum:500}}}}};
hardenSchema(schema);
assert.equal(schema.properties.height.maximum,500);
assert.equal(schema.properties.rect.properties.height.maximum,129536);
console.log('PASS opt-in geometry, ID ceiling, general image limit, map vs pixel schemas');

let image = makeCanvas(256,65568,true);
image.data.set([23,45,67,255], (65567*256)*4);
const tallBytes = encodePng(image,true);
image = null;
await writeFile(graphic('tall'),tallBytes);
await assert.rejects(() => decodePng(graphic('tall')));
const bad = Buffer.from(tallBytes); bad.writeUInt32BE(129568,20);
await writeFile(graphic('bad'),bad);
await assert.rejects(() => decodePng(graphic('bad'),true), /limit/);
await assert.rejects(() => runProjectOperation(root,undefined,false,async()=>{
  await decodePng(graphic('tall'),true);
  await decodePng(graphic('tall'),true);
}), /aggregate decode/);
console.log('PASS default decode rejection, oversized header rejected before inflate, aggregate decode budget');

await writeFile(graphic('base'),encodePng(makeCanvas(256,32)));
const record = {_class:'RPG::Tileset',id:1,name:'Base',tileset_name:'base',autotile_names:[],
  passages:makeTable(392,1,1),priorities:makeTable(392,1,1),terrain_tags:makeTable(392,1,1)};
record.passages.data[384] = 15;
await writeRxdataFile(join(root,'Data','Tilesets.rxdata'),[null,record]);
await writeRxdataFile(join(root,'Data','System.rxdata'),{_class:'RPG::System',magic_number:1});
const map = makeMap(1,1); map.tileset_id=1; map.data.data[0]=384+65568/4;
await writeRxdataFile(join(root,'Data','Map001.rxdata'),map);
const client = new Client({name:'tall-test',version:'1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,RPGMAKER_PROJECT_PATH:root},stderr:'pipe'}));
async function call(name,args) {
  const result = await client.callTool({name,arguments:args},undefined,{timeout:120000});
  assert.ok(!result.isError,JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
try {
  const result = await call('compose_tileset_atlas',{outputName:'combined',appendToTilesetId:1,pieces:[{sourcePath:graphic('tall'),rect:{x:0,y:0,width:256,height:65568}}]});
  assert.equal(result.height,65600);
  const db = await readRxdataFile(join(root,'Data','Tilesets.rxdata'));
  assert.equal(db[1].passages.data[384],15);
  let decoded = await decodePng(graphic('combined'),true);
  assert.deepEqual([...decoded.data.subarray(65599*256*4,65599*256*4+4)],[23,45,67,255]);
  decoded=null;
  const rendered = await call('render_map',{mapId:1,scale:1});
  const preview = await decodePng(rendered.path);
  assert.deepEqual([...preview.data.subarray(31*32*4,31*32*4+4)],[23,45,67,255]);
  const registered = await call('register_tileset',{graphicName:'combined',force:true});
  assert.equal(registered.ok,true); assert.equal(registered.table_size,384+65600/4);
  const before = await readFile(join(root,'Data','Tilesets.rxdata'));
  const rejected = await client.callTool({name:'compose_tileset_atlas',arguments:{outputName:'excess',appendToTilesetId:1,pieces:[{sourcePath:graphic('tall'),rect:{x:0,y:0,width:256,height:65568}}]}});
  assert.ok(rejected.isError);
  assert.deepEqual(await readFile(join(root,'Data','Tilesets.rxdata')),before);
  console.log('PASS SDK tall rectangle composition, exact pixels/prefix flags, map render, registration and oversized append without DB writes');
} finally { await client.close(); }
console.log(`Synthetic fixtures: ${root}`);

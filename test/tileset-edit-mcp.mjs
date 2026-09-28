import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeMap, makeTable, makeEventPage } from '../dist/utils/types.js';
import { readRxdataFile, writeRxdataFile } from '../dist/utils/rxdata.js';

const root = await mkdtemp(join(tmpdir(), 'mcp-tileset-edit-'));
const data = join(root, 'Data'), graphics = join(root, 'Graphics', 'Tilesets');
await mkdir(data); await mkdir(graphics, { recursive: true });
const tsPath = join(data, 'Tilesets.rxdata'), mapPath = join(data, 'Map001.rxdata'), systemPath = join(data, 'System.rxdata');
const source = { _class: 'RPG::Tileset', id: 1, name: 'Synthetic', tileset_name: 'small', autotile_names: ['water','','','','','',''], panorama_name: 'sky', custom_value: 42 };
for (const [field, max] of [['passages',16], ['priorities',6], ['terrain_tags',9]]) {
  source[field] = makeTable(392,1,1); source[field].data = source[field].data.map((_,i) => i % max);
}
const unrelated = structuredClone(source); unrelated.id = 2; unrelated.name = 'Other';
await writeRxdataFile(tsPath, [null, source, unrelated]);
const map = makeMap(20,15,1); map.data.data[0] = 391;
const page = makeEventPage(); page.graphic.tile_id = 390;
page.list[0].custom_value = 'must remain';
map.events['1'] = { _class: 'RPG::Event', id: 1, name: 'Existing', x: 1, y: 1, pages: [page] };
await writeRxdataFile(mapPath, map);
await writeRxdataFile(join(data,'Map002.rxdata'), map);
await writeRxdataFile(systemPath, { _class: 'RPG::System', magic_number: 10, custom_value: 'keep' });
for (const [name,height] of [['small',32],['large',64],['invalid',33]]) await writeFile(join(graphics, name+'.png'), PNG.sync.write(new PNG({width:256,height})));
const otherMapBytes = await readFile(join(data,'Map002.rxdata'));
const originalMapBytes = await readFile(mapPath);
const originalTsBytes = await readFile(tsPath);
const client = new Client({name:'tileset-edit-test',version:'1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,RPGMAKER_PROJECT_PATH:root},stderr:'pipe'}));
const call = (name,args) => client.callTool({name,arguments:args});
const success = response => { assert.ok(!response.isError, JSON.stringify(response)); return JSON.parse(response.content[0].text); };
async function reject(name,args) {
  const before = await Promise.all([tsPath,mapPath,systemPath].map(p=>readFile(p)));
  assert.equal((await call(name,args)).isError,true);
  const after = await Promise.all([tsPath,mapPath,systemPath].map(p=>readFile(p)));
  assert.deepEqual(after,before);
}
try {
  const {tools} = await client.listTools();
  for (const name of ['clone_tileset','update_tile_properties','set_map_tileset']) assert.ok(tools.some(t=>t.name===name));
  const clone = success(await call('clone_tileset',{sourceTilesetId:1,name:'Copy'}));
  assert.equal(clone.id,3);
  let entries = await readRxdataFile(tsPath);
  assert.deepEqual(entries.slice(0,3),[null,source,unrelated]);
  assert.deepEqual(entries[3],{...source,id:3,name:'Copy'});
  assert.deepEqual(await readFile(mapPath),originalMapBytes);
  console.log('PASS clone preserves all flags, settings, source and other records');

  const extended = success(await call('clone_tileset',{sourceTilesetId:1,name:'Extended',graphicName:'large.png'}));
  assert.equal(extended.id,4); assert.equal(extended.tableSize,400);
  entries = await readRxdataFile(tsPath);
  for(const field of ['passages','priorities','terrain_tags']) {
    assert.deepEqual(entries[4][field].data.slice(0,392),source[field].data);
    assert.deepEqual(entries[4][field].data.slice(392),Array(8).fill(0));
  }
  await reject('clone_tileset',{sourceTilesetId:4,graphicName:'small'});
  await reject('clone_tileset',{sourceTilesetId:1,graphicName:'invalid'});
  await reject('clone_tileset',{sourceTilesetId:999});
  console.log('PASS graphic extension preserves flags; shrink, malformed image and missing source rejected');

  const expected = structuredClone(entries);
  const result = success(await call('update_tile_properties',{tilesetId:4,tileIds:[0,384,384],ranges:[{start:390,end:399}],passage:79,priority:2,terrainTag:12}));
  assert.equal(result.updatedTiles,12);
  for(const id of [0,384,...Array.from({length:10},(_,i)=>390+i)]) {
    expected[4].passages.data[id]=79; expected[4].priorities.data[id]=2; expected[4].terrain_tags.data[id]=12;
  }
  assert.deepEqual(await readRxdataFile(tsPath),expected);
  success(await call('update_tile_properties',{tilesetId:4,tileIds:[385],priority:5}));
  expected[4].priorities.data[385]=5;
  assert.deepEqual(await readRxdataFile(tsPath),expected);
  for(const invalid of [{tileIds:[400],passage:0},{ranges:[{start:4,end:3}],priority:1},{tileIds:[-1],priority:1},{tileIds:[0.5],priority:1},{tileIds:[1],priority:6},{tileIds:[1],passage:256},{tileIds:[1],terrainTag:32768},{tileIds:[1]}, {priority:1}]) await reject('update_tile_properties',{tilesetId:4,...invalid});
  assert.deepEqual(await readFile(mapPath),originalMapBytes);
  console.log('PASS tile ID/range union updates only selected properties; bounds reject without writes');

  success(await call('set_map_tileset',{mapId:1,tilesetId:4}));
  assert.deepEqual(await readRxdataFile(mapPath),{...map,tileset_id:4});
  assert.deepEqual(await readRxdataFile(tsPath),expected);
  const system = await readRxdataFile(systemPath); assert.notEqual(system.magic_number,10); assert.equal(system.custom_value,'keep');
  assert.deepEqual(await readFile(join(data,'Map002.rxdata')),otherMapBytes);
  await reject('set_map_tileset',{mapId:1,tilesetId:999});
  await reject('set_map_tileset',{mapId:999,tilesetId:4});
  console.log('PASS map assignment preserves tiles, events, other maps and tileset records');

  // Synthetic external edits exercise capacity checks independently.
  const enlarged = {...map,tileset_id:4}; enlarged.data=structuredClone(map.data); enlarged.data.data[0]=399;
  await writeRxdataFile(mapPath,enlarged);
  await reject('set_map_tileset',{mapId:1,tilesetId:1});
  enlarged.data.data[0]=0; enlarged.events=structuredClone(map.events); enlarged.events['1'].pages[0].graphic.tile_id=399;
  await writeRxdataFile(mapPath,enlarged);
  await reject('set_map_tileset',{mapId:1,tilesetId:1});
  await writeFile(systemPath,'synthetic corruption');
  await reject('set_map_tileset',{mapId:1,tilesetId:4});
  assert.ok(!(await readdir(data)).includes('.mcp-write.lock'));
  console.log('PASS map/event capacity checks and atomic failure preserve files and release lock');

  const backups = await readdir(join(data,'.mcp-backup'));
  const snapshots = await Promise.all(backups.map(p=>readFile(join(data,'.mcp-backup',p))));
  assert.ok(snapshots.some(b=>b.equals(originalTsBytes)));
  assert.ok(snapshots.some(b=>b.equals(originalMapBytes)));
  console.log('PASS original map and tileset backups retained');
} finally { await client.close(); }
console.log('Synthetic fixtures:',root);

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeRxdataFile } from '../dist/utils/rxdata.js';
import { makeTable } from '../dist/utils/types.js';

const root=await mkdtemp(join(tmpdir(),'mcp-import-plan-'));
await mkdir(join(root,'Data')); await mkdir(join(root,'Graphics','Tilesets'),{recursive:true});
await writeFile(join(root,'Graphics','Tilesets','base.png'),PNG.sync.write(new PNG({width:256,height:32})));
await writeFile(join(root,'source.png'),PNG.sync.write(new PNG({width:256,height:256})));
await writeFile(join(root,'tall.png'),PNG.sync.write(new PNG({width:256,height:2048})));
function ts(id,size) {return {_class:'RPG::Tileset',id,name:'Synthetic',tileset_name:'base',autotile_names:[],passages:makeTable(size,1,1),priorities:makeTable(size,1,1),terrain_tags:makeTable(size,1,1)};}
await writeRxdataFile(join(root,'Data','Tilesets.rxdata'),[null,ts(1,392),ts(2,16760),ts(3,32768)]);
await writeRxdataFile(join(root,'Data','System.rxdata'),{_class:'RPG::System',magic_number:1});
const lock=join(root,'Data','.mcp-write.lock');await writeFile(lock,'external lock must stay untouched');
async function snapshot(dir=root) {
  const result={};
  for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path=join(dir,entry.name);
    result[entry.name]=entry.isDirectory()?await snapshot(path):createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return result;
}
const before=await snapshot();
const client=new Client({name:'import-plan-test',version:'1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,RPGMAKER_PROJECT_PATH:root,RPGMAKER_RTP_PATH:join(root,'rtp')},stderr:'pipe'}));
const call=args=>client.callTool({name:'plan_tileset_import',arguments:args});
const value=r=>{assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
const piece=(width=128,padding=0)=>({sourcePath:'source.png',rect:{x:0,y:0,width,height:16},padding});
try {
  const pieces=[{...piece(),objectId:'pair'},{...piece(),objectId:'pair'},piece(),piece()];
  const plan=value(await call({baseTilesetId:2,pieces}));
  assert.deepEqual(plan,value(await call({baseTilesetId:2,pieces})));
  assert.equal(plan.bank_count,2);assert.equal(plan.prefix.reserved_height,65504);
  assert.deepEqual(plan.banks.flatMap(b=>b.pieces.map(p=>p.source_index)),[0,1,2,3]);
  for(const bank of plan.banks) {
    assert.equal(bank.height,65536);assert.equal(bank.rows,2048);
    assert.ok(bank.width*bank.height<=plan.limits.image_pixels);assert.ok(bank.max_tile_id<=32767);
    assert.equal(bank.pieces[0].tile_ids.first,16760);assert.equal(bank.pieces[1].tile_ids.last,16767);
    assert.equal(bank.memory.output_rgba_bytes,64*1024*1024);
    assert.ok(bank.memory.estimated_working_rgba_bytes>=bank.memory.output_rgba_bytes);
  }
  assert.deepEqual(plan.banks[0].pieces.map(p=>p.object_id),['pair','pair']);
  const padded=value(await call({baseTilesetId:2,pieces:[piece(128,1),piece(128,1)]}));
  assert.equal(padded.bank_count,2);assert.equal(padded.banks[0].pieces[0].tile_rect.width,160);
  console.log('PASS deterministic image-limit partition, repeated prefix, exact coverage, group continuity, IDs, padding and memory');

  const count=value(await call({baseTilesetId:1,pieces:Array.from({length:129},()=>piece(1))}));
  assert.deepEqual(count.banks.map(b=>b.piece_count),[128,1]);
  const decode=value(await call({baseTilesetId:1,pieces:Array.from({length:65},()=>({...piece(1),sourcePath:'tall.png'}))}));
  assert.deepEqual(decode.banks.map(b=>b.piece_count),[63,2]);
  assert.ok(decode.banks.every(b=>b.memory.decoded_source_pixels<=32*1024*1024));
  console.log('PASS piece-count and aggregate decode limits cause separate banks');
  const large=value(await call({baseTilesetId:2,pieces:Array.from({length:116},()=>piece(256))}));
  assert.equal(large.bank_count,116);assert.ok(large.projected_property_table_cells>1000000);
  assert.ok(large.projected_property_table_bytes<32*1024*1024);
  const overflow=await call({baseTilesetId:2,pieces:Array.from({length:334},()=>piece(256))});
  assert.equal(overflow.isError,true);assert.match(overflow.content[0].text,/Table byte budget/);
  console.log('PASS 116-bank plan with compact tables; aggregate Table overflow still rejected');

  for(const [args,pattern] of [
    [{baseTilesetId:2,pieces:Array.from({length:3},()=>({...piece(),objectId:'oversized'}))},/Indivisible object oversized/],
    [{baseTilesetId:1,pieces:Array.from({length:129},()=>({...piece(1),objectId:'many'}))},/Indivisible object many/],
    [{baseTilesetId:1,pieces:[{...piece(),objectId:'a'},piece(),{...piece(),objectId:'a'}]},/contiguous/],
    [{baseTilesetId:3,pieces:[piece()]},/megapixel/],
    [{baseTilesetId:1,pieces:[piece(256,1)]},/256px/],
    [{baseTilesetId:1,pieces:[{...piece(),rect:{x:255,y:0,width:2,height:16}}]},/bounds/],
    [{baseTilesetId:1,pieces:[{...piece(),sourcePath:join(root,'..','outside.png')}]},/authorized/],
  ]) {const r=await call(args);assert.equal(r.isError,true);assert.match(r.content[0].text,pattern);}
  assert.deepEqual(await snapshot(),before);
  console.log('PASS indivisible/range/ID-capacity/path errors; successful and failed planning writes no files, directories or lock');

  // Compare a small plan with actual composition after the no-write assertion.
  await unlink(lock);
  const smallPieces=[{sourcePath:'source.png',rect:{x:0,y:0,width:16,height:24},scale:2,padding:2},piece(200)];
  const small=value(await call({baseTilesetId:1,pieces:smallPieces}));
  const clone=value(await client.callTool({name:'clone_tileset',arguments:{sourceTilesetId:1}}));
  const composed=value(await client.callTool({name:'compose_tileset_atlas',arguments:{outputName:'parity',appendToTilesetId:clone.id,pieces:small.banks[0].compose_pieces}}));
  assert.equal(composed.height,small.banks[0].height);assert.equal(composed.tableSize,small.banks[0].table_size);
  for(const [i,p] of composed.pieces.entries()) {
    const predicted=small.banks[0].pieces[i];
    assert.deepEqual(p.output_rect,predicted.output_rect);assert.deepEqual(p.tile_rect,predicted.tile_rect);
    assert.equal(p.tile_ids[0][0],predicted.tile_ids.first);assert.equal(p.tile_ids.at(-1).at(-1),predicted.tile_ids.last);
  }
  console.log('PASS planned layout, prefix, scaling, padding and IDs match real composer');
} finally {await client.close();}
console.log('Synthetic fixtures:',root);

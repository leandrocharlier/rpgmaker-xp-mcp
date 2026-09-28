// Tall synthetic graphics only; no game or RTP assets.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeRxdataFile } from '../dist/utils/rxdata.js';
import { makeTable } from '../dist/utils/types.js';

const root = await mkdtemp(join(tmpdir(),'mcp-catalog-pages-'));
await mkdir(join(root,'Data')); await mkdir(join(root,'Graphics','Tilesets'),{recursive:true});
const png = new PNG({width:256,height:18848});
for(let y=0;y<png.height;y++) for(let x=0;x<png.width;x++) {
  const offset=(y*png.width+x)*4;
  png.data[offset]=Math.floor(y/32)%256; png.data[offset+1]=Math.floor(x/32)*25; png.data[offset+3]=255;
}
await writeFile(join(root,'Graphics','Tilesets','synthetic.png'),PNG.sync.write(png));
await writeRxdataFile(join(root,'Data','System.rxdata'),{_class:'RPG::System',magic_number:1});
const size=384+589*8;
await writeRxdataFile(join(root,'Data','Tilesets.rxdata'),[null,{_class:'RPG::Tileset',id:1,name:'Synthetic tall',tileset_name:'synthetic',autotile_names:[],passages:makeTable(size,1,1),priorities:makeTable(size,1,1),terrain_tags:makeTable(size,1,1)}]);
const original=await readFile(join(root,'Data','Tilesets.rxdata'));
const client=new Client({name:'catalog-pages-test',version:'1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,RPGMAKER_PROJECT_PATH:root},stderr:'pipe'}));
const call=args=>client.callTool({name:'create_tileset_identification_harness',arguments:{tilesetId:1,...args}});
const value=r=>{assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
async function verify(result,start,count) {
  assert.equal(result.page.row_start,start); assert.equal(result.page.row_count,count); assert.equal(result.page.total_rows,589);
  const manifest=JSON.parse(await readFile(result.manifest,'utf8'));
  assert.equal(manifest.regular_tiles.length,count*8);
  assert.equal(manifest.regular_tiles[0].id,384+start*8);
  assert.equal(manifest.regular_tiles.at(-1).id,384+(start+count)*8-1);
  const source=PNG.sync.read(await readFile(result.source_sheet));
  assert.equal(source.height,count*32); assert.equal(source.data[0],start%256);
  const labeled=PNG.sync.read(await readFile(result.labeled_source_sheet));
  assert.equal(labeled.width,512); assert.equal(labeled.height,count*64);
  assert.ok(labeled.width*labeled.height<=16*1024*1024);
  const tile=PNG.sync.read(await readFile(join(result.directory,manifest.regular_tiles[0].image)));
  assert.equal(tile.width,32); // scale=1 is honored, not clamped to 2.
  const html=await readFile(result.review_page,'utf8');
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.ok(html.includes('manifest.page?.row_start'));
}
try {
  const tools=await client.listTools();
  assert.equal(tools.tools.find(t=>t.name==='create_tileset_identification_harness').inputSchema.properties.rowStart.type,'integer');
  const first=value(await call({scale:1})); await verify(first,0,128);
  assert.equal(first.page.next_row_start,128);
  const firstBytes=await readFile(first.source_sheet);
  const second=value(await call({scale:1,rowStart:first.page.next_row_start,rowCount:2})); await verify(second,128,2);
  assert.notEqual(second.directory,first.directory);
  assert.deepEqual(await readFile(first.source_sheet),firstBytes);
  const last=value(await call({scale:1,rowStart:560,rowCount:29})); await verify(last,560,29);
  assert.equal(last.page.next_row_start,null);
  console.log('PASS tall PNG, automatic sections, nonzero offsets, final section, global IDs, crops and scale=1');
  for(const args of [{rowStart:-1},{rowStart:589},{rowStart:588,rowCount:2},{rowCount:0},{rowCount:128,scale:8},{rowStart:0.5},{rowCount:1,outDir:join(root,'outside') }]) assert.equal((await call(args)).isError,true,JSON.stringify(args));
  assert.deepEqual(await readFile(join(root,'Data','Tilesets.rxdata')),original);
  console.log('PASS range, aggregate work and export boundaries; tileset unchanged');
  for(const id of [384,4864]) value(await client.callTool({name:'save_tileset_catalog',arguments:{tilesetId:1,catalog:{tiles:{[id]:{id,label:'Synthetic annotation'}},objects:{},autotiles:{}}}}));
  const catalog=value(await client.callTool({name:'get_tileset_catalog',arguments:{tilesetId:1}}));
  assert.ok(catalog.catalog.tiles['384']); assert.ok(catalog.catalog.tiles['4864']);
  value(await client.callTool({name:'save_tileset_catalog',arguments:{tilesetId:1,replace:true,catalog:{tiles:{384:{id:384,label:'Replacement'}},objects:{},autotiles:{}}}}));
  const replaced=value(await client.callTool({name:'get_tileset_catalog',arguments:{tilesetId:1}}));
  assert.deepEqual(Object.keys(replaced.catalog.tiles),['384']);
  console.log('PASS section exports merge without losing annotations; explicit replacement still works');
} finally {await client.close();}
console.log('Synthetic fixtures:',root);

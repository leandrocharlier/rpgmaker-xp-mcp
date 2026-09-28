import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeRxdataFile, readRxdataFile } from '../dist/utils/rxdata.js';
import { makeTable, makeMap } from '../dist/utils/types.js';
import { runProjectOperation } from '../dist/utils/security.js';
import { composeTilesetAtlas } from '../dist/tools/atlasComposeTools.js';

const parent = await mkdtemp(join(tmpdir(), 'mcp-atlas-'));
const project = join(parent,'project'); await mkdir(join(project,'Data'),{recursive:true});
await mkdir(join(project,'Graphics','Tilesets'),{recursive:true});
await mkdir(join(project,'imports'));
function image(w,h) {
  const p=new PNG({width:w,height:h});
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {const i=(y*w+x)*4;p.data[i]=x%256;p.data[i+1]=y%256;p.data[i+2]=(x+y)%256;p.data[i+3]=[0,128,255][x%3];}
  return p;
}
const a=image(448,288), b=image(256,256), prefix=image(256,32);
await writeFile(join(project,'imports','a.png'),PNG.sync.write(a));
await writeFile(join(project,'imports','b.png'),PNG.sync.write(b));
const prefixPath=join(project,'Graphics','Tilesets','prefix.png'); await writeFile(prefixPath,PNG.sync.write(prefix));
const originalPrefix=await readFile(prefixPath);
const original={_class:'RPG::Tileset',id:1,name:'Original',tileset_name:'prefix',autotile_names:[],custom:'preserve',passages:makeTable(392,1,1),priorities:makeTable(392,1,1),terrain_tags:makeTable(392,1,1)};
original.passages.data[390]=79; original.priorities.data[390]=3; original.terrain_tags.data[390]=12;
const clone={...structuredClone(original),id:2,name:'Clone'};
const tsPath=join(project,'Data','Tilesets.rxdata');
await writeRxdataFile(tsPath,[null,original,clone]);
const mapPath=join(project,'Data','Map001.rxdata'); await writeRxdataFile(mapPath,makeMap(20,15)); const mapBefore=await readFile(mapPath);
await writeRxdataFile(join(project,'Data','System.rxdata'),{_class:'RPG::System',magic_number:1});
const pieces=[{sourcePath:'imports/a.png',rect:{x:32,y:16,width:32,height:48},scale:2},{sourcePath:'imports/b.png',rect:{x:8,y:8,width:17,height:19},padding:3}];
const client=new Client({name:'atlas-test',version:'1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,RPGMAKER_PROJECT_PATH:project,RPGMAKER_RTP_PATH:join(project,'rtp')},stderr:'pipe'}));
const call=args=>client.callTool({name:'compose_tileset_atlas',arguments:args});
const value=r=>{assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
const pixel=(p,x,y)=>p.data.subarray((y*p.width+x)*4,(y*p.width+x)*4+4);
try {
  const result=value(await call({outputName:'composed',appendToTilesetId:2,pieces}));
  const png=PNG.sync.read(await readFile(result.path));
  assert.equal(png.width,256);assert.equal(png.height%32,0);assert.equal(png.height,128);
  assert.deepEqual(png.data.subarray(0,prefix.data.length),prefix.data);
  const manifest=JSON.parse(await readFile(result.manifest,'utf8'));
  assert.deepEqual(manifest.pieces,result.pieces);
  assert.deepEqual(result.pieces[0].tile_ids,[[392,393],[400,401],[408,409]]);
  assert.deepEqual(result.pieces[1].tile_ids,[[394]]);
  for(const [index,src] of [a,b].entries()) {
    const part=pieces[index], dest=result.pieces[index].output_rect, scale=part.scale??1;
    for(let y=0;y<dest.height;y++) for(let x=0;x<dest.width;x++) assert.deepEqual(pixel(png,dest.x+x,dest.y+y),pixel(src,part.rect.x+Math.floor(x/scale),part.rect.y+Math.floor(y/scale)));
  }
  assert.deepEqual([...pixel(png,64,32)],[0,0,0,0]);assert.deepEqual([...pixel(png,255,127)],[0,0,0,0]);
  const entries=await readRxdataFile(tsPath);assert.deepEqual(entries[1],original);
  for(const field of ['passages','priorities','terrain_tags']) {
    assert.deepEqual(entries[2][field].data.slice(0,392),clone[field].data);
    assert.ok(entries[2][field].data.slice(392).every(v=>v===0));
  }
  assert.equal(entries[2].tileset_name,'composed');assert.equal(entries[2].custom,'preserve');
  assert.deepEqual(await readFile(prefixPath),originalPrefix);assert.deepEqual(await readFile(mapPath),mapBefore);
  console.log('PASS append preserves prefix RGBA, IDs, flags, unrelated records and map; crops, scale and transparent padding exact');
  const plain=value(await call({outputName:'plain',pieces}));
  const repeat=value(await call({outputName:'repeat',pieces}));
  assert.deepEqual(await readFile(plain.path),await readFile(repeat.path));assert.deepEqual(plain.pieces,repeat.pieces);
  console.log('PASS standalone atlas and deterministic shelf packing');
  const stable=await readFile(tsPath);
  await writeFile(join(parent,'outside.png'),PNG.sync.write(b));
  await symlink(parent,join(project,'imports','link'),process.platform==='win32'?'junction':'dir');
  const invalid=[{outputName:'../escape'},{outputName:'CON'},{outputName:'composed'},
    {pieces:[{...pieces[0],rect:{x:440,y:0,width:32,height:32}}]},
    {pieces:[{...pieces[0],scale:9}]},{pieces:[{...pieces[0],rect:{x:0,y:0,width:257,height:32},scale:1}]},
    {pieces:[{...pieces[0],sourcePath:join(parent,'outside.png')}]},
    {pieces:[{...pieces[0],sourcePath:'imports/link/outside.png'}]},
    {pieces:Array(128).fill({sourcePath:'imports/a.png',rect:{x:0,y:0,width:32,height:288},scale:8})}];
  for(const overrides of invalid) assert.equal((await call({outputName:'rejected',appendToTilesetId:2,pieces,...overrides})).isError,true);
  assert.deepEqual(await readFile(tsPath),stable);
  await assert.rejects(access(join(project,'Graphics','Tilesets','rejected.png')));
  console.log('PASS bounds, width overflow, size budgets, existing output, traversal and junction rejection');
} finally {await client.close();}

// Inject a late commit failure: both already-created output files must roll back.
const stable=await readFile(tsPath), realRename=fs.promises.rename;
let injected=false;
try {
  fs.promises.rename=async(from,to)=>{if(to===tsPath&&!injected){injected=true;throw new Error('injected atlas commit failure');}return realRename(from,to);};syncBuiltinESMExports();
  await assert.rejects(runProjectOperation(project,undefined,true,()=>composeTilesetAtlas(project,{outputName:'rollback',appendToTilesetId:2,pieces})),/injected atlas/);
} finally {fs.promises.rename=realRename;syncBuiltinESMExports();}
assert.ok(injected);assert.deepEqual(await readFile(tsPath),stable);
await assert.rejects(access(join(project,'Graphics','Tilesets','rollback.png')));
await assert.rejects(access(join(project,'Data','.mcp-atlas','rollback.json')));
assert.ok(!(await readdir(join(project,'Data'))).includes('.mcp-write.lock'));
assert.ok((await readdir(join(project,'Data','.mcp-backup'))).some(n=>n.startsWith('Tilesets.rxdata.')));
console.log('PASS late commit rollback removes outputs, preserves database and backups, releases lock');
console.log('Synthetic fixtures:',project);

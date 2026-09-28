import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeMap, makeTable, makeMapInfo } from '../dist/utils/types.js';
import { writeRxdataFile } from '../dist/utils/rxdata.js';
import { makeCanvas, encodePng } from '../dist/utils/tiles.js';
import { extensions } from '../dist/tools/extensions.js';

const project=await mkdtemp(join(tmpdir(),'mcp-extensions-'));
await mkdir(join(project,'Data')); await mkdir(join(project,'Graphics','Tilesets'),{recursive:true});
const path=name=>join(project,'Data',name);
await writeRxdataFile(path('System.rxdata'),{_class:'RPG::System',magic_number:1});
await writeRxdataFile(path('Tilesets.rxdata'),[null,{_class:'RPG::Tileset',id:1,name:'Fixture',tileset_name:'source',autotile_names:Array(7).fill(''),passages:makeTable(400,1,1),priorities:makeTable(400,1,1),terrain_tags:makeTable(400,1,1)}]);
await writeRxdataFile(path('MapInfos.rxdata'),{'1':makeMapInfo('Synthetic')});
const map=makeMap(3,3,1);map.data.data[0]=399;
await writeRxdataFile(path('Map001.rxdata'),map);
await writeFile(join(project,'Graphics','Tilesets','source.png'),encodePng(makeCanvas(256,64)));
const client=new Client({name:'extensions-test',version:'1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,RPGMAKER_PROJECT_PATH:project},stderr:'pipe'}));
try {
  const list=await client.listTools();
  for(const extension of extensions) assert.ok(list.tools.some(t=>t.name===extension.definition.name));
  for(const uri of ['asset-review','tileset-transforms','movement-anchors']) {
    const resource=await client.readResource({uri:'rpgmaker-xp://docs/'+uri});
    assert.ok(resource.contents[0].text.length>100);
  }
  const args={tilesetId:1,outputName:'small',runtimeMaxHeight:32};
  const before=await readFile(path('Tilesets.rxdata'));
  const bad=await client.callTool({name:'compact_used_tileset',arguments:{...args,unexpected:true}});
  assert.ok(bad.isError);assert.deepEqual(await readFile(path('Tilesets.rxdata')),before);
  await writeFile(path('.mcp-write.lock'),'external test lock');
  const preview=await client.callTool({name:'compact_used_tileset',arguments:args});
  assert.ok(!preview.isError,JSON.stringify(preview));const plan=JSON.parse(preview.content[0].text);
  const apply={...args,dryRun:false,reviewedPlanHash:plan.planHash,acknowledgeDynamicReferences:true};
  const movement=await client.callTool({name:'audit_movement',arguments:{mapId:1,start:{x:1,y:1},runtimeProfile:'unknown',allowed:[{x:1,y:1,width:1,height:1}]}});
  assert.ok(!movement.isError,JSON.stringify(movement));
  const audit=JSON.parse(movement.content[0].text);assert.equal(audit.contained,false);assert.equal(audit.runtimeVerdict,'unknown');
  const anchors=await client.callTool({name:'inspect_building_catalog',arguments:{objects:[{id:'house',width:5,height:5,anchors:[{name:'door',kind:'door',x:2,y:4},{name:'approach',kind:'approach',x:2,y:5,direction:8}]}]}});
  assert.ok(!anchors.isError,JSON.stringify(anchors));
  assert.ok((await client.callTool({name:'compact_used_tileset',arguments:apply})).isError);
  await unlink(path('.mcp-write.lock'));
  const result=await client.callTool({name:'compact_used_tileset',arguments:apply});
  assert.ok(!result.isError,JSON.stringify(result));
  console.log('PASS SDK extension discovery/schema rejection, lock-free dry-run, locked apply and reviewed transform');

  async function call(name,args) {
    const result=await client.callTool({name,arguments:args});
    assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);
  }
  const importSpec={inventoryDirectory:'Graphics/Tilesets',sources:[{id:'source',path:'Graphics/Tilesets/source.png'}],regions:[{id:'band',sourceId:'source',rect:{x:0,y:0,width:256,height:64},scale:1,sourceGrid:32,padding:0,kind:'modular',status:'included',modularSplitReviewed:true}]};
  await writeFile(path('import.json'),JSON.stringify(importSpec));
  const review=await call('review_tileset_import',{specPath:'Data/import.json'});
  assert.equal(review.canApply,false);assert.equal(review.coverageComplete,false);
  importSpec.regions[0].review={binding:review.index[0].reviewBinding,evidence:'Explicit synthetic full band reviewed',boundsConfirmed:true};
  await writeFile(path('import.json'),JSON.stringify(importSpec));
  const exported=await call('review_tileset_import',{specPath:'Data/import.json',dryRun:false,outputName:'reviewed'});
  assert.ok(exported.files['index.html']);assert.equal(exported.coverageComplete,false);
  const characterSpec={sourcePath:'Graphics/Tilesets/source.png',layout:{engine:'explicit',columns:4,rows:4},directions:['down','left','right','up'],role:'walking',anchors:Array.from({length:16},()=>({x:0,y:0})),conversion:{engine:'explicit',columns:1,rows:1,frameWidth:64,frameHeight:16,scale:1,frames:[{sourceFrame:0,anchor:{x:0,y:0}}]}};
  await writeFile(path('character.json'),JSON.stringify(characterSpec));
  const character=await call('inspect_character_sheet',{specPath:'Data/character.json'});
  characterSpec.review={binding:character.reviewBinding,evidence:'Explicit synthetic frame extraction reviewed'};
  await writeFile(path('character.json'),JSON.stringify(characterSpec));
  const converted=await call('inspect_character_sheet',{specPath:'Data/character.json',dryRun:false,outputName:'character'});
  assert.ok(converted.files['character.png']);
  assert.equal((await call('validate_character_set',{specPaths:['Data/character.json']})).compatibleGeometry,true);
  console.log('PASS MCP documentation resources, import review/apply with partial coverage and character inspection/conversion/set validation');
} finally { await client.close(); }
console.log(`Synthetic fixtures: ${project}`);

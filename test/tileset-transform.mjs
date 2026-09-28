import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {runProjectOperation,atomicWriteFile} from '../dist/utils/security.js';
import {readRxdataFile,writeRxdataFile} from '../dist/utils/rxdata.js';
import {makeMap,makeMapInfo,makeTable,makeEventPage} from '../dist/utils/types.js';
import {makeCanvas,encodePng,decodePng} from '../dist/utils/tiles.js';
import {compactUsedTileset,planTilesetMerge,mergeTilesets} from '../dist/tools/tilesetTransformTools.js';
const root=await mkdtemp(join(tmpdir(),'tileset-transform-'));
await mkdir(join(root,'Data'));await mkdir(join(root,'Graphics','Tilesets'),{recursive:true});
const db=join(root,'Data','Tilesets.rxdata'),mp=id=>join(root,'Data',`Map${String(id).padStart(3,'0')}.rxdata`);
const records=[null,...[1,2,3].map(id=>({_class:'RPG::Tileset',id,name:`Bank${id}`,tileset_name:`bank${id}`,autotile_names:Array(7).fill(''),passages:makeTable(400,1,1),priorities:makeTable(400,1,1),terrain_tags:makeTable(400,1,1)}))];
// Two pixel-identical tiles with matching flags, one with a terrain conflict.
for(const t of records.slice(1)) { t.passages.data[384]=t.passages.data[386]=15;t.terrain_tags.data[388]=1; }
for(let id=1;id<=3;id++) { const c=makeCanvas(256,64);c.data.fill(255);for(let p=0;p<c.data.length;p+=4)c.data[p]=id;await writeFile(join(root,'Graphics','Tilesets',`bank${id}.png`),encodePng(c)); }
await writeRxdataFile(db,records);await writeRxdataFile(join(root,'Data','MapInfos.rxdata'),{'1':makeMapInfo('First'),'2':makeMapInfo('Second'),'3':makeMapInfo('Untouched')});
for(let id=1;id<=3;id++) {const m=makeMap(3,3,id);m.data.data[0]=384;m.data.data[9]=386;m.data.data[18]=388;const p=makeEventPage();p.graphic.tile_id=386;m.events={'1':{_class:'RPG::Event',id:1,name:'Sentinel',x:1,y:1,pages:[p]}};await writeRxdataFile(mp(id),m);}
const run=(mut,fn)=>runProjectOperation(root,undefined,mut,fn);
const originalDB=await readFile(db),original1=await readFile(mp(1)),original2=await readFile(mp(2)),unrelated=await readFile(mp(3));
const compact={tilesetId:1,outputName:'compact',runtimeMaxHeight:32};
const plan=await run(false,()=>compactUsedTileset(root,compact));
assert.equal(plan.height,32);assert.equal(plan.mappings['1']['384'],384);assert.equal(plan.mappings['1']['386'],384);assert.equal(plan.mappings['1']['388'],385);assert.equal(plan.unusedRegularTileIds.length,13);
await assert.rejects(access(join(root,'Data','.mcp-backup')));assert.deepEqual(await readFile(db),originalDB);
await assert.rejects(run(true,()=>compactUsedTileset(root,{...compact,dryRun:false,reviewedPlanHash:'0'.repeat(64),acknowledgeDynamicReferences:true})),/reviewedPlanHash/);
await run(true,()=>compactUsedTileset(root,{...compact,dryRun:false,reviewedPlanHash:plan.planHash,acknowledgeDynamicReferences:true}));
const after=await readRxdataFile(mp(1));assert.equal(after.data.data[9],384);assert.equal(after.data.data[18],385);assert.equal(after.events['1'].pages[0].graphic.tile_id,384);
assert.deepEqual(await readFile(mp(2)),original2);assert.deepEqual(await readFile(mp(3)),unrelated);
const compactDB=await readRxdataFile(db);assert.equal(compactDB[1].terrain_tags.data[385],1);assert.equal(compactDB[1].passages.data[384],15);assert.ok((await readdir(join(root,'Data','.mcp-backup'))).length>=2);
console.log('PASS compact: full layer/event remap, compatible dedup, property conflict separation, dry-run and unrelated byte preservation');
await writeFile(db,originalDB);await writeFile(mp(1),original1);
const merge={targetTilesetId:1,sourceTilesetIds:[2],outputName:'merged',runtimeMaxHeight:128};
const mergePlan=await run(false,()=>planTilesetMerge(root,merge));assert.equal(mergePlan.height,128);assert.equal(mergePlan.mappings['1']['399'],399);assert.equal(mergePlan.mappings['2']['384'],400);
await assert.rejects(run(false,()=>planTilesetMerge(root,{...merge,runtimeMaxHeight:96})),/runtime height/);
const bad=structuredClone(records);bad[2].autotile_names[0]='conflict';await writeRxdataFile(db,bad);
await assert.rejects(run(false,()=>planTilesetMerge(root,merge)),/Merge conflict/);await writeFile(db,originalDB);
await run(true,()=>mergeTilesets(root,{...merge,dryRun:false,reviewedPlanHash:mergePlan.planHash,acknowledgeDynamicReferences:true}));
const merged=await readRxdataFile(mp(2));assert.equal(merged.tileset_id,1);assert.equal(merged.data.data[0],400);assert.equal(merged.data.data[9],402);assert.equal(merged.events['1'].pages[0].graphic.tile_id,402);
assert.deepEqual(await readFile(mp(1)),original1);assert.deepEqual(await readFile(mp(3)),unrelated);
assert.equal((await readRxdataFile(db))[1].terrain_tags.data[404],1);
const mergedPixels=await decodePng(join(root,'Graphics','Tilesets','merged.png'));
assert.deepEqual([...mergedPixels.data.subarray(0,4)],[1,255,255,255]);
assert.deepEqual([...mergedPixels.data.subarray(64*256*4,64*256*4+4)],[2,255,255,255]);
console.log('PASS merge: target prefix and source properties preserved, layers/event pages remapped, runtime bounds and autotile conflict rejection');
await writeFile(db,originalDB);await writeFile(mp(2),original2);
const guardArgs={...merge,outputName:'guarded'};const gp=await run(false,()=>planTilesetMerge(root,guardArgs));
await assert.rejects(run(true,async()=>{await mergeTilesets(root,{...guardArgs,dryRun:false,reviewedPlanHash:gp.planHash,acknowledgeDynamicReferences:true});await atomicWriteFile(mp(3),Buffer.from('external staged mutation'));}),/dependency changed/);
assert.deepEqual(await readFile(db),originalDB);assert.deepEqual(await readFile(mp(3)),unrelated);await assert.rejects(access(join(root,'Graphics','Tilesets','guarded.png')));
console.log('PASS dependency guard rejects changed unrelated map before commit and leaves staged writes absent');
const rollbackArgs={...merge,outputName:'rollback'};const rp=await run(false,()=>planTilesetMerge(root,rollbackArgs));
const rename=fs.promises.rename;let reached=false;
fs.promises.rename=async(from,to)=>{if(to===db&&!reached){reached=true;throw Object.assign(new Error('Synthetic commit failure'),{code:'EIO'});}return rename(from,to);};syncBuiltinESMExports();
try {await assert.rejects(run(true,()=>mergeTilesets(root,{...rollbackArgs,dryRun:false,reviewedPlanHash:rp.planHash,acknowledgeDynamicReferences:true})),/Synthetic commit failure/);} finally {fs.promises.rename=rename;syncBuiltinESMExports();}
assert.ok(reached);assert.deepEqual(await readFile(db),originalDB);assert.deepEqual(await readFile(mp(2)),original2);await assert.rejects(access(join(root,'Graphics','Tilesets','rollback.png')));
console.log('PASS injected late rename failure rolls back changed map and newly created PNG');
console.log(`Synthetic fixtures: ${root}`);

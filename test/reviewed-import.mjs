import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { reviewedImport } from '../dist/tools/reviewedImportTools.js';
import { runProjectOperation } from '../dist/utils/security.js';
import { makeCanvas, fillRect, encodePng, decodePng } from '../dist/utils/tiles.js';

const root=await mkdtemp(join(tmpdir(),'mcp-reviewed-'));await mkdir(join(root,'Data'));await mkdir(join(root,'Sources'));
const source=makeCanvas(320,96);fillRect(source,224,0,64,32,[13,24,35,255]); // PC crosses the x=256 strip boundary.
fillRect(source,0,32,320,32,[80,90,100,255]); // Legitimately modular wall.
fillRect(source,0,64,16,16,[1,2,3,255]);fillRect(source,16,64,16,16,[1,2,3,255]);
await writeFile(join(root,'Sources','sheet.png'),encodePng(source));
const region=(id,rect,more={})=>({id,sourceId:'sheet',rect,scale:1,sourceGrid:32,padding:0,kind:'object',status:'included',...more});
const spec={inventoryDirectory:'Sources',sources:[{id:'sheet',path:'Sources/sheet.png'}],regions:[
 region('pc',{x:224,y:0,width:64,height:32}),
 region('wall-a',{x:0,y:32,width:160,height:32},{kind:'modular',group:'wall',modularSplitReviewed:true}),
 region('wall-b',{x:160,y:32,width:160,height:32},{kind:'modular',group:'wall',modularSplitReviewed:true}),
 region('native16',{x:0,y:64,width:16,height:16},{scale:2,sourceGrid:16}),
 region('duplicate',{x:16,y:64,width:16,height:16},{scale:2,sourceGrid:16,status:'duplicate',duplicateOf:'native16'}),
 region('scene',{x:32,y:64,width:32,height:32},{kind:'example_scene',status:'excluded',reason:'Synthetic miniature complete room'}),
 region('credits',{x:64,y:64,width:32,height:32},{kind:'credits',status:'excluded',reason:'Synthetic credit panel'})]};
const path=join(root,'review.json');const save=()=>writeFile(path,JSON.stringify(spec));
const call=(a={})=>runProjectOperation(root,undefined,a.dryRun===false,()=>reviewedImport(root,{specPath:'review.json',...a}));
await save();let plan=await call();assert.equal(plan.canApply,false);assert.equal(plan.coverageComplete,false);assert.equal(plan.index[0].destination.width,64);
await assert.rejects(call({dryRun:false,outputName:'unreviewed'}),/Review incomplete/);
async function approve(){await save();const p=await call();spec.regions.forEach((r,i)=>r.review={binding:p.index[i].reviewBinding,boundsConfirmed:true,evidence:'Synthetic fixture manually defined grid, component bounds and role'});await save();}
await approve();plan=await call();assert.equal(plan.canApply,true);assert.equal(plan.coverageComplete,false);assert.ok(plan.coverage[0].unaccountedPixels>0);
const result=await call({dryRun:false,outputName:'reviewed'});const atlas=await decodePng(result.files['atlas.png']);
assert.deepEqual([...atlas.data.slice(0,64*4)],[...source.data.slice(224*4,288*4)]);
const recon=await decodePng(result.files['reconstruction-0.png']);assert.deepEqual([...recon.data.slice(224*4,288*4)],[...source.data.slice(224*4,288*4)]);
assert.equal(recon.data[(64*320+64)*4+3],0); // Excluded credit pixels are not included.
const dest=result.index.find(e=>e.id==='native16').destination;
assert.deepEqual([...atlas.data.slice((dest.y*256+dest.x)*4,(dest.y*256+dest.x)*4+8)],[1,2,3,255,1,2,3,255]);
await assert.rejects(call({dryRun:false,outputName:'reviewed'}),/already exists/);
spec.regions[0].padding=1;await save();assert.equal((await call()).canApply,false);spec.regions[0].padding=0;
spec.regions[4].duplicateOf='scene';await save();await assert.rejects(call(),/Duplicate target/);spec.regions[4].duplicateOf='native16';
spec.regions.push(region('overlap',{x:224,y:0,width:1,height:1}));await save();await assert.rejects(call(),/Overlapping/);spec.regions.pop();
spec.regions[0].rect={x:0,y:0,width:320,height:32};await save();await assert.rejects(call(),/exceeds eight tiles/);spec.regions[0].rect={x:224,y:0,width:64,height:32};
await approve();source.data[224*4]=99;await writeFile(join(root,'Sources','sheet.png'),encodePng(source));assert.equal((await call()).canApply,false);
console.log('PASS review gate, stale source/crop/scale evidence, PC across seam, modular wall, excluded scenes/credits, duplicates, coverage, exact nearest-neighbor pixels and no overwrite');

// Different band boundaries: TV above L-shaped sofa; nearby unrelated object stays excluded.
const band=makeCanvas(128,96);fillRect(band,0,0,64,32,[10,20,30,255]);fillRect(band,32,32,64,32,[40,50,60,255]);fillRect(band,32,64,32,32,[40,50,60,255]);fillRect(band,64,64,32,32,[200,100,0,255]);
await writeFile(join(root,'Sources','bands.png'),encodePng(band));
spec.sources=[{id:'sheet',path:'Sources/bands.png'}];spec.regions=[region('tv',{x:0,y:0,width:64,height:32}),region('sofa',{x:32,y:32,width:64,height:64},{mask:[{x:0,y:0,width:64,height:32},{x:0,y:32,width:32,height:32}],padding:2})];
await approve();const bands=await call({dryRun:false,outputName:'bands'});assert.equal(bands.pendingSources.length,1);const rebuilt=await decodePng(bands.files['reconstruction-0.png']);assert.equal(rebuilt.data[(64*128+64)*4+3],0);assert.equal(rebuilt.data[(64*128+32)*4],40);
assert.ok(bands.index[1].destination.firstRow>=bands.index[0].destination.firstRow+bands.index[0].destination.rowCount);
const sentinel=await readFile(join(root,'Sources','bands.png'));await call();assert.deepEqual(await readFile(join(root,'Sources','bands.png')),sentinel);assert.deepEqual((await readdir(join(root,'Data'))).sort(),['.mcp-preview']);
console.log('PASS TV/sofa masks, varying bands, padding separate from source, reconstruction excluding neighboring objects, undisclosed-source coverage pending');

await mkdir(join(root,'Complete'));const tiny=makeCanvas(32,32);fillRect(tiny,0,0,32,32,[2,4,6,255]);await writeFile(join(root,'Complete','tile.png'),encodePng(tiny));
spec.inventoryDirectory='Complete';spec.sources=[{id:'sheet',path:'Complete/tile.png'}];spec.regions=[region('tile',{x:0,y:0,width:32,height:32},{label:'<img src=x onerror=alert(1)>'})];
await approve();assert.equal((await call()).coverageComplete,true);assert.ok((await call()).coverage[0].exactReplicationFactors.includes(2));delete spec.inventoryDirectory;await save();assert.equal((await call()).coverageComplete,false);assert.equal((await call()).declaredCoverageComplete,true);
const escaped=await call({dryRun:false,outputName:'escaped'});const html=await readFile(escaped.files['index.html'],'utf8');assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('Content-Security-Policy'));
spec.regions[0].sourceGrid=null;await save();assert.equal((await call()).canApply,false);spec.regions[0].sourceGrid=32;spec.regions[0].review.boundsConfirmed=false;await save();assert.equal((await call()).canApply,false);
console.log('PASS full inventory coverage versus declared selection, unknown scale and unconfirmed bounds rejection, escaped HTML index');
tiny.data[0]=9;await writeFile(join(root,'Complete','tile.png'),encodePng(tiny));assert.ok(!(await call()).coverage[0].exactReplicationFactors.includes(2));await approve();
const inputBefore=await readFile(join(root,'Complete','tile.png')),rename=fs.promises.rename;
fs.promises.rename=async function(a,b) {if(String(b).endsWith('index.json')&&String(b).includes('rollback'))throw Object.assign(new Error('synthetic late export failure'),{code:'EIO'});return rename(a,b);};syncBuiltinESMExports();
try{await assert.rejects(call({dryRun:false,outputName:'rollback'}),/synthetic late export failure/);}finally{fs.promises.rename=rename;syncBuiltinESMExports();}
assert.deepEqual(await readFile(join(root,'Complete','tile.png')),inputBefore);assert.deepEqual(await readdir(join(root,'Data','.mcp-preview','rollback')),[]);
console.log('PASS ambiguous integer-upscale hints, modified-pixel rejection and late export failure rollback preserving inputs');

// Sparse masks in large overlapping bounding boxes previously permitted excessive
// retained allocations even when source ownership itself never overlapped.
const sparse=makeCanvas(1024,1024);await writeFile(join(root,'sparse.png'),encodePng(sparse));
spec.sources=[{id:'sheet',path:'sparse.png'}];delete spec.inventoryDirectory;
spec.regions=Array.from({length:17},(_,i)=>region(`sparse-${i}`,{x:0,y:0,width:1024,height:1024},{kind:'unreviewed',status:'pending',sourceGrid:null,mask:[{x:i,y:0,width:1,height:1}]}));
await save();await assert.rejects(call(),/crop-mask allocation/);
console.log('PASS adversarial sparse component masks cannot multiply retained crop allocations beyond budget');

// Artwork, opaque gray shadow, translucent shadow and painted checker pixels are
// distinct evidence; none may be silently keyed out or have alpha inferred.
const shadows=makeCanvas(32,32);
shadows.data.set([79,79,79,255],0);
shadows.data.set([0,0,0,64],4);
shadows.data.set([255,255,255,255],8);
shadows.data.set([180,180,180,255],12);
shadows.data.set([22,33,44,0],16);
await writeFile(join(root,'shadows.png'),encodePng(shadows));
spec.sources=[{id:'sheet',path:'shadows.png'}];spec.regions=[region('building',{x:0,y:0,width:32,height:32})];
await approve();const shadowReport=await call({dryRun:false,outputName:'shadows'});
assert.equal(shadowReport.appearancePolicy.mode,'preserve-source-rgba');
assert.equal(shadowReport.appearancePolicy.shadowAlphaAdaptation,false);
const shadowAtlas=await decodePng(shadowReport.files['atlas.png']);
assert.deepEqual([...shadowAtlas.data.slice(0,20)],[...shadows.data.slice(0,20)]);
shadows.data.set([0,0,0,64],0);await writeFile(join(root,'shadows.png'),encodePng(shadows));
assert.equal((await call()).canApply,false);
console.log('PASS opaque shadow, translucent shadow, checker and transparent RGB preserved; explicit alpha adaptation invalidates prior evidence');

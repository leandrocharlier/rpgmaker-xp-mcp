import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { allowed, contained, readLimited, beforeProjectCommit, atomicWriteFile, canvasBudget, checkValue, assertId, expectNewProjectFile } from '../utils/security.js';
import { readRxdataFile, writeRxdataFile } from '../utils/rxdata.js';
import { decodePng, encodePng, makeCanvas, resolveGraphic, type Canvas } from '../utils/tiles.js';
import type { ToolExtension } from '../utils/toolExtension.js';

const fields = ['passages','priorities','terrain_tags'] as const;
const MiB = 1024 * 1024;
const digest = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export interface TransformOptions {
  outputName: string;
  runtimeMaxHeight: number;
  dryRun?: boolean;
  reviewedPlanHash?: string;
  acknowledgeDynamicReferences?: boolean;
}
export interface CompactOptions extends TransformOptions { tilesetId: number; deduplicate?: boolean }
export interface MergeOptions extends TransformOptions { targetTilesetId: number; sourceTilesetIds: number[] }

/** Conservative semantic transform. Source records/assets remain available for recovery. */
async function transform(project: string, mode: 'compact'|'merge', args: CompactOptions | MergeOptions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(args.outputName) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(args.outputName)) throw new Error('Choose a safe new outputName');
  if (!Number.isInteger(args.runtimeMaxHeight) || args.runtimeMaxHeight < 32 || args.runtimeMaxHeight > 129536 || args.runtimeMaxHeight % 32) throw new Error('runtimeMaxHeight must be a tested multiple of 32 in 32..129536');
  const targetId = mode === 'compact' ? (args as CompactOptions).tilesetId : (args as MergeOptions).targetTilesetId;
  const ids = mode === 'compact' ? [targetId] : [targetId,...(args as MergeOptions).sourceTilesetIds];
  if (ids.length > 32 || (mode === 'merge' && ids.length < 2) || new Set(ids).size !== ids.length) throw new Error('Select distinct banks (2..32 for merge)');
  ids.forEach(assertId);
  const dbPath = contained(project,join(project,'Data','Tilesets.rxdata'));
  const outputPath = contained(project,join(project,'Graphics','Tilesets',args.outputName+'.png'));
  await expectNewProjectFile(outputPath);
  const hashes = new Map<string,string>(); let readBytes = 0;
  async function observe(path: string) {
    const b = await readLimited(path); readBytes += b.length;
    if (readBytes > 64*MiB) throw new Error('Transform dependency files exceed 64 MiB aggregate read budget');
    hashes.set(path,digest(b)); return b;
  }
  await observe(dbPath);
  const entries = await readRxdataFile<any[]>(dbPath);
  if (!Array.isArray(entries) || entries[0] !== null) throw new Error('Invalid tileset database');
  const records = ids.map(id=>entries[id]);
  for (const [i,t] of records.entries()) {
    const n=t?.passages?.xsize;
    if(t?._class!=='RPG::Tileset'||t.id!==ids[i]||!Number.isInteger(n)||n<384||n>32768) throw new Error('Invalid tileset record');
    for(const f of fields) if(t[f]?._class!=='Table'||t[f].dim!==1||t[f].xsize!==n||t[f].ysize!==1||t[f].zsize!==1||t[f].data?.length!==n) throw new Error('Invalid property table');
    if(!Array.isArray(t.autotile_names)||t.autotile_names.length!==7) throw new Error('Exactly seven explicit autotile slots required');
  }
  const base=records[0];
  if(mode==='merge') for(const t of records.slice(1)) {
    const settings=(v:any)=>Object.fromEntries(Object.keys(v).sort().filter(k=>!['id','name','tileset_name',...fields].includes(k)).map(k=>[k,v[k]]));
    if(JSON.stringify(settings(t))!==JSON.stringify(settings(base))) throw new Error('Merge conflict: autotile slots or panorama/fog/battleback/custom settings differ');
    for(const f of fields) if(JSON.stringify(t[f].data.slice(0,384))!==JSON.stringify(base[f].data.slice(0,384))) throw new Error(`Merge conflict: reserved/autotile ${f} differ`);
  }
  const dataDir=contained(project,join(project,'Data'));
  const inventory=async()=> (await readdir(allowed(dataDir))).filter(f=>/^Map\d+\.rxdata$/i.test(f)).sort();
  const files=await inventory(); if(files.length>10000) throw new Error('Map inventory exceeds 10000');
  const infoPath=join(dataDir,'MapInfos.rxdata'); await observe(infoPath);
  const infos=await readRxdataFile<any>(infoPath);
  if(!infos||typeof infos!=='object'||Array.isArray(infos)) throw new Error('Invalid MapInfos');
  for(const k of Object.keys(infos)) { assertId(Number(k)); if(!files.some(f=>f.toLowerCase()===`map${String(Number(k)).padStart(3,'0')}.rxdata`)) throw new Error(`Missing indexed map ${k}`); }
  const maps: {path:string;map:any;id:number}[]=[]; const seen=new Set<number>();
  const used=new Map(ids.map(id=>[id,new Set<number>()]));
  let affectedCells=0;
  for(const file of files) {
    const id=Number(file.match(/\d+/)![0]); assertId(id); if(seen.has(id)) throw new Error('Duplicate map ID'); seen.add(id);
    const path=join(dataDir,file); await observe(path); const map=await readRxdataFile<any>(path);
    if(map?._class!=='RPG::Map'||!entries[map.tileset_id]) throw new Error(`Invalid map tileset in ${file}`);
    if(!used.has(map.tileset_id)) continue;
    if(map.data?._class!=='Table'||map.data.xsize!==map.width||map.data.ysize!==map.height||map.data.zsize!==3) throw new Error(`Invalid map layers in ${file}`);
    affectedCells+=map.data.data.length; if(affectedCells>2000000) throw new Error('Affected maps exceed 2 million cells');
    const use=(n:number)=>{if(!Number.isInteger(n)||n<0||n>=entries[map.tileset_id].passages.xsize) throw new Error(`Invalid tile ID in ${file}`);used.get(map.tileset_id)!.add(n);};
    map.data.data.forEach(use);
    for(const e of Object.values<any>(map.events??{})) for(const p of e.pages??[]) use(p.graphic.tile_id);
    maps.push({path,map,id});
  }
  const imagePaths:string[]=[]; const heights:number[]=[]; let sourcePixels=0;
  for(const t of records) {
    const p=resolveGraphic(project,process.env.RPGMAKER_RTP_PATH||'', 'Tilesets',t.tileset_name);
    if(!p) throw new Error('Tileset graphic missing');
    const b=await observe(p);
    if(b.length<24||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a') throw new Error('Tilesets require PNG');
    const w=b.readUInt32BE(16),h=b.readUInt32BE(20);canvasBudget(w,h,true);
    if(w!==256||h%32||384+h/4!==t.passages.xsize) throw new Error('Image and property table dimensions must match exactly');
    imagePaths.push(p);heights.push(h);sourcePixels+=w*h;
  }
  if(sourcePixels>32*MiB) throw new Error('Sources exceed 32 megapixel decode budget');
  // Conservative workload estimate includes source codec scratch, output codec scratch,
  // encoded reads, affected map numeric storage, and metadata. Not an OS RSS cap.
  const worstHeight=mode==='merge'?heights.reduce((a,b)=>a+b,0):Math.max(32,Math.ceil([...used.get(targetId)!].filter(n=>n>=384).length/8)*32);
  const estimatedWorkingBytes=sourcePixels*12+256*worstHeight*16+readBytes*4+affectedCells*16+16*MiB;
  if(estimatedWorkingBytes>768*MiB) throw new Error('Estimated working memory exceeds fixed 768 MiB operation budget');
  if(worstHeight>args.runtimeMaxHeight||384+worstHeight/4>32768) throw new Error('Planned output exceeds tested runtime height or signed tile IDs');
  canvasBudget(256,worstHeight,true);
  const atlas=makeCanvas(256,worstHeight,true);
  const mappings:Record<string,Record<string,number>>={};
  const properties=Object.fromEntries(fields.map(f=>[f,base[f].data.slice(0,384)])) as Record<typeof fields[number],number[]>;
  let next=384; const duplicateGroups:{representative:number;duplicates:number[]}[]=[];
  const keys=new Map<string,number>(); const groups=new Map<number,number[]>();
  const unused:number[]=[];
  const collectionKeys=new Map<string,{tilesetId:number;tileId:number}[]>();
  for(let bank=0;bank<ids.length;bank++) {
    const image=await decodePng(imagePaths[bank],true),t=records[bank];
    const mapping:Record<string,number>={}; mappings[ids[bank]]=mapping;
    for(let id=0;id<384;id++) mapping[id]=id;
    for(let old=384;old<t.passages.xsize;old++) {
      const tile=Buffer.alloc(4096); const pos=old-384,sx=(pos%8)*32,sy=Math.floor(pos/8)*32;
      for(let y=0;y<32;y++) tile.set(image.data.subarray(((sy+y)*256+sx)*4,((sy+y)*256+sx+32)*4),y*128);
      const key=digest(tile)+':'+fields.map(f=>t[f].data[old]).join(',');
      const matches=collectionKeys.get(key)??[];matches.push({tilesetId:ids[bank],tileId:old});collectionKeys.set(key,matches);
      if(mode==='compact'&&!used.get(targetId)!.has(old)) { unused.push(old);continue; }
      let dest=mode==='compact'&&(args as CompactOptions).deduplicate!==false?keys.get(key):undefined;
      if(dest!==undefined) {groups.get(dest)!.push(old);mapping[old]=dest;continue;}
      dest=next++;mapping[old]=dest;keys.set(key,dest);groups.set(dest,[old]);
      const dx=((dest-384)%8)*32,dy=Math.floor((dest-384)/8)*32;
      for(let y=0;y<32;y++) atlas.data.set(tile.subarray(y*128,(y+1)*128),((dy+y)*256+dx)*4);
      for(const f of fields) properties[f].push(t[f].data[old]);
    }
  }
  for(const [representative,list] of groups) if(list.length>1) duplicateGroups.push({representative,duplicates:list});
  const height=Math.max(32,Math.ceil((next-384)/8)*32),tableSize=384+height/4;
  for(const f of fields) while(properties[f].length<tableSize) properties[f].push(0);
  const plan={mode,targetTilesetId:targetId,sourceTilesetIds:ids,outputName:args.outputName,runtimeMaxHeight:args.runtimeMaxHeight,width:256,height,tableSize,mappings,unusedRegularTileIds:unused,compatibleDuplicateGroups:duplicateGroups,
    collectionCompatibleDuplicates:[...collectionKeys.values()].filter(g=>g.length>1),affectedMapIds:maps.map(m=>m.id),mapsScanned:files.length,estimatedWorkingBytes,sourcePixels,
    note:'Stored map layers and every event page only. Script/runtime references and autotile file identity are not analyzed. Existing source records and graphics are retained. Runtime validation remains required.'};
  const planHash=digest(JSON.stringify({plan,dependencies:[...hashes]}));
  if(args.dryRun!==false) return {...plan,planHash,dryRun:true};
  if(args.reviewedPlanHash!==planHash) throw new Error('reviewedPlanHash must match a fresh dry-run');
  if(args.acknowledgeDynamicReferences!==true) throw new Error('Explicitly acknowledge unresolved script/runtime references before applying');
  const written=new Set([dbPath]);
  for(const item of maps) {
    const mapping=mappings[item.map.tileset_id];let changed=item.map.tileset_id!==targetId;
    item.map.data.data=item.map.data.data.map((n:number)=>{const v=mapping[n];changed ||= v!==n;return v;});
    for(const e of Object.values<any>(item.map.events??{})) for(const p of e.pages??[]) {const n=p.graphic.tile_id;p.graphic.tile_id=mapping[n];changed ||= n!==p.graphic.tile_id;}
    item.map.tileset_id=targetId;
    if(changed) {written.add(item.path);await writeRxdataFile(item.path,item.map);}
  }
  beforeProjectCommit(async()=>{
    if(JSON.stringify(await inventory())!==JSON.stringify(files)) throw new Error('Map inventory changed during transform');
    for(const [path,h] of hashes) if(!written.has(path)&&digest(await readLimited(path))!==h) throw new Error('Transform dependency changed');
  });
  base.tileset_name=args.outputName;
  for(const f of fields) {base[f].data=properties[f];base[f].xsize=tableSize;}
  checkValue(entries);
  const finalImage:Canvas={width:256,height,data:atlas.data.subarray(0,256*height*4)};
  await atomicWriteFile(outputPath,encodePng(finalImage,true));
  await writeRxdataFile(dbPath,entries);
  return {...plan,planHash,dryRun:false};
}

export const compactUsedTileset=(project:string,args:CompactOptions)=>transform(project,'compact',args);
export const analyzeTilesetUsage=(project:string,args:CompactOptions)=>transform(project,'compact',{...args,dryRun:true});
export const planTilesetMerge=(project:string,args:MergeOptions)=>transform(project,'merge',{...args,dryRun:true});
export const mergeTilesets=(project:string,args:MergeOptions)=>transform(project,'merge',args);

const commonProperties={outputName:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$'},runtimeMaxHeight:{type:'integer',minimum:32,maximum:129536,multipleOf:32},dryRun:{type:'boolean',default:true},reviewedPlanHash:{type:'string',pattern:'^[a-f0-9]{64}$'},acknowledgeDynamicReferences:{type:'boolean'}};
const compactProperties={...commonProperties,tilesetId:{type:'integer',minimum:1,maximum:999999},deduplicate:{type:'boolean',default:true}};
const mergeProperties={...commonProperties,targetTilesetId:{type:'integer',minimum:1,maximum:999999},sourceTilesetIds:{type:'array',minItems:1,maxItems:31,uniqueItems:true,items:{type:'integer',minimum:1,maximum:999999}}};
export const tilesetTransformExtensions:ToolExtension[]=[
  {definition:{name:'analyze_tileset_usage',description:'Read-only stored tile usage, compatible duplicates, unused regular tiles and full proposed compact mapping. Scripts/runtime references remain unknown. Supply a new outputName and tested runtimeMaxHeight.',inputSchema:{type:'object',properties:compactProperties,required:['tilesetId','outputName','runtimeMaxHeight'],additionalProperties:false}},mutates:()=>false,run:analyzeTilesetUsage},
  {definition:{name:'compact_used_tileset',description:'Compact stored map/event tile usage with exact pixel-and-property deduplication. Defaults to dry-run. Apply requires matching reviewedPlanHash and acknowledgeDynamicReferences=true; backs up and stages all changed maps, image and database. Source image retained.',inputSchema:{type:'object',properties:compactProperties,required:['tilesetId','outputName','runtimeMaxHeight'],additionalProperties:false}},mutates:a=>a.dryRun===false,run:compactUsedTileset},
  {definition:{name:'plan_tileset_merge',description:'Read-only property-preserving concatenation plan. Target prefix IDs retained. Rejects autotile/reserved flag or map setting conflicts. Reports full remapping, dimensions and bounded workload estimate; requires explicit tested runtimeMaxHeight.',inputSchema:{type:'object',properties:mergeProperties,required:['targetTilesetId','sourceTilesetIds','outputName','runtimeMaxHeight'],additionalProperties:false}},mutates:()=>false,run:planTilesetMerge},
  {definition:{name:'merge_tilesets',description:'Merge banks preserving target prefix, flags and all stored map/event tile references. Defaults to dry-run; applying requires matching reviewedPlanHash and acknowledgeDynamicReferences=true. Rejects conflicting autotiles/settings, retains source records/images.',inputSchema:{type:'object',properties:mergeProperties,required:['targetTilesetId','sourceTilesetIds','outputName','runtimeMaxHeight'],additionalProperties:false}},mutates:a=>a.dryRun===false,run:mergeTilesets},
];

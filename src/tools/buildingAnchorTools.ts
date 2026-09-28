import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRxdataFile, getDataPath } from '../utils/fileHandler.js';
import { allowed, readLimited } from '../utils/security.js';
import { cellSchema, Cell, movementContext, directions } from './movementAuditTools.js';
import type { ToolExtension } from '../utils/toolExtension.js';

type Anchor = { name:string; kind:'door'|'approach'|'shadow'|'padding'; x:number;y:number;direction?:number };
type CatalogObject = { id:string;width:number;height:number;anchors:Anchor[] };
const signedCell={type:'object',properties:{x:{type:'integer',minimum:-500,maximum:500},y:{type:'integer',minimum:-500,maximum:500}},required:['x','y'],additionalProperties:false};
const anchorSchema={...signedCell,properties:{...signedCell.properties,name:{type:'string',minLength:1,maxLength:128},kind:{type:'string',enum:['door','approach','shadow','padding']},direction:{type:'integer',enum:[2,4,6,8]}},required:['name','kind','x','y']};
const objectSchema={type:'object',properties:{id:{type:'string',minLength:1,maxLength:128},width:{type:'integer',minimum:1,maximum:500},height:{type:'integer',minimum:1,maximum:500},anchors:{type:'array',minItems:1,maxItems:32,items:anchorSchema}},required:['id','width','height','anchors'],additionalProperties:false};

export function inspectBuildingCatalog(objects:CatalogObject[]) {
  if(!objects.length||objects.length>128)throw new Error('Catalog must contain 1..128 objects');
  const ids=new Set<string>();
  return {objects:objects.map(o=>{if(!o.id||ids.has(o.id)||!Number.isInteger(o.width)||!Number.isInteger(o.height)||o.width<1||o.height<1||o.width>500||o.height>500)throw new Error('Invalid catalog object');ids.add(o.id);const names=new Set<string>();if(!o.anchors.length||o.anchors.length>32)throw new Error('Invalid anchors');for(const a of o.anchors){if(!a.name||names.has(a.name)||!['door','approach','shadow','padding'].includes(a.kind)||!Number.isInteger(a.x)||!Number.isInteger(a.y)||Math.abs(a.x)>500||Math.abs(a.y)>500||(a.direction!==undefined&&!directions.some(d=>d.d===a.direction)))throw new Error('Invalid or duplicate anchor');names.add(a.name);if(a.kind==='door'&&(a.x<0||a.y<0||a.x>=o.width||a.y>=o.height))throw new Error('Door anchor outside graphic footprint');}return o;}),units:'map tiles; anchors are explicit user evidence, not image-derived identities'};
}

export async function planBuildingPlacement(project:string,options:{mapId:number;eventId:number;object:CatalogObject;doorAnchor:string;replaceableCells?:Cell[];proposedTiles?:{layer:number;tileIds:(number|null)[]}}) {
  inspectBuildingCatalog([options.object]);const c=await movementContext(project,options.mapId);const event=c.map.events?.[String(options.eventId)];if(!event)throw new Error('Anchor event not found');c.checkCell(event);
  const anchor=options.object.anchors.find(a=>a.name===options.doorAnchor&&a.kind==='door');if(!anchor)throw new Error('Named door anchor not found');
  if((options.replaceableCells?.length??0)>250000)throw new Error('Too many replaceable cells');
  const replaceable=new Set((options.replaceableCells??[]).map(p=>{c.checkCell(p);return p.y*c.w+p.x;}));
  const origin={x:event.x-anchor.x,y:event.y-anchor.y},conflicts:any[]=[];let conflictCount=0;
  const add=(v:any)=>{conflictCount++;if(conflicts.length<512)conflicts.push(v);};
  for(let y=0;y<options.object.height;y++)for(let x=0;x<options.object.width;x++){const p={x:origin.x+x,y:origin.y+y};if(!c.inside(p)){add({...p,reason:'outside-map'});continue;}if(!replaceable.has(p.y*c.w+p.x)&&[0,1,2].some(z=>c.map.data.data[(z*c.h+p.y)*c.w+p.x]!==0))add({...p,reason:'occupied-tile; explicitly mark replacement cells after review'});}
  for(const e of Object.values(c.map.events??{}) as any[])if(e.id!==event.id&&e.x>=origin.x&&e.y>=origin.y&&e.x<origin.x+options.object.width&&e.y<origin.y+options.object.height)add({x:e.x,y:e.y,eventId:e.id,reason:'other-event'});
  const anchors=options.object.anchors.map(a=>{const p={x:origin.x+a.x,y:origin.y+a.y};return {...a,world:p,inBounds:c.inside(p),currentTilePassage:c.inside(p)?directions.map(d=>({direction:d.d,canExit:c.move(p,d.d)})):[],facesDoor:a.kind==='approach'&&a.direction?(()=>{const d=directions.find(d=>d.d===a.direction)!;return p.x+d.x===event.x&&p.y+d.y===event.y;})():null};});
  let proposedAnchorCollision:any=null;
  if(options.proposedTiles){const {layer,tileIds}=options.proposedTiles;if(!Number.isInteger(layer)||layer<0||layer>2||tileIds.length!==options.object.width*options.object.height)throw new Error('Proposed grid must match object footprint and one map layer');const oldData=c.map.data.data;c.map.data.data=[...oldData];
    try{for(let i=0;i<tileIds.length;i++){const id=tileIds[i];if(id===null)continue;if(!Number.isInteger(id)||id<0||id>=c.tileset.passages.xsize)throw new Error('Proposed tile ID outside map tileset');const p={x:origin.x+i%options.object.width,y:origin.y+Math.floor(i/options.object.width)};c.checkCell(p);c.map.data.data[(layer*c.h+p.y)*c.w+p.x]=id;}
      proposedAnchorCollision=anchors.map(a=>({name:a.name,kind:a.kind,world:a.world,inBounds:a.inBounds,directions:directions.map(d=>({direction:d.d,canExit:c.move(a.world,d.d)})),stepIntoDoor:a.kind==='approach'&&a.direction?c.move(a.world,a.direction):null}));
    }finally{c.map.data.data=oldData;}
  }
  return {dryRun:true,mapId:options.mapId,eventId:event.id,origin,footprint:{...origin,width:options.object.width,height:options.object.height},anchors,conflictCount,conflicts,conflictsTruncated:conflictCount>conflicts.length,preservedEvent:event,proposedAnchorCollision,newGraphicCollision:proposedAnchorCollision?'stock XP tile-stack preview with supplied IDs and current tileset flags; runtime unknown':'unknown; no tile grid or new flags supplied; inspect before applying',activation:'unknown; verify target-runtime arrival, exit, trigger, visibility and direction locks separately',writes:[]};
}

type Target={mapId:number;x:number;y:number};
type Selection={mapId:number;eventId:number;pageIndex:number;commandIndex:number};
export async function planTransferRelocation(project:string,options:{oldDestination:Target;newDestination:Target;selected?:Selection[];oldApproach?:Cell}) {
  for(const t of [options.oldDestination,options.newDestination]){const c=await movementContext(project,t.mapId);c.checkCell(t);}
  const files=(await readdir(allowed(join(project,'Data')))).filter(n=>/^Map\d+\.rxdata$/i.test(n)).sort();if(files.length>10000)throw new Error('Map inventory limit exceeded');
  const inventory=new Set<number>();for(const file of files){const id=Number(file.match(/\d+/)![0]);if(!Number.isSafeInteger(id)||id<1||inventory.has(id))throw new Error('Duplicate or invalid numeric map ID');inventory.add(id);}
  const infos=await readRxdataFile<any>(getDataPath(project,'MapInfos.rxdata'));if(!infos||Array.isArray(infos))throw new Error('Invalid MapInfos');for(const id of Object.keys(infos))if(!inventory.has(Number(id)))throw new Error('Indexed map missing from disk');
  const references:any[]=[],unresolved:any[]=[];let bytes=0,commandCount=0,unresolvedCount=0;
  const selected=options.selected??[];if(selected.length>512)throw new Error('Selection limit exceeded');
  const key=(s:Selection)=>`${s.mapId}/${s.eventId}/${s.pageIndex}/${s.commandIndex}`;const selection=new Set(selected.map(key));if(selection.size!==selected.length)throw new Error('Duplicate selection');const found=new Set<string>();
  for(const file of files){const path=join(project,'Data',file);bytes+=(await readLimited(path)).length;if(bytes>128*1024*1024)throw new Error('Map scan exceeds 128 MiB');const map=await readRxdataFile<any>(path),mapId=Number(file.match(/\d+/)![0]);if(map?._class!=='RPG::Map')throw new Error('Invalid map');
    for(const e of Object.values(map.events??{}) as any[])for(const [pageIndex,page]of(e.pages??[]).entries())for(const [commandIndex,cmd]of(page.list??[]).entries()){
      if(++commandCount>1000000)throw new Error('Command scan limit exceeded');const source={mapId,eventId:e.id,pageIndex,commandIndex},p=cmd.parameters;
      if(cmd.code===355||cmd.code===655||(cmd.code===201&&p?.[0]!==0)){unresolvedCount++;if(unresolved.length<512)unresolved.push({...source,reason:cmd.code===201?'variable-based transfer':'script may compute destination'});}
      if(cmd.code!==201||p?.[0]!==0||p[1]!==options.oldDestination.mapId)continue;
      const door=p[2]===options.oldDestination.x&&p[3]===options.oldDestination.y,approach=options.oldApproach&&p[2]===options.oldApproach.x&&p[3]===options.oldApproach.y;if(!door&&!approach)continue;
      if(references.length>=4096)throw new Error('Reference result limit exceeded');const chosen=selection.has(key(source));if(chosen)found.add(key(source));
      const after=[...p];if(chosen){after[1]=options.newDestination.mapId;after[2]=options.newDestination.x+(approach&&!door?options.oldApproach!.x-options.oldDestination.x:0);after[3]=options.newDestination.y+(approach&&!door?options.oldApproach!.y-options.oldDestination.y:0);}
      references.push({...source,destinationRole:door?'door':'approach',selected:chosen,before:p,proposedParameters:after});
    }
  }
  if(found.size!==selection.size)throw new Error('Selected reference does not match old destination');
  const dest=await movementContext(project,options.newDestination.mapId);for(const r of references)if(r.selected)dest.checkCell({x:r.proposedParameters[2],y:r.proposedParameters[3]});
  return {dryRun:true,mapsScanned:files.length,references,unresolved,unresolvedCount,ambiguous:references.length>1,writes:[],limitations:['Only direct Transfer Player (201) commands are indexed. Scripts and variables remain unresolved.','No changes applied; use reviewed explicit event-page edits. Unselected links must remain unchanged.','Event activation and bidirectional travel require target-runtime tests.']};
}

const targetSchema={...cellSchema,properties:{...cellSchema.properties,mapId:{type:'integer',minimum:1}},required:['mapId','x','y']};
export const buildingAnchorExtensions:ToolExtension[]=[
 {definition:{name:'inspect_building_catalog',description:'Validate an explicit semantic building-anchor catalog in tile units. No image inference or writes.',inputSchema:{type:'object',properties:{objects:{type:'array',minItems:1,maxItems:128,items:objectSchema}},required:['objects'],additionalProperties:false}},mutates:()=>false,run:async(_p,a)=>inspectBuildingCatalog(a.objects)},
 {definition:{name:'plan_building_placement',description:'Align a named door anchor to an existing event without moving or editing it. Optional proposedTiles previews new flags using the map tileset. Report collision, bounds and conflicts; no writes.',inputSchema:{type:'object',properties:{mapId:{type:'integer',minimum:1},eventId:{type:'integer',minimum:1},object:objectSchema,doorAnchor:{type:'string',minLength:1,maxLength:128},replaceableCells:{type:'array',maxItems:250000,items:cellSchema},proposedTiles:{type:'object',properties:{layer:{type:'integer',minimum:0,maximum:2},tileIds:{type:'array',maxItems:250000,items:{anyOf:[{type:'integer',minimum:0,maximum:32767},{type:'null'}]}}},required:['layer','tileIds'],additionalProperties:false}},required:['mapId','eventId','object','doorAnchor'],additionalProperties:false}},mutates:()=>false,run:planBuildingPlacement},
 {definition:{name:'plan_transfer_relocation',description:'Scan all on-disk maps for incoming direct transfers to a door/approach. Explicit selections only; preview preserves unrelated parameters. Scripts/variables unresolved. No writes.',inputSchema:{type:'object',properties:{oldDestination:targetSchema,newDestination:targetSchema,oldApproach:cellSchema,selected:{type:'array',maxItems:512,items:{type:'object',properties:{mapId:{type:'integer',minimum:1},eventId:{type:'integer',minimum:1},pageIndex:{type:'integer',minimum:0},commandIndex:{type:'integer',minimum:0}},required:['mapId','eventId','pageIndex','commandIndex'],additionalProperties:false}}},required:['oldDestination','newDestination'],additionalProperties:false}},mutates:()=>false,run:planTransferRelocation}
];

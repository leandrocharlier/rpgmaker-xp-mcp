import { readRxdataFile, getMapPath } from '../utils/fileHandler.js';
import { loadTilesetRecord } from './tilesetTools.js';
import type { ToolExtension } from '../utils/toolExtension.js';

export type Cell = { x: number; y: number };
type Zone = Cell & { width: number; height: number };
function routeGeometry(page:any,event:Cell,footprint:Zone|undefined,inside:(p:Cell)=>boolean,move:(p:Cell,d:number)=>boolean) {
  let position={x:event.x,y:event.y};const steps:any[]=[];let unknown=!!page.through;
  const inFootprint=(p:Cell)=>!footprint||(p.x>=footprint.x&&p.y>=footprint.y&&p.x<footprint.x+footprint.width&&p.y<footprint.y+footprint.height);
  const route=page.move_route?.list??[];
  if(route.length>4096)throw new Error('Event route exceeds audit limit');
  for(let i=0;i<route.length;i++){
    const cmd=route[i];if(cmd.code===0)break;
    if(cmd.code>=1&&cmd.code<=4){const d=directions[cmd.code-1];const next={x:position.x+d.x,y:position.y+d.y};steps.push({commandIndex:i,from:position,to:next,direction:d.d,inBounds:inside(next),insideFootprint:inFootprint(next),tileModelCanStep:move(position,d.d)});position=next;}
    else if(!(cmd.code>=15&&cmd.code<=26)){unknown=true;break;}
  }
  return {steps,unknown,kind:'hypothetical route geometry only; execution, collisions, waits and page activation not simulated'};
}
export const cellSchema = { type: 'object', properties: { x: { type: 'integer', minimum: 0, maximum: 499 }, y: { type: 'integer', minimum: 0, maximum: 499 } }, required: ['x','y'], additionalProperties: false };
const zoneSchema = { ...cellSchema, properties: { ...cellSchema.properties, width: { type: 'integer', minimum: 1, maximum: 500 }, height: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['x','y','width','height'] };
export const directions = [{ d: 2, x: 0, y: 1 }, { d: 4, x: -1, y: 0 }, { d: 6, x: 1, y: 0 }, { d: 8, x: 0, y: -1 }];
export async function movementContext(project: string, mapId: number) {
  const map = await readRxdataFile<any>(getMapPath(project, mapId));
  const { tileset, size } = await loadTilesetRecord(project, map.tileset_id);
  if(tileset.passages.data.some((v:number)=>!Number.isInteger(v)||v<0||v>255)||tileset.priorities.data.some((v:number)=>!Number.isInteger(v)||v<0||v>5))throw new Error('Invalid XP passage or priority flags');
  const w = map.width, h = map.height;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 500 || h > 500 || map.data?.xsize !== w || map.data?.ysize !== h || map.data?.zsize !== 3 || map.data?.data?.length !== w*h*3) throw new Error('Invalid map geometry');
  for (const id of map.data.data) if (!Number.isInteger(id) || id < 0 || id >= size) throw new Error('Map references invalid tile ID');
  const inside = (p: Cell) => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
  const checkCell = (p: Cell) => { if (!p || !inside(p)) throw new Error('Cell outside map'); };
  // Stock XP tile-stack rule, excluding runtime-selected event tiles and characters.
  const pass = (p: Cell, d: number) => {
    if (!inside(p)) return false;
    const bit = 1 << (d / 2 - 1);
    for (let z = 2; z >= 0; z--) {
      const id = map.data.data[(z*h+p.y)*w+p.x];
      if ((tileset.passages.data[id] & bit) !== 0) return false;
      if (tileset.priorities.data[id] === 0) return true;
    }
    return true;
  };
  const move = (p: Cell, d: number) => { const delta = directions.find(v => v.d === d); if (!delta) throw new Error('Invalid direction'); const q = { x: p.x+delta.x, y: p.y+delta.y }; return inside(q) && pass(p,d) && pass(q,10-d); };
  return { map, tileset, w, h, inside, checkCell, pass, move };
}

export async function auditMovement(project: string, options: { mapId: number; start: Cell; runtimeProfile: 'xp-standard'|'unknown'; allowed?: Zone[]; forbidden?: Zone[]; goals?: Cell[]; approaches?: { eventId: number; cell: Cell; direction: number; footprint?: Zone }[] }) {
  if (!['xp-standard','unknown'].includes(options.runtimeProfile)) throw new Error('Explicit runtime profile required');
  const c = await movementContext(project, options.mapId); c.checkCell(options.start);
  const zones = [...options.allowed ?? [], ...options.forbidden ?? []];
  if (zones.length > 256 || (options.goals?.length ?? 0) > 128 || (options.approaches?.length ?? 0) > 128) throw new Error('Too many audit selections');
  const checkZone = (z: Zone) => { c.checkCell(z); if (!Number.isInteger(z.width) || !Number.isInteger(z.height) || z.width < 1 || z.height < 1 || !c.inside({x:z.x+z.width-1,y:z.y+z.height-1})) throw new Error('Invalid zone'); };
  zones.forEach(checkZone);
  const contains = (z: Zone,p: Cell) => p.x>=z.x && p.y>=z.y && p.x<z.x+z.width && p.y<z.y+z.height;
  const parent = new Int32Array(c.w*c.h).fill(-2), queue = new Int32Array(c.w*c.h);
  const first = options.start.y*c.w+options.start.x; parent[first]=-1; queue[0]=first; let tail=1;
  for (let head=0;head<tail;head++) { const i=queue[head],p={x:i%c.w,y:Math.floor(i/c.w)}; for (const d of directions) if(c.move(p,d.d)) {const j=(p.y+d.y)*c.w+p.x+d.x;if(parent[j]===-2){parent[j]=i;queue[tail++]=j;}} }
  let witnessBudget=20000;
  const path = (p: Cell) => { let i=p.y*c.w+p.x; if(parent[i]===-2)return null; const result:Cell[]=[];let length=0;while(i!==-1){if(result.length<Math.min(4096,witnessBudget))result.push({x:i%c.w,y:Math.floor(i/c.w)});length++;i=parent[i];}witnessBudget-=result.length;return {cells:result.reverse(),totalCells:length,truncated:length>result.length,segment:'destination end'}; };
  let escape: Cell | undefined;
  for(let n=0;n<tail;n++){const p={x:queue[n]%c.w,y:Math.floor(queue[n]/c.w)};if((options.allowed?.length && !options.allowed.some(z=>contains(z,p))) || options.forbidden?.some(z=>contains(z,p))){escape=p;break;}}
  const goals=(options.goals??[]).map(p=>{c.checkCell(p);return {cell:p,reachable:parent[p.y*c.w+p.x]!==-2};});
  let routeWork=0,pageWork=0;
  const approaches=(options.approaches??[]).map(a=>{
    c.checkCell(a.cell);const e=c.map.events?.[String(a.eventId)];if(!e)throw new Error('Approach event not found');
    const d=directions.find(d=>d.d===a.direction);if(!d)throw new Error('Invalid approach direction');
    if(a.footprint)checkZone(a.footprint);
    for(const page of (e.pages??[]).slice(0,128)){routeWork+=page.move_route?.list?.length??0;if(++pageWork>512||routeWork>20000)throw new Error('Aggregate route audit budget exceeded');}
    return {eventId:a.eventId,cell:a.cell,direction:a.direction,approachReachable:parent[a.cell.y*c.w+a.cell.x]!==-2,facesEvent:a.cell.x+d.x===e.x&&a.cell.y+d.y===e.y,stepIntoEvent:c.move(a.cell,a.direction),eventInFootprint:a.footprint?contains(a.footprint,e):null,witness:path(a.cell),activation:'unknown; test in target runtime including transfer, visibility and direction locks',pages:(e.pages??[]).slice(0,128).map((p:any,index:number)=>({index,trigger:p.trigger,moveType:p.move_type,routeGeometry:routeGeometry(p,e,a.footprint,c.inside,c.move),condition:p.condition??null})),pagesTruncated:(e.pages?.length??0)>128};
  });
  const eventCount=Object.keys(c.map.events??{}).length;
  return {mapId:options.mapId,runtimeProfile:options.runtimeProfile,model:'stock XP tile stacks only; event collision and active pages are not simulated',reachableCells:tail,containmentChecked:zones.length>0,contained:escape===undefined,escape:escape?{cell:escape,witness:path(escape)}:null,goals,approaches,tileModelPass:!escape&&goals.every(g=>g.reachable),runtimeVerdict:options.runtimeProfile==='xp-standard'&&eventCount===0?'tile-model-only':'unknown',limitations:['Scripts, event page conditions, tile/character event collision, forced routes, transfers, looping maps and Essentials rules require runtime validation.','Blocked stair approaches are not proof of activation; walkable event cells are not proof either.']};
}

export const movementToolDefinitions = [{name:'audit_movement',description:'Read-only stock XP tile-stack reachability and containment with escape witness. Explicit profile; runtime event activation remains unknown.',inputSchema:{type:'object',properties:{mapId:{type:'integer',minimum:1},start:cellSchema,runtimeProfile:{type:'string',enum:['xp-standard','unknown']},allowed:{type:'array',maxItems:128,items:zoneSchema},forbidden:{type:'array',maxItems:128,items:zoneSchema},goals:{type:'array',maxItems:128,items:cellSchema},approaches:{type:'array',maxItems:128,items:{type:'object',properties:{eventId:{type:'integer',minimum:1},cell:cellSchema,direction:{type:'integer',enum:[2,4,6,8]},footprint:zoneSchema},required:['eventId','cell','direction'],additionalProperties:false}}},required:['mapId','start','runtimeProfile'],additionalProperties:false}}];
export const movementAuditExtensions:ToolExtension[] = movementToolDefinitions.map(definition=>({definition:definition as ToolExtension['definition'],mutates:()=>false,run:auditMovement}));

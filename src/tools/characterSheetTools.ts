import { makeCanvas, Canvas, drawGrid } from '../utils/tiles.js';
import { asset, hash, integer, text, readSpec, pixel, output, ASSET_PIXELS } from '../utils/assetReviewSupport.js';
import { guardProjectReads } from '../utils/security.js';
import { resolve } from 'node:path';
import type { ToolExtension } from '../utils/toolExtension.js';

/** Explicit layout only: no filename, engine or movement-role inference. */
export async function characterSheet(project: string, args: { specPath: string; outputName?: string; dryRun?: boolean }) {
  const spec = await readSpec(project,args.specPath), budget = { pixels:0 };
  const src = await asset(project,spec.sourcePath,budget), image = src.image;
  const columns = integer(spec.layout?.columns,'columns',1,32), rows = integer(spec.layout?.rows,'rows',1,32);
  if (image.width % columns || image.height % rows) throw new Error('Source dimensions must divide explicit layout exactly');
  if (spec.layout?.engine !== 'xp' && spec.layout?.engine !== 'explicit') throw new Error('layout.engine must be xp or explicit; MV/MZ is never inferred');
  if (spec.layout.engine === 'xp' && (columns !== 4 || rows !== 4)) throw new Error('XP single-character layout requires 4 columns and 4 rows');
  const fw = image.width / columns, fh = image.height / rows;
  if (!Array.isArray(spec.directions) || spec.directions.length !== rows || new Set(spec.directions).size !== rows) throw new Error('Provide one unique direction label per explicit row');
  spec.directions.forEach((d: unknown) => text(d,'direction'));
  const role = text(spec.role,'role label');
  if (!Array.isArray(spec.anchors) || spec.anchors.length !== columns*rows) throw new Error('Provide one explicit frame-local anchor per source frame');
  const frames: any[] = [], warnings: string[] = [];
  for (let i=0;i<columns*rows;i++) {
    const ax = integer(spec.anchors[i]?.x,'anchor x',0,fw), ay = integer(spec.anchors[i]?.y,'anchor y',0,fh);
    let left=fw, top=fh, right=-1, bottom=-1, opaque=0, translucent=0, transparent=0;
    for (let y=0;y<fh;y++) for(let x=0;x<fw;x++) {
      const alpha=image.data[((Math.floor(i/columns)*fh+y)*image.width+(i%columns)*fw+x)*4+3];
      if(alpha===0) transparent++; else { if(alpha===255) opaque++; else translucent++; left=Math.min(left,x); top=Math.min(top,y); right=Math.max(right,x); bottom=Math.max(bottom,y); }
    }
    const bbox=right<0?null:{x:left,y:top,width:right-left+1,height:bottom-top+1};
    if(!transparent) warnings.push(`Frame ${i}: no transparent pixels; opaque background requires review`);
    if(!bbox) warnings.push(`Frame ${i}: empty frame`);
    frames.push({frame:i,direction:spec.directions[Math.floor(i/columns)],column:i%columns,anchor:{x:ax,y:ay},bbox,transparent,translucent,opaque,bottomCenterOffset:bbox?{x:(left+right+1)/2-ax,y:bottom+1-ay}:null});
  }
  const drift=spec.directions.map((direction:string,row:number)=>({direction,offsets:frames.slice(row*columns,(row+1)*columns).map(f=>f.bottomCenterOffset)}));
  let target: Canvas | undefined, mapping: any[] = [];
  if(spec.conversion) {
    const c=spec.conversion, tc=integer(c.columns,'target columns',1,32), tr=integer(c.rows,'target rows',1,32), tw=integer(c.frameWidth,'target frameWidth',1,1024), th=integer(c.frameHeight,'target frameHeight',1,1024), scale=integer(c.scale,'scale',1,8);
    if(c.engine!=='xp'&&c.engine!=='explicit') throw new Error('Explicit target engine required');
    if(c.engine==='xp'&&(tc!==4||tr!==4)) throw new Error('XP target requires 4x4 layout');
    if(!Array.isArray(c.frames)||c.frames.length!==tc*tr) throw new Error('Target requires an explicit source index and anchor for every frame');
    if(tc*tw*tr*th>ASSET_PIXELS || (image.width+tc*tw)*Math.max(image.height,tr*th)>ASSET_PIXELS) throw new Error('Character output/preview exceeds 8 megapixels');
    target=makeCanvas(tc*tw,tr*th);
    for(let i=0;i<c.frames.length;i++) {
      const m=c.frames[i], sourceIndex=integer(m.sourceFrame,'sourceFrame',0,frames.length-1), anchor={x:integer(m.anchor?.x,'target anchor x',0,tw),y:integer(m.anchor?.y,'target anchor y',0,th)}, f=frames[sourceIndex];
      const dx=anchor.x-f.anchor.x*scale,dy=anchor.y-f.anchor.y*scale;
      // Never silently clip even fully transparent source pixels: full frame identity is preserved.
      if(dx<0||dy<0||dx+fw*scale>tw||dy+fh*scale>th) throw new Error(`Source frame ${sourceIndex} clips target; enlarge frame or adjust explicit anchors`);
      for(let y=0;y<fh;y++) for(let x=0;x<fw;x++) for(let sy=0;sy<scale;sy++) for(let sx=0;sx<scale;sx++) pixel(image,target,(sourceIndex%columns)*fw+x,Math.floor(sourceIndex/columns)*fh+y,(i%tc)*tw+dx+x*scale+sx,Math.floor(i/tc)*th+dy+y*scale+sy);
      mapping.push({targetFrame:i,sourceFrame:sourceIndex,anchor,offset:{x:dx,y:dy},scale});
    }
  }
  const reviewBinding=hash(JSON.stringify({source:src.sha256,layout:spec.layout,directions:spec.directions,anchors:spec.anchors,role,conversion:spec.conversion??null}));
  const report={dryRun:args.dryRun!==false,sourcePath:src.path,sourceSha256:src.sha256,reviewBinding,role,layout:spec.layout,frameWidth:fw,frameHeight:fh,frames,alignment:drift,warnings,mapping,target:target?{width:target.width,height:target.height}:null,note:'Role labels are caller metadata, not Essentials PBS or engine compatibility. Opaque/empty frames and drift require visual review; runtime animation and active pages are not tested.'};
  if(args.dryRun!==false)return report;
  if(!target)throw new Error('Explicit conversion is required to export');
  if(spec.review?.binding!==reviewBinding || typeof spec.review?.evidence!=='string'||!spec.review.evidence.trim()||spec.review.evidence.length>4096) throw new Error('Export requires explicit review evidence tied to source, layout, anchors and conversion');
  guardProjectReads([resolve(project,args.specPath),src.path]);
  const preview=makeCanvas(image.width+target.width,Math.max(image.height,target.height));
  for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++)pixel(image,preview,x,y,x,y);
  for(let y=0;y<target.height;y++)for(let x=0;x<target.width;x++)pixel(target,preview,x,y,image.width+x,y);
  drawGrid(preview,32);
  return {...report,files:await output(project,'.mcp-preview',text(args.outputName,'outputName'),{'character.png':target,'before-after.png':preview,'frames.json':report})};
}

export const characterSheetExtensions: ToolExtension[] = [{definition:{name:'inspect_character_sheet',description:'Inspect an explicitly laid out character PNG via JSON specification (layout, direction/role labels, frame anchors). Optional explicit frame remapping converts/extracts frames with clipping rejection and comparison preview. Default dry-run; see docs/ASSET-REVIEW.md.',inputSchema:{type:'object',properties:{specPath:{type:'string',minLength:1,maxLength:1024},outputName:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'},dryRun:{type:'boolean'}},required:['specPath'],additionalProperties:false}},mutates:args=>args.dryRun===false,run:characterSheet}];

export async function validateCharacterSet(project:string,args:{specPaths:string[]}) {
  if(!Array.isArray(args.specPaths)||!args.specPaths.length||args.specPaths.length>16)throw new Error('Supply 1..16 explicitly labeled sheets');
  const sheets=[]; const roles=new Set<string>();
  for(const specPath of args.specPaths) {
    const report=await characterSheet(project,{specPath});
    if(roles.has(report.role))throw new Error('Character set role labels must be unique');roles.add(report.role);
    sheets.push(report);
  }
  const first=sheets[0];
  return {sheets,compatibleGeometry:sheets.every(s=>s.frameWidth===first.frameWidth&&s.frameHeight===first.frameHeight&&JSON.stringify(s.layout)===JSON.stringify(first.layout)),note:'Geometry agreement does not establish runtime animation compatibility. Review direction ordering, per-frame anchors and role transitions in the game runtime; no standard XP role mapping is assumed.'};
}
characterSheetExtensions.push({definition:{name:'validate_character_set',description:'Read-only comparison of explicitly labeled character-sheet specifications for walking/running/cycling/surfing/fishing or arbitrary caller roles. Reports each frame and geometry without reading Essentials metadata.',inputSchema:{type:'object',properties:{specPaths:{type:'array',items:{type:'string',minLength:1,maxLength:1024},minItems:1,maxItems:16}},required:['specPaths'],additionalProperties:false}},mutates:()=>false,run:validateCharacterSet});

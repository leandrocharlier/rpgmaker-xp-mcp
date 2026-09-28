import { Canvas, makeCanvas, drawGrid, fillRect } from '../utils/tiles.js';
import { asset, hash, integer, text, readSpec, rect, pixel, output, ASSET_PIXELS, Rect } from '../utils/assetReviewSupport.js';
import type { ToolExtension } from '../utils/toolExtension.js';
import { guardProjectReads, allowed, beforeProjectCommit } from '../utils/security.js';
import { resolve, join } from 'node:path';
import { readdir } from 'node:fs/promises';

function replicationHints(image:Canvas):number[] {
  const factors:number[]=[];
  for(const factor of [2,3,4]) {
    if(image.width%factor||image.height%factor)continue;
    let exact=true;
    outer:for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++) {
      const a=(y*image.width+x)*4,b=(Math.floor(y/factor)*factor*image.width+Math.floor(x/factor)*factor)*4;
      for(let c=0;c<4;c++)if(image.data[a+c]!==image.data[b+c]) {exact=false;break outer;}
    }
    if(exact)factors.push(factor);
  }
  return factors;
}

/** A curation gate, not a semantic classifier. Inputs are explicit JSON review manifests. */
export async function reviewedImport(project: string, args: { specPath: string; outputName?: string; dryRun?: boolean }) {
  const spec = await readSpec(project, args.specPath);
  const inventory = async ():Promise<string[]> => {
    if(!spec.inventoryDirectory)return [];
    const files:string[]=[]; let visited=0;
    async function scan(dir:string,depth:number) {
      if(depth>8)throw new Error('Source inventory exceeds depth 8');
      for(const entry of await readdir(allowed(dir),{withFileTypes:true})) {
        if(++visited>4096)throw new Error('Source inventory exceeds 4096 directory entries');
        const path=allowed(join(dir,entry.name));
        if(entry.isDirectory())await scan(path,depth+1);
        else if(entry.isFile()&&/\.png$/i.test(entry.name))files.push(path);
        if(files.length>1024)throw new Error('Source inventory exceeds 1024 PNG files');
      }
    }
    await scan(resolve(project,text(spec.inventoryDirectory,'inventoryDirectory')),0);return files.sort();
  };
  const inventoryFiles=await inventory();
  if (!Array.isArray(spec.sources) || !spec.sources.length || spec.sources.length > 32 || !Array.isArray(spec.regions) || spec.regions.length > 512) throw new Error('Supply 1..32 sources and at most 512 regions');
  const budget = { pixels: 0 }, sources = new Map<string, { image: Canvas; sha256: string; path: string; ownership: Uint8Array; reconstruction: Canvas }>();
  for (const s of spec.sources) {
    const id = text(s.id, 'source id'); if (sources.has(id)) throw new Error('Duplicate source id');
    const value = await asset(project, s.path, budget);
    sources.set(id, { ...value, ownership: new Uint8Array(value.image.width * value.image.height), reconstruction: makeCanvas(value.image.width, value.image.height) });
  }
  const ids = new Set<string>(), pending: string[] = [], entries: any[] = [], warnings: string[] = [];
  let atlasHeight = 0, previewHeight = 0, cropPixels=0, comparisonPixels=0;
  const groups = new Set<string>(); let lastGroup = '';
  for (const r of spec.regions) {
    const id = text(r.id, 'region id'); if (ids.has(id)) throw new Error('Duplicate region id'); ids.add(id);
    const source = sources.get(r.sourceId); if (!source) throw new Error('Unknown source id');
    const crop = rect(r.rect, source.image.width, source.image.height);
    const scale = integer(r.scale, 'scale', 1, 8), padding = integer(r.padding ?? 0, 'padding', 0, 32);
    const grid = r.sourceGrid === null ? null : integer(r.sourceGrid, 'sourceGrid', 1, 64);
    if (!['object', 'modular', 'example_scene', 'credits', 'unreviewed'].includes(r.kind)) throw new Error('Unknown region kind');
    if (!['included', 'duplicate', 'excluded', 'pending'].includes(r.status)) throw new Error('Unknown coverage status');
    const group = text(r.group ?? id, 'group');
    const masks: Rect[] = r.mask === undefined ? [{ x: 0, y: 0, width: crop.width, height: crop.height }] : r.mask;
    if (!Array.isArray(masks) || !masks.length || masks.length > 1024) throw new Error('Supply 1..1024 component-mask rectangles');
    cropPixels+=crop.width*crop.height;
    if(cropPixels>16*1024*1024)throw new Error('Aggregate crop-mask allocation exceeds 16 megapixels');
    const local = new Uint8Array(crop.width * crop.height);
    let selected = 0, edgeInk = false;
    for (const raw of masks) {
      const m = rect(raw, crop.width, crop.height);
      for (let y = m.y; y < m.y + m.height; y++) for (let x = m.x; x < m.x + m.width; x++) {
        const i = y * crop.width + x, si = (y + crop.y) * source.image.width + x + crop.x;
        if (local[i] || source.ownership[si]) throw new Error('Overlapping component/source ownership');
        local[i] = 1; source.ownership[si] = 1; selected++;
        if ((x === 0 || y === 0 || x === crop.width - 1 || y === crop.height - 1) && source.image.data[si * 4 + 3]) edgeInk = true;
      }
    }
    const binding = hash(JSON.stringify({ source: source.sha256, crop, masks, scale, padding, grid, kind: r.kind, group, status: r.status, duplicateOf: r.duplicateOf ?? null, label: r.label ?? id, reason:r.reason??null, modularSplitReviewed:r.modularSplitReviewed??false }));
    const reviewed = r.review?.binding === binding && typeof r.review?.evidence === 'string' && r.review.evidence.trim().length > 0 && r.review.evidence.length <= 4096 && r.review?.boundsConfirmed === true;
    if (r.status !== 'pending' && !reviewed) pending.push(`${id}: missing/stale review evidence`);
    if (r.status === 'pending' || r.kind === 'unreviewed') pending.push(`${id}: pending classification`);
    if (r.status === 'included' && (!['object', 'modular'].includes(r.kind) || grid === null || grid * scale !== 32)) pending.push(`${id}: included art requires explicit grid * scale = 32 and playable kind`);
    if (r.status === 'excluded' && !['example_scene', 'credits'].includes(r.kind) && !r.reason) pending.push(`${id}: exclusion requires a reason`);
    if (r.status === 'duplicate' && !r.duplicateOf) throw new Error('Duplicate requires duplicateOf region id');
    if (edgeInk) warnings.push(`${id}: opaque pixels touch crop boundary; review potential cuts (heuristic only)`);
    let destination: any = null;
    if (r.status === 'included') {
      if (lastGroup !== group && groups.has(group)) throw new Error('Related group pieces must be contiguous'); groups.add(group); lastGroup = group;
      if (r.kind === 'modular' && r.modularSplitReviewed !== true) pending.push(`${id}: modular boundaries need explicit modularSplitReviewed`);
      const width = crop.width * scale + padding * 2, height = crop.height * scale + padding * 2;
      if (width > 256) throw new Error('Object exceeds eight tiles: supply explicitly reviewed modular bands; never auto-slice');
      const slotHeight = Math.ceil(height / 32) * 32;
      destination = { x: padding, y: atlasHeight + padding, width: crop.width * scale, height: crop.height * scale, firstRow: atlasHeight / 32, rowCount: slotHeight / 32, firstTileId: 384 + atlasHeight / 4, lastTileId: 384 + (atlasHeight + slotHeight) / 4 - 1 };
      atlasHeight += slotHeight;
      previewHeight += Math.max(64, crop.height, height) + 32;
    }
    entries.push({ id, sourceId: r.sourceId, label: r.label ?? id, kind: r.kind, status: r.status, group, sourceRect: crop, mask: masks, sourceGrid:grid, scale, padding, modularSplitReviewed:r.modularSplitReviewed===true, selectedPixels: selected, reviewBinding: binding, reviewValid: reviewed, evidence: r.review?.evidence ?? null, duplicateOf: r.duplicateOf ?? null, reason: r.reason ?? null, destination, local });
  }
  for (const e of entries.filter(e => e.status === 'duplicate')) {
    const target = entries.find(t => t.id === e.duplicateOf);
    if (!target || target.status !== 'included') throw new Error('Duplicate target must resolve directly to an included region');
    if(e.sourceRect.width*e.scale!==target.sourceRect.width*target.scale || e.sourceRect.height*e.scale!==target.sourceRect.height*target.scale) throw new Error('Duplicate dimensions do not match reviewed target');
    comparisonPixels+=e.sourceRect.width*e.sourceRect.height*e.scale*e.scale;
    if(comparisonPixels>32*1024*1024)throw new Error('Duplicate comparison exceeds 32 megapixels of work');
    const a=sources.get(e.sourceId)!.image,b=sources.get(target.sourceId)!.image;
    for(let y=0;y<e.sourceRect.height*e.scale;y++)for(let x=0;x<e.sourceRect.width*e.scale;x++) {
      const ax=Math.floor(x/e.scale),ay=Math.floor(y/e.scale),bx=Math.floor(x/target.scale),by=Math.floor(y/target.scale);
      if(e.local[ay*e.sourceRect.width+ax]!==target.local[by*target.sourceRect.width+bx]) throw new Error('Duplicate component masks differ');
      if(e.local[ay*e.sourceRect.width+ax]) for(let ch=0;ch<4;ch++) if(a.data[((e.sourceRect.y+ay)*a.width+e.sourceRect.x+ax)*4+ch]!==b.data[((target.sourceRect.y+by)*b.width+target.sourceRect.x+bx)*4+ch]) throw new Error('Duplicate pixels differ');
    }
    e.destination = target.destination;
  }
  if (atlasHeight * 256 > ASSET_PIXELS || atlasHeight / 4 + 383 > 32767 || previewHeight * 640 > ASSET_PIXELS) throw new Error('Atlas/contact sheet exceeds bounded image or signed tile-ID budget; split collection into reviewed batches');
  const coverage = [...sources].map(([id, s],i) => ({ id, path:s.path, reconstruction:`reconstruction-${i}.png`, sha256: s.sha256, width: s.image.width, height: s.image.height, exactReplicationFactors:replicationHints(s.image), replicationHint:'Ambiguous pixel repetition only, especially on uniform art. Never establishes original grid, scale, identity or review approval.', unaccountedPixels: s.ownership.reduce((n, v) => n + (v ? 0 : 1), 0), regions: entries.filter(e => e.sourceId === id).length }));
  const inventoriedPaths=new Set([...sources.values()].map(s=>s.path));
  const pendingSources=inventoryFiles.filter(path=>!inventoriedPaths.has(path));
  const declaredComplete = !pending.length && coverage.every(s => s.unaccountedPixels === 0);
  const complete = !!spec.inventoryDirectory && !pendingSources.length && declaredComplete && [...inventoriedPaths].every(path=>inventoryFiles.includes(path));
  const index = entries.map(({ local, ...entry }) => entry);
  const appearancePolicy = { mode: 'preserve-source-rgba', automaticBackgroundRemoval: false, shadowAlphaAdaptation: false, note: 'Opaque shadows and painted checker backgrounds remain opaque when selected. A component mask selects pixels; it does not recolor or change alpha. Any intentional appearance adaptation must produce a separately reviewed source with its own hash and evidence describing the exact mask and RGBA change. Exact pixel preservation does not establish visual integration.' };
  const report = { dryRun: args.dryRun !== false, canApply: !pending.length && atlasHeight > 0, coverageComplete: complete, declaredCoverageComplete:declaredComplete, coverageScope: spec.inventoryDirectory ?? 'declared_inventory_only', inventoryFiles,pendingSources, pending, coverage, counts: Object.fromEntries(['included','duplicate','excluded','pending'].map(k => [k, entries.filter(e => e.status === k).length])), index, width: 256, height: atlasHeight, warnings, appearancePolicy, note: 'Pixel continuity does not prove identity. Review bindings attest caller-supplied evidence, not automated visual approval. No maps, flags or tileset database are changed.' };
  if (args.dryRun !== false) return report;
  if (!report.canApply) throw new Error('Review incomplete: ' + pending.join('; '));
  guardProjectReads([resolve(project,args.specPath), ...[...sources.values()].map(s=>s.path)]);
  beforeProjectCommit(async()=>{if(JSON.stringify(await inventory())!==JSON.stringify(inventoryFiles))throw new Error('Source inventory changed during review');});
  const atlas = makeCanvas(256, atlasHeight), contact = makeCanvas(640, previewHeight);
  let cy = 0;
  for (const e of entries.filter(e => e.status === 'included')) {
    const s = sources.get(e.sourceId)!, r = e.sourceRect, d = e.destination;
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) if (e.local[y * r.width + x]) {
      pixel(s.image, s.reconstruction, r.x+x, r.y+y, r.x+x, r.y+y);
      if (x < 256 && cy+y < contact.height) pixel(s.image, contact, r.x+x, r.y+y, x, cy+y);
      for (let sy = 0; sy < e.scale; sy++) for (let sx = 0; sx < e.scale; sx++) {
        pixel(s.image, atlas, r.x+x, r.y+y, d.x+x*e.scale+sx, d.y+y*e.scale+sy);
        pixel(s.image, contact, r.x+x, r.y+y, 288+e.padding+x*e.scale+sx, cy+e.padding+y*e.scale+sy);
      }
    }
    // Neutral reference silhouette: head/body together occupy 32 x 48 pixels.
    fillRect(contact, 584, cy, 16, 16, [128,128,128,255]); fillRect(contact, 576, cy+16, 32, 32, [128,128,128,255]);
    cy += Math.max(64,r.height,r.height*e.scale+2*e.padding)+32;
  }
  drawGrid(contact,32);
  const escape=(value:unknown)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const html=`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"><title>Reviewed source index</title><style>body{font:16px sans-serif;margin:2em}td,th{border:1px solid #aaa;padding:.5em}table{border-collapse:collapse}img{image-rendering:pixelated;max-width:100%}</style><h1>Reviewed source index</h1><p>Coverage complete: ${complete}. <a href="index.json">Machine-readable index</a> · <a href="atlas.png">Atlas</a> · <a href="contact.png">Original/proposed contact sheet</a></p>${coverage.map((s,i)=>`<section id="source-${i}"><h2>${escape(s.id)}</h2><p>${escape(s.path)} · Unaccounted pixels: ${s.unaccountedPixels} · <a href="${s.reconstruction}">Selected-pixel reconstruction</a></p><table><tr><th>Region / group</th><th>Status</th><th>Source rectangle</th><th>Atlas rows / IDs (zero-based rows)</th><th>Exclusion / duplicate</th></tr>${index.filter(e=>e.sourceId===s.id).map(e=>`<tr><td>${escape(e.label)} / ${escape(e.group)}</td><td>${escape(e.status)}</td><td>${escape(JSON.stringify(e.sourceRect))}</td><td>${e.destination?`${e.destination.firstRow}–${e.destination.firstRow+e.destination.rowCount-1} / ${e.destination.firstTileId}–${e.destination.lastTileId}`:'—'}</td><td>${escape(e.reason??e.duplicateOf??'')}</td></tr>`).join('')}</table></section>`).join('')}`;
  const files: Record<string, Canvas | object | string> = { 'atlas.png': atlas, 'contact.png': contact, 'index.json': report, 'index.html':html };
  let n = 0; for (const s of sources.values()) files[`reconstruction-${n++}.png`] = s.reconstruction;
  return { ...report, files: await output(project, '.mcp-preview', text(args.outputName,'outputName'), files) };
}

export const reviewedImportExtensions: ToolExtension[] = [{
  definition: { name: 'review_tileset_import', description: 'Audit a JSON import review manifest with explicit source inventory, pixel masks, grid evidence and coverage. Dry-run returns review bindings; applying exports a bounded atlas, source reconstructions and comparison contact sheet, without editing game data. See docs/ASSET-REVIEW.md.', inputSchema: { type: 'object', properties: { specPath: { type:'string', minLength:1, maxLength:1024 }, outputName: { type:'string', pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }, dryRun: { type:'boolean' } }, required:['specPath'], additionalProperties:false } },
  mutates: args => args.dryRun === false, run: reviewedImport,
}];

import { resolve } from 'node:path';
import { allowed, readLimited, canvasBudget } from '../utils/security.js';
import { resolveGraphic } from '../utils/tiles.js';
import { loadTilesetRecord } from './tilesetTools.js';
import { AtlasPiece, Shelf, measurePiece, placePiece, prefixHeight, MAX_ATLAS_PIECES, MAX_DECODE_PIXELS } from '../utils/atlasLayout.js';
import { MAX_TABLE_BYTES } from '../utils/tableValidation.js';

type InputPiece = AtlasPiece & { objectId?: string };
type Metadata = { width: number; height: number; pixels: number };
type Prepared = { index: number; objectId: string | null; sourcePath: string; piece: AtlasPiece; meta: Metadata; box: ReturnType<typeof measurePiece> };

/** Read-only planning. Header dimensions are estimates, not full PNG validation. */
export async function planTilesetImport(project: string, args: { baseTilesetId: number; pieces: InputPiece[] }) {
  if (!Array.isArray(args.pieces) || args.pieces.length < 1 || args.pieces.length > 4096) throw new Error('Supply 1..4096 explicit pieces');
  const base = await loadTilesetRecord(project, args.baseTilesetId);
  const metadata = new Map<string, Metadata>();
  let inputBytes = 0;
  async function inspect(path: string) {
    path = allowed(path);
    const cached = metadata.get(path); if (cached) return cached;
    const bytes = await readLimited(path); inputBytes += bytes.length;
    if (inputBytes > 128 * 1024 * 1024) throw new Error('Planning inputs exceed the 128 MiB read budget');
    if (bytes.length < 33 || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii',12,16) !== 'IHDR') throw new Error('Invalid PNG header');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    canvasBudget(width, height);
    const result = { width, height, pixels: width * height }; metadata.set(path,result); return result;
  }
  const rtp = process.env.RPGMAKER_RTP_PATH || 'C:/Program Files (x86)/Steam/steamapps/common/RPGXP/rtp';
  const basePath = resolveGraphic(project,rtp,'Tilesets',base.tileset.tileset_name);
  if (!basePath) throw new Error('Base tileset graphic not found');
  const prefix = await inspect(basePath);
  const reservedHeight = prefixHeight(prefix.width,prefix.height,base.size);
  canvasBudget(256,reservedHeight);
  const groups: Prepared[][] = [];
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const [index,input] of args.pieces.entries()) {
    const objectId = input.objectId;
    if (objectId !== undefined && (typeof objectId !== 'string' || !objectId.trim() || objectId.length > 128)) throw new Error('objectId must be a nonempty string of at most 128 characters');
    if (objectId === undefined || objectId !== previous) {
      if (objectId !== undefined && seen.has(objectId)) throw new Error(`Object '${objectId}' must have contiguous pieces in input order`);
      groups.push([]); if (objectId !== undefined) seen.add(objectId);
    }
    previous = objectId;
    const box = measurePiece(input);
    const sourcePath = allowed(resolve(project,input.sourcePath));
    const meta = await inspect(sourcePath);
    if (input.rect.x + input.rect.width > meta.width || input.rect.y + input.rect.height > meta.height) throw new Error(`Piece ${index}: source rectangle exceeds image bounds`);
    const piece: AtlasPiece = { sourcePath, rect: { ...input.rect }, scale: box.scale, padding: box.padding };
    groups[groups.length - 1].push({index,objectId:objectId ?? null,sourcePath,piece,meta,box});
  }
  type Bank = { shelf: Shelf; decodedPixels: number; contentPixels: number; maxSourcePixels: number; maxCropPixels: number; entries: any[]; composePieces: AtlasPiece[] };
  const empty = (): Bank => ({ shelf: {x:0,y:reservedHeight,shelfHeight:0},decodedPixels:prefix.pixels,contentPixels:0,maxSourcePixels:0,maxCropPixels:0,entries:[],composePieces:[] });
  function append(bank: Bank, group: Prepared[]): Bank {
    const next: Bank = {...bank,shelf:{...bank.shelf},entries:[...bank.entries],composePieces:[...bank.composePieces]};
    if (next.entries.length + group.length > MAX_ATLAS_PIECES) throw new Error('128-piece limit per bank');
    for (const p of group) {
      next.decodedPixels += p.meta.pixels;
      if (next.decodedPixels > MAX_DECODE_PIXELS) throw new Error('32-megapixel decoded-source limit per bank');
      const placement = placePiece(next.shelf,p.box); next.shelf = placement.next;
      const {x,y} = placement;
      next.contentPixels += p.box.width * p.box.height;
      next.maxSourcePixels = Math.max(next.maxSourcePixels,p.meta.pixels);
      next.maxCropPixels = Math.max(next.maxCropPixels,p.piece.rect.width*p.piece.rect.height);
      next.composePieces.push(p.piece);
      next.entries.push({source_index:p.index,object_id:p.objectId,source_path:p.sourcePath,source_rect:p.piece.rect,scale:p.box.scale,padding:p.box.padding,
        output_rect:{x:x+p.box.padding,y:y+p.box.padding,width:p.box.width,height:p.box.height},
        tile_rect:{x,y,width:p.box.slotWidth,height:p.box.slotHeight},
        tile_ids:{first:384+y/4+x/32,last:384+(y+p.box.slotHeight-32)/4+(x+p.box.slotWidth-32)/32,rows:p.box.slotHeight/32,cols:p.box.slotWidth/32,row_stride:8}});
    }
    return next;
  }
  const banks: Bank[] = []; let current = empty();
  for (const group of groups) {
    try { current = append(current,group); }
    catch {
      let fresh: Bank;
      try { fresh = append(empty(),group); }
      catch (e) { throw new Error(`Indivisible object ${group[0].objectId ?? `at piece ${group[0].index}`} cannot fit in a bank: ${(e as Error).message}`); }
      if (current.entries.length) banks.push(current);
      current = fresh;
    }
  }
  if (current.entries.length) banks.push(current);
  if (base.entries.length + banks.length - 1 > 999999) throw new Error('Planned tileset records exceed supported IDs');
  const plans = banks.map((bank,index) => {
    const height = bank.shelf.y + bank.shelf.shelfHeight, outputPixels = 256 * height;
    return {bank_index:index,width:256,height,rows:height/32,table_size:384+height/4,max_tile_id:383+height/4,piece_count:bank.entries.length,
      memory:{output_rgba_bytes:outputPixels*4,decoded_source_pixels:bank.decodedPixels,estimated_working_rgba_bytes:4*(outputPixels+prefix.pixels+bank.contentPixels+bank.maxSourcePixels+bank.maxCropPixels)},
      pieces:bank.entries,compose_pieces:bank.composePieces};
  });
  const existingCells = base.entries.reduce((n,entry) => n + ['passages','priorities','terrain_tags'].reduce((sum,key) => sum + (entry?.[key]?.data?.length ?? 0),0),0);
  const projectedCells = existingCells + plans.reduce((sum,bank) => sum + bank.table_size*3,0);
  const projectedTableBytes = projectedCells * 2 + (base.entries.filter(Boolean).length + plans.length) * 3 * 20;
  if (projectedTableBytes > MAX_TABLE_BYTES) throw new Error('Proposed banks exceed the 32 MiB aggregate Table byte budget');
  return {read_only:true,base_tileset_id:args.baseTilesetId,prefix:{source_path:basePath,original_height:prefix.height,reserved_height:reservedHeight,table_size:base.size},bank_count:plans.length,piece_count:args.pieces.length,projected_property_table_cells:projectedCells,projected_property_table_bytes:projectedTableBytes,banks:plans,
    limits:{image_pixels:16*1024*1024,decoded_source_pixels_per_bank:MAX_DECODE_PIXELS,pieces_per_bank:MAX_ATLAS_PIECES,max_tile_id:32767,transaction_bytes:128*1024*1024},
    notes:['No files, directories, backups or locks are written. PNG headers are inspected; full decode, encoding size and database serialization are validated only when composing.',
      'Memory estimates cover RGBA working buffers, not total process RAM, PNG codec buffers or exact compressed file sizes. Normal file/transaction/input limits still apply.',
      'Clone the original base separately for each bank, then compose using that clone and compose_pieces. Do not chain appended banks. No IDs for new database records are reserved.',
      'Groups are contiguous objectId runs; ungrouped pieces are indivisible individually. Shelf packing is deterministic and preserves input order, not a globally optimal bin packing.']};
}

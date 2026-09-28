import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { allowed, contained, safeMkdir, atomicWriteFile, expectNewProjectFile } from '../utils/security.js';
import { Canvas, decodePng, encodePng, makeCanvas, scaleCanvas, resolveGraphic } from '../utils/tiles.js';
import { writeRxdataFile } from '../utils/rxdata.js';
import { loadTilesetRecord } from './tilesetTools.js';
import { AtlasPiece as Piece, measurePiece, placePiece, prefixHeight, MAX_ATLAS_PIECES, MAX_DECODE_PIXELS } from '../utils/atlasLayout.js';

// Copy bytes, not alpha-composite: preserve RGB even in transparent pixels.
function copy(src: Canvas, dst: Canvas, sx: number, sy: number, w: number, h: number, dx: number, dy: number) {
  for (let row = 0; row < h; row++) {
    const start = ((sy + row) * src.width + sx) * 4;
    dst.data.set(src.data.subarray(start, start + w * 4), ((dy + row) * dst.width + dx) * 4);
  }
}

async function requireMissing(path: string) {
  try { await access(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw new Error('Atlas destination already exists; choose a new outputName');
}

/** Run through the dispatcher or runProjectOperation for all-or-nothing writes. */
export async function composeTilesetAtlas(project: string, args: { outputName: string; appendToTilesetId?: number; pieces: Piece[] }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(args.outputName) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(args.outputName)) throw new Error('outputName must be a safe filename stem (letters, digits, underscore or hyphen)');
  if (!Array.isArray(args.pieces) || args.pieces.length < 1 || args.pieces.length > MAX_ATLAS_PIECES) throw new Error('Supply 1..128 explicit pieces');
  const imageDir = contained(project, join(project, 'Graphics', 'Tilesets'));
  const manifestDir = contained(project, join(project, 'Data', '.mcp-atlas'));
  const outputPath = contained(project, join(imageDir, args.outputName + '.png'));
  const manifestPath = contained(project, join(manifestDir, args.outputName + '.json'));
  await requireMissing(outputPath); await requireMissing(manifestPath);
  await expectNewProjectFile(outputPath); await expectNewProjectFile(manifestPath);
  const record = args.appendToTilesetId === undefined ? undefined : await loadTilesetRecord(project, args.appendToTilesetId);
  let prefix: Canvas | undefined, prefixPath: string | null = null, baseHeight = 0, decodedPixels = 0;
  if (record) {
    const rtp = process.env.RPGMAKER_RTP_PATH || 'C:/Program Files (x86)/Steam/steamapps/common/RPGXP/rtp';
    prefixPath = resolveGraphic(project, rtp, 'Tilesets', record.tileset.tileset_name);
    if (!prefixPath) throw new Error('Existing tileset graphic not found');
    prefix = await decodePng(prefixPath, true);
    baseHeight = prefixHeight(prefix.width, prefix.height, record.size);
    decodedPixels += prefix.width * prefix.height;
  }
  let shelf = { x: 0, y: baseHeight, shelfHeight: 0 };
  const prepared: { image: Canvas; entry: any }[] = [];
  for (const [index, piece] of args.pieces.entries()) {
    const { rect } = piece;
    const box = measurePiece(piece);
    const { width, height, slotWidth, slotHeight, scale, padding } = box;
    const { x, y, next } = placePiece(shelf, box);
    const sourcePath = allowed(resolve(project, piece.sourcePath));
    const source = await decodePng(sourcePath, true);
    decodedPixels += source.width * source.height;
    if (decodedPixels > MAX_DECODE_PIXELS) throw new Error('Sources exceed the 32 megapixel aggregate decode budget');
    if (rect.x + rect.width > source.width || rect.y + rect.height > source.height) throw new Error('Source rectangle exceeds image bounds');
    const crop = makeCanvas(rect.width, rect.height, true);
    copy(source, crop, rect.x, rect.y, rect.width, rect.height, 0, 0);
    const image = scaleCanvas(crop, scale);
    const tileIds = Array.from({ length: slotHeight / 32 }, (_, row) => Array.from({ length: slotWidth / 32 }, (_, col) => 384 + (y / 32 + row) * 8 + x / 32 + col));
    prepared.push({ image, entry: { index, source_path: sourcePath, source_rect: rect, scale, padding, output_rect: { x: x + padding, y: y + padding, width, height }, tile_rect: { x, y, width: slotWidth, height: slotHeight }, tile_ids: tileIds } });
    shelf = next;
  }
  const atlas = makeCanvas(256, shelf.y + shelf.shelfHeight, true);
  if (prefix) copy(prefix, atlas, 0, 0, prefix.width, prefix.height, 0, 0);
  for (const { image, entry } of prepared) copy(image, atlas, 0, 0, image.width, image.height, entry.output_rect.x, entry.output_rect.y);
  const tableSize = 384 + atlas.height / 4;
  const manifest = { schema_version: 1, width: 256, height: atlas.height, image_path: outputPath, tileset_id: args.appendToTilesetId ?? null, prefix: { source_path: prefixPath, original_height: prefix?.height ?? 0, reserved_height: baseHeight }, pieces: prepared.map(p => p.entry), note: 'IDs include transparent tile padding. New flags are zero placeholders; review passability, priority and terrain explicitly.' };
  await safeMkdir(imageDir); await safeMkdir(manifestDir);
  await atomicWriteFile(outputPath, encodePng(atlas, true));
  await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
  if (record) {
    record.tileset.tileset_name = args.outputName;
    for (const field of ['passages', 'priorities', 'terrain_tags']) {
      record.tileset[field].data.push(...Array(tableSize - record.size).fill(0));
      record.tileset[field].xsize = tableSize;
    }
    await writeRxdataFile(record.path, record.entries);
  }
  return { path: outputPath, manifest: manifestPath, width: atlas.width, height: atlas.height, tableSize, tilesetId: args.appendToTilesetId ?? null, pieces: manifest.pieces, note: manifest.note };
}

import { readRxdataFile, writeRxdataFile, getDataPath, getMapPath } from '../utils/fileHandler.js';
import { assertId } from '../utils/security.js';
import { decodePng, resolveGraphic } from '../utils/tiles.js';
import { touchMagicNumber } from './systemTools.js';
import type { GameMap } from '../utils/types.js';

const fields = ['passages', 'priorities', 'terrain_tags'] as const;
async function load(project: string, id: number) {
  assertId(id);
  const path = getDataPath(project, 'Tilesets.rxdata');
  const entries = await readRxdataFile<any[]>(path);
  const tileset = entries?.[id];
  if (!Array.isArray(entries) || !tileset || tileset._class !== 'RPG::Tileset') throw new Error('Tileset not found');
  const size = tileset.passages?.xsize;
  if (!Number.isInteger(size) || size < 384 || size > 32768) throw new Error('Invalid tileset table size');
  for (const field of fields) {
    const table = tileset[field];
    if (table?._class !== 'Table' || table.dim !== 1 || table.xsize !== size || table.ysize !== 1 || table.zsize !== 1 || !Array.isArray(table.data) || table.data.length !== size) {
      throw new Error('Tileset property tables must have matching one-dimensional sizes');
    }
  }
  return { path, entries, tileset, size };
}

/** Cloning never changes the source or assigns the clone to a map. */
export async function cloneTileset(project: string, sourceTilesetId: number, options: { name?: string; graphicName?: string }) {
  const { path, entries, tileset, size } = await load(project, sourceTilesetId);
  const clone = structuredClone(tileset);
  const id = entries.length;
  assertId(id);
  clone.id = id;
  clone.name = options.name ?? `${tileset.name} copy`;
  if (options.graphicName !== undefined) {
    if (!options.graphicName.trim()) throw new Error('Graphic name cannot be empty');
    const rtp = process.env.RPGMAKER_RTP_PATH || 'C:/Program Files (x86)/Steam/steamapps/common/RPGXP/rtp';
    const graphic = resolveGraphic(project, rtp, 'Tilesets', options.graphicName);
    if (!graphic) throw new Error('Replacement tileset graphic not found');
    const image = await decodePng(graphic);
    if (image.width !== 256 || image.height % 32 !== 0) throw new Error('Tileset PNG must be 256 pixels wide with a height divisible by 32');
    const newSize = 384 + image.height / 4;
    if (newSize < size || newSize > 32768) throw new Error('Replacement graphic cannot shrink property tables or exceed tile ID limits');
    clone.tileset_name = options.graphicName.replace(/\.png$/i, '');
    for (const field of fields) {
      clone[field].xsize = newSize;
      clone[field].data.push(...Array(newSize - size).fill(0));
    }
  }
  entries.push(clone);
  await writeRxdataFile(path, entries);
  return { id, sourceTilesetId, name: clone.name, graphicName: clone.tileset_name, tableSize: clone.passages.xsize };
}

export async function updateTileProperties(project: string, tilesetId: number, options: {
  tileIds?: number[]; ranges?: { start: number; end: number }[];
  passage?: number; priority?: number; terrainTag?: number;
}) {
  const { path, entries, tileset, size } = await load(project, tilesetId);
  const changes = [['passages', options.passage, 255], ['priorities', options.priority, 5], ['terrain_tags', options.terrainTag, 32767]] as const;
  if (changes.every(([, value]) => value === undefined)) throw new Error('At least one tile property is required');
  for (const [, value, max] of changes) if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > max)) throw new Error('Tile property outside supported range');
  const valid = (id: number) => {
    if (!Number.isInteger(id) || id < 0 || id >= size) throw new Error('Tile ID outside tileset table');
  };
  if ((options.tileIds?.length ?? 0) > 32768 || (options.ranges?.length ?? 0) > 1024) throw new Error('Too many tile selections');
  const selected = new Set<number>();
  for (const id of options.tileIds ?? []) { valid(id); selected.add(id); }
  let work = 0;
  for (const { start, end } of options.ranges ?? []) {
    valid(start); valid(end);
    if (end < start || (work += end - start + 1) > 1000000) throw new Error('Invalid or excessive tile ranges');
    for (let id = start; id <= end; id++) selected.add(id);
  }
  if (!selected.size) throw new Error('Select at least one tile ID or inclusive range');
  for (const id of selected) for (const [field, value] of changes) if (value !== undefined) tileset[field].data[id] = value;
  await writeRxdataFile(path, entries);
  return { tilesetId, updatedTiles: selected.size };
}

export async function setMapTileset(project: string, mapId: number, tilesetId: number) {
  const { size } = await load(project, tilesetId);
  const path = getMapPath(project, mapId);
  const map = await readRxdataFile<GameMap>(path);
  const valid = (id: number) => Number.isInteger(id) && id >= 0 && id < size;
  if (!map.data?.data?.every(valid)) throw new Error('Map contains tile IDs outside the target tileset');
  for (const event of Object.values(map.events ?? {})) for (const page of event.pages ?? []) {
    if (!valid(page.graphic.tile_id)) throw new Error('Event graphic contains a tile ID outside the target tileset');
  }
  const previousTilesetId = map.tileset_id;
  map.tileset_id = tilesetId;
  // Do not normalize event commands: only the tileset reference changes.
  await writeRxdataFile(path, map);
  await touchMagicNumber(project);
  return { mapId, previousTilesetId, tilesetId };
}

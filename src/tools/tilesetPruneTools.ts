import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { allowed, contained, assertId, readLimited, beforeProjectCommit } from '../utils/security.js';
import { readRxdataFile, writeRxdataFile, toPlain } from '../utils/rxdata.js';
import { getDataPath } from '../utils/fileHandler.js';
import { load } from '../vendor/marshal/index.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Only tail truncation: never renumber records, remove graphics, or edit maps. */
export async function truncateUnusedTilesets(project: string, fromId: number, dryRun = true) {
  assertId(fromId);
  const databasePath = getDataPath(project,'Tilesets.rxdata');
  const entries = await readRxdataFile<any[]>(databasePath);
  if (!Array.isArray(entries) || entries[0] !== null || fromId > entries.length) throw new Error('fromId must be within the tileset array or exactly its current length');
  for (let i = 1; i < entries.length; i++) if (entries[i] !== null && (entries[i]?._class !== 'RPG::Tileset' || entries[i]?.id !== i)) throw new Error(`Invalid tileset record at index ${i}; refusing truncation`);
  const dataDir = contained(project,join(project,'Data'));
  const inventory = async () => (await readdir(allowed(dataDir))).filter(name => /^Map\d+\.rxdata$/i.test(name)).sort();
  const files = await inventory();
  if (files.length > 10000) throw new Error('Map inventory exceeds the 10000-map scan limit');
  const hashes = new Map<string,string>(); let readBytes = 0;
  async function read(path: string) {
    const bytes = await readLimited(path); readBytes += bytes.length;
    if (readBytes > 128 * 1024 * 1024) throw new Error('Map reference scan exceeds the 128 MiB read budget');
    hashes.set(path,hash(bytes));
    return toPlain(load(bytes,{string:'utf8',hash:'map'}));
  }
  const infosPath = getDataPath(project,'MapInfos.rxdata');
  const infos = await read(infosPath);
  if (!infos || typeof infos !== 'object' || Array.isArray(infos)) throw new Error('Invalid MapInfos; cannot establish a complete map inventory');
  const lowerFiles = new Set(files.map(name=>name.toLowerCase()));
  for (const key of Object.keys(infos)) {
    const id = Number(key); assertId(id);
    if (!lowerFiles.has(`Map${String(id).padStart(3,'0')}.rxdata`.toLowerCase())) throw new Error(`MapInfos references missing map ${id}; refusing truncation`);
  }
  const references: {mapId:number;file:string;tilesetId:number}[] = [];
  const seen = new Set<number>();
  for (const file of files) {
    const mapId = Number(file.match(/^Map(\d+)\./i)![1]); assertId(mapId);
    if (seen.has(mapId)) throw new Error(`Duplicate map ID ${mapId} in file inventory`);
    seen.add(mapId);
    const map = await read(contained(project,join(dataDir,file)));
    if (map?._class !== 'RPG::Map' || !Number.isInteger(map.tileset_id) || map.tileset_id < 1 || !entries[map.tileset_id]) throw new Error(`Map ${mapId} has an invalid tileset reference; refusing truncation`);
    if (map.tileset_id >= fromId) references.push({mapId,file,tilesetId:map.tileset_id});
  }
  const result = {dryRun,canTruncate:references.length===0,fromId,previousLength:entries.length,newLength:fromId,removedSlots:entries.length-fromId,
    removed:entries.slice(fromId).map((entry,i)=>({id:fromId+i,name:entry?.name ?? null})),mapsScanned:files.length,references,
    note:'Checks stored tileset_id in every Map*.rxdata, including maps absent from MapInfos. Does not analyze scripts or runtime-generated references; no assets or maps are deleted.'};
  if (dryRun) return result;
  if (references.length) throw new Error(`Tileset suffix is referenced by maps: ${references.map(r=>`${r.mapId}->${r.tilesetId}`).join(', ')}`);
  if (fromId === entries.length) return result;
  beforeProjectCommit(async()=>{
    if (JSON.stringify(await inventory()) !== JSON.stringify(files)) throw new Error('Map inventory changed during tileset truncation; retry after closing the editor');
    for (const [path,expected] of hashes) if (hash(await readLimited(path)) !== expected) throw new Error('Map reference data changed during tileset truncation; retry after closing the editor');
  });
  await writeRxdataFile(databasePath,entries.slice(0,fromId));
  return result;
}

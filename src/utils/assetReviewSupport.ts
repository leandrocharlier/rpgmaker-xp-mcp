import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { access } from 'node:fs/promises';
import { allowed, contained, readLimited, safeMkdir, atomicWriteFile, checkValue, expectNewProjectFile } from './security.js';
import { Canvas, decodePng, encodePng } from './tiles.js';

export const ASSET_PIXELS = 8 * 1024 * 1024;
export const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export function integer(value: unknown, name: string, min = 0, max = 65536): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Invalid ${name}: expected integer ${min}..${max}`);
  return value as number;
}
export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new Error(`Invalid ${name}`);
  return value;
}
export async function readSpec(project: string, path: string): Promise<any> {
  const bytes = await readLimited(allowed(resolve(project, text(path, 'specPath'))));
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Asset specification exceeds 2 MiB');
  const spec = JSON.parse(bytes.toString('utf8')); checkValue(spec); return spec;
}
export async function asset(project: string, path: string, budget: { pixels: number }) {
  const full = allowed(resolve(project, text(path, 'sourcePath'))), bytes = await readLimited(full);
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid PNG');
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  budget.pixels += w * h;
  if (!w || !h || budget.pixels > ASSET_PIXELS) throw new Error('Asset review aggregate source budget exceeds 8 megapixels');
  const image = await decodePng(full);
  // Ensure evidence describes exactly the bytes decoded, even under external edits.
  if (hash(await readLimited(full)) !== hash(bytes)) throw new Error('Source changed during decode');
  return { image, sha256: hash(bytes), path: full };
}
export type Rect = { x: number; y: number; width: number; height: number };
export function rect(value: any, width: number, height: number): Rect {
  if (!value) throw new Error('Missing rectangle');
  const r = { x: integer(value.x, 'x'), y: integer(value.y, 'y'), width: integer(value.width, 'width', 1), height: integer(value.height, 'height', 1) };
  if (r.x + r.width > width || r.y + r.height > height) throw new Error('Rectangle outside source bounds');
  return r;
}
export function pixel(src: Canvas, dst: Canvas, sx: number, sy: number, dx: number, dy: number) {
  const s = (sy * src.width + sx) * 4, d = (dy * dst.width + dx) * 4;
  dst.data.set(src.data.subarray(s, s + 4), d);
}
export async function output(project: string, directory: string, name: string, files: Record<string, Canvas | object | string>) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)) throw new Error('Invalid outputName');
  const dir = contained(project, join(project, 'Data', directory, name));
  try { await access(dir); throw new Error('Output already exists; choose a fresh outputName'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  for(const key of Object.keys(files)) await expectNewProjectFile(contained(dir,join(dir,key)));
  await safeMkdir(dir);
  const paths: Record<string, string> = {};
  for (const [key, value] of Object.entries(files)) {
    const path = contained(dir, join(dir, key)); paths[key] = path;
    await atomicWriteFile(path, key.endsWith('.png') ? encodePng(value as Canvas) : typeof value==='string' ? value : JSON.stringify(value, null, 2));
  }
  return paths;
}

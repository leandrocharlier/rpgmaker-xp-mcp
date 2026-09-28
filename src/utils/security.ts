import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, realpathSync } from 'node:fs';
import { open, rename, unlink, mkdir, copyFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, join, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Transform } from 'node:stream';

export const MAX_FILE = 64 * 1024 * 1024;
const MAX_TRANSACTION = 128 * 1024 * 1024;
type State = { project: string; rtp?: string; observed: Map<string, string>; writes: Map<string, Buffer> };
const scope = new AsyncLocalStorage<State>();
let queue: Promise<unknown> = Promise.resolve();
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

export function assertId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1 || id > 999999) throw new Error('ID must be a positive integer (maximum 999999)');
}

// Reject links/junctions in every existing component, including the destination.
// This is defense in depth, not a sandbox against a hostile local OS user racing us.
export function contained(root: string, target: string): string {
  root = resolve(root); target = resolve(target);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Path outside authorized directory');
  if (process.platform === 'win32' && rel.includes(':')) throw new Error('Alternate data streams are forbidden');
  const parts = rel ? rel.split(/[\\/]/) : [];
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part);
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) throw new Error('Linked paths are forbidden');
      const actual = realpathSync(current);
      const physicalRoot = realpathSync(root);
      const physicalRel = relative(physicalRoot, actual);
      if (physicalRel === '..' || physicalRel.startsWith('..\\') || physicalRel.startsWith('../') || isAbsolute(physicalRel)) throw new Error('Path escapes authorized directory');
    } catch (e) { if (!missing(e)) throw e; }
  }
  return target;
}

export function allowed(path: string, write = false): string {
  const state = scope.getStore();
  if (!state) return resolve(path); // Standalone library users supply their own trust boundary.
  try { return contained(state.project, path); }
  catch (e) {
    if (!write && state.rtp) return contained(state.rtp, path);
    throw e;
  }
}

export function exportPath(project: string, directory: string, candidate: string): string {
  const base = contained(project, join(project, 'Data', directory));
  return contained(base, candidate);
}

export function previewDirectory(): string {
  const state = scope.getStore();
  if (!state) throw new Error('A project context is required for this export');
  return contained(state.project, join(state.project, 'Data', '.mcp-preview'));
}

export async function readLimited(path: string): Promise<Buffer> {
  path = allowed(path);
  const state = scope.getStore();
  if (state?.writes.has(path)) return state.writes.get(path)!;
  const handle = await open(path, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_FILE) throw new Error('File exceeds the 64 MiB limit or is not a regular file');
    // Bounded read even if another process grows the file after stat().
    const chunks: Buffer[] = []; let total = 0;
    while (true) {
      const b = Buffer.alloc(Math.min(64 * 1024, MAX_FILE + 1 - total));
      const { bytesRead } = await handle.read(b);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_FILE) throw new Error('File exceeds the 64 MiB limit');
      chunks.push(b.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks);
    if (state && !state.observed.has(path)) state.observed.set(path, digest(bytes));
    return bytes;
  } finally { await handle.close(); }
}

export async function safeMkdir(path: string, _opts?: unknown): Promise<void> {
  allowed(path, true);
  await mkdir(path, { recursive: true });
  allowed(path, true);
}

async function replace(path: string, bytes: Buffer): Promise<void> {
  allowed(path, true);
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    allowed(path, true);
    await rename(temp, path);
  } finally {
    await handle.close().catch(() => {});
    await unlink(temp).catch(e => { if (!missing(e)) throw e; });
  }
}

export async function versionedBackup(path: string): Promise<void> {
  path = allowed(path, true);
  try { await readLimited(path); } catch (e) { if (missing(e)) return; throw e; }
  const dir = contained(dirname(path), join(dirname(path), '.mcp-backup'));
  await safeMkdir(dir);
  const dest = join(dir, `${basename(path)}.${Date.now()}-${randomUUID()}.bak`);
  await copyFile(path, dest, 1); // COPYFILE_EXCL: never replace an earlier recovery point.
}

export async function atomicWriteFile(path: string, data: string | Uint8Array, encoding: BufferEncoding = 'utf8'): Promise<void> {
  path = allowed(path, true);
  const bytes = typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data);
  if (bytes.length > MAX_FILE) throw new Error('Output exceeds the 64 MiB limit');
  const state = scope.getStore();
  if (state) {
    let total = bytes.length;
    for (const [p, b] of state.writes) if (p !== path) total += b.length;
    if (total > MAX_TRANSACTION) throw new Error('Operation exceeds the 128 MiB write budget');
    state.writes.set(path, bytes);
  } else {
    await versionedBackup(path);
    await replace(path, bytes);
  }
}

async function commit(state: State): Promise<void> {
  const originals = new Map<string, Buffer | null>();
  let originalBytes = 0;
  for (const path of [...state.writes.keys()]) {
    allowed(path, true);
    let old: Buffer | null = null;
    try {
      const staged = state.writes.get(path)!;
      state.writes.delete(path);
      try { old = await readLimited(path); } finally { state.writes.set(path, staged); }
    } catch (e) { if (!missing(e)) throw e; }
    const observed = state.observed.get(path);
    if (observed && (old === null || digest(old) !== observed)) throw new Error('File changed outside this operation; retry after closing the editor');
    originals.set(path, old);
    originalBytes += old?.length ?? 0;
    if (originalBytes > MAX_TRANSACTION) throw new Error('Recovery data exceeds the 128 MiB budget');
    if (old) await versionedBackup(path);
  }
  const written: string[] = [];
  try {
    for (const [path, bytes] of state.writes) { await replace(path, bytes); written.push(path); }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const path of written.reverse()) {
      try { const old = originals.get(path); if (old) await replace(path, old); else await unlink(path); }
      catch { rollbackErrors.push(path); }
    }
    if (rollbackErrors.length) throw new Error(`Write and rollback failed; restore versioned backups for: ${rollbackErrors.join(', ')}`);
    throw error;
  }
}

export function runProjectOperation<T>(project: string, rtp: string | undefined, mutates: boolean, fn: () => Promise<T>): Promise<T> {
  const task = queue.then(() => scope.run({ project: resolve(project), rtp, observed: new Map(), writes: new Map() }, async () => {
    const lock = contained(project, join(project, 'Data', '.mcp-write.lock'));
    let handle;
    try {
      if (mutates) {
        try { handle = await open(lock, 'wx'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Project is locked by another MCP operation; a stale lock requires manual recovery'); throw e; }
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
      }
      const result = await fn();
      await commit(scope.getStore()!);
      return result;
    } finally { if (handle) { await handle.close(); await unlink(lock); } }
  }));
  queue = task.catch(() => {});
  return task;
}

export function checkValue(value: unknown, depth = 0, budget = { nodes: 0, text: 0 }): void {
  if (depth > 64 || ++budget.nodes > 1000000) throw new Error('Input structure exceeds safety limits');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Numbers must be finite');
  if (typeof value === 'string' && value.length > 4 * 1024 * 1024) throw new Error('String exceeds safety limit');
  if (typeof value === 'string') {
    budget.text += value.length;
    if (budget.text > 16 * 1024 * 1024) throw new Error('Aggregate text exceeds safety limits');
  }
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe property name');
    budget.text += key.length;
    if (budget.text > 16 * 1024 * 1024) throw new Error('Aggregate text exceeds safety limits');
    checkValue(child, depth + 1, budget);
  }
}

export function canvasBudget(w: number, h: number): void {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1 || w * h > 16 * 1024 * 1024) throw new Error('Image exceeds the 16 megapixel limit or has invalid dimensions');
}

/** Bound JSON-RPC lines before the SDK buffers and parses them. */
export function boundedStdioInput(limit = 8 * 1024 * 1024): Transform {
  let length = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(10, start);
        length += (end === -1 ? chunk.length : end) - start;
        if (length > limit) { callback(new Error('MCP input line exceeds safety limits')); return; }
        if (end === -1) break;
        length = 0; start = end + 1;
      }
      callback(null, chunk);
    },
  });
}

export function hardenSchema(schema: any, key = ''): void {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'number' || schema.type === 'integer') {
    schema.minimum ??= -1000000; schema.maximum ??= 1000000;
    if (/Id$/.test(key) || key === 'id') {
      schema.type = 'integer'; schema.maximum = 999999;
      schema.minimum = ['parentId', 'elementId', 'tileId'].includes(key) ? 0 : 1;
    }
    if (['x', 'y', 'index', 'position', 'pageIndex', 'commandIndex'].includes(key)) {
      schema.type = 'integer'; schema.minimum = 0;
    }
    if (['w', 'h', 'width', 'height', 'radius'].includes(key)) {
      schema.type = 'integer'; schema.minimum = 1; schema.maximum = 500;
    }
    if (key === 'scale') { schema.type = 'integer'; schema.minimum = 1; schema.maximum = 8; }
  }
  if (schema.type === 'array') schema.maxItems ??= 100000;
  if (schema.type === 'string') schema.maxLength ??= 4 * 1024 * 1024;
  for (const [name, prop] of Object.entries(schema.properties ?? {})) hardenSchema(prop, name);
  if (schema.items) hardenSchema(schema.items);
}

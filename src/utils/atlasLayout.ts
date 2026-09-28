import { canvasBudget, tallTilesetsEnabled } from './security.js';

export const MAX_ATLAS_PIECES = 128;
export const MAX_DECODE_PIXELS = 32 * 1024 * 1024;
export interface AtlasPiece {
  sourcePath: string;
  rect: { x: number; y: number; width: number; height: number };
  scale?: number;
  padding?: number;
}
export interface Shelf { x: number; y: number; shelfHeight: number }

export function measurePiece(piece: AtlasPiece) {
  const { rect } = piece;
  const scale = piece.scale ?? 1, padding = piece.padding ?? 0;
  const maxHeight = tallTilesetsEnabled() ? 129536 : 500;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height, scale, padding].every(Number.isSafeInteger) || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.width > 500 || rect.height < 1 || rect.height > maxHeight || scale < 1 || scale > 8 || padding < 0 || padding > 32) throw new Error('Invalid rectangle, scale or padding');
  const width = rect.width * scale, height = rect.height * scale;
  const slotWidth = Math.ceil((width + padding * 2) / 32) * 32;
  const slotHeight = Math.ceil((height + padding * 2) / 32) * 32;
  if (slotWidth > 256) throw new Error('Scaled piece plus padding exceeds the 256px atlas width');
  return { width, height, slotWidth, slotHeight, scale, padding };
}

export function prefixHeight(width: number, height: number, tableSize: number) {
  if (width !== 256 || height % 32 !== 0) throw new Error('Existing tileset must be 256px wide and a multiple of 32px tall');
  return Math.max(height, Math.ceil((tableSize - 384) / 8) * 32);
}

export function placePiece(shelf: Shelf, box: ReturnType<typeof measurePiece>) {
  let { x, y, shelfHeight } = shelf;
  if (x + box.slotWidth > 256) { x = 0; y += shelfHeight; shelfHeight = 0; }
  const height = y + Math.max(shelfHeight, box.slotHeight);
  canvasBudget(256, height, true);
  if (384 + height / 4 > 32768) throw new Error('Atlas exceeds RGSS signed tile ID range');
  return { x, y, height, next: { x: x + box.slotWidth, y, shelfHeight: Math.max(shelfHeight, box.slotHeight) } };
}

// RGSS Table cells are packed signed 16-bit values, not arbitrary object nodes.
// Count every occurrence (including shared references) against a separate budget.
export const MAX_TABLE_ITEMS = 1000000;
export const MAX_TABLE_BYTES = 32 * 1024 * 1024;

export function tableShape(table: { dim: number; xsize: number; ysize: number; zsize: number }) {
  const { dim, xsize, ysize, zsize } = table;
  if (!Number.isInteger(dim) || dim < 1 || dim > 3 ||
      ![xsize, ysize, zsize].every(n => Number.isSafeInteger(n) && n >= 0 && n <= MAX_TABLE_ITEMS) ||
      (dim === 1 && (ysize !== 1 || zsize !== 1)) || (dim === 2 && zsize !== 1)) throw new Error('Invalid Table dimensions');
  const items = xsize * ysize * zsize;
  if (!Number.isSafeInteger(items) || items > MAX_TABLE_ITEMS) throw new Error('Invalid or oversized Table');
  return items;
}

export function validatePlainTable(table: any) {
  const items = tableShape(table);
  if (!Array.isArray(table.data) || table.data.length !== items) throw new Error('Table data length does not match dimensions');
  for (let i = 0; i < items; i++) {
    const value = table.data[i];
    if (!Number.isInteger(value) || value < -32768 || value > 32767) throw new Error('Table cells must be signed 16-bit integers');
  }
  return items;
}

export function chargeTable(items: number, budget: { tableBytes?: number }) {
  budget.tableBytes = (budget.tableBytes ?? 0) + 20 + items * 2;
  if (budget.tableBytes > MAX_TABLE_BYTES) throw new Error('Expanded Table data exceeds the 32 MiB compact-byte safety limit');
}

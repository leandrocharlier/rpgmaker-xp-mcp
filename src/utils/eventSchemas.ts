import { makeEventPage } from './types.js';

// Describe complete RGSS pages using the same constructors as the writer.
// Empty parameter arrays deliberately accept heterogeneous command parameters.
function schemaFor(value: any, key = ''): any {
  if (Array.isArray(value)) return { type: 'array', items: value.length ? schemaFor(value[0]) : {} };
  if (value !== null && typeof value === 'object') return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, schemaFor(v, k)])),
    required: Object.keys(value),
  };
  if (typeof value === 'number') return { type: 'integer' };
  return { type: typeof value, ...(key === '_class' ? { enum: [value] } : {}) };
}

export const eventPageSchema = schemaFor(makeEventPage());

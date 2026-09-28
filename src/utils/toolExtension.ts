import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** Explicit mutation policy and schema for tools with conditional writes. */
export interface ToolExtension {
  definition: Tool;
  mutates: (args: any) => boolean;
  run: (project: string, args: any) => Promise<unknown>;
}

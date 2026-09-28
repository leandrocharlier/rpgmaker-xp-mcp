import type { ToolExtension } from '../utils/toolExtension.js';

export const extensions: ToolExtension[] = [];
export const extensionByName = new Map(extensions.map(tool => [tool.definition.name, tool]));
if (extensionByName.size !== extensions.length) throw new Error('Duplicate extension tool name');

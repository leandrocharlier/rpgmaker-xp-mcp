import type { ToolExtension } from '../utils/toolExtension.js';
import { tilesetTransformExtensions } from './tilesetTransformTools.js';

export const extensions: ToolExtension[] = [...tilesetTransformExtensions];
export const extensionByName = new Map(extensions.map(tool => [tool.definition.name, tool]));
if (extensionByName.size !== extensions.length) throw new Error('Duplicate extension tool name');

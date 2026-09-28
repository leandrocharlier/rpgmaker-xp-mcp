import type { ToolExtension } from '../utils/toolExtension.js';
import { tilesetTransformExtensions } from './tilesetTransformTools.js';
import { movementAuditExtensions } from './movementAuditTools.js';
import { buildingAnchorExtensions } from './buildingAnchorTools.js';

export const extensions: ToolExtension[] = [...tilesetTransformExtensions, ...movementAuditExtensions, ...buildingAnchorExtensions];
export const extensionByName = new Map(extensions.map(tool => [tool.definition.name, tool]));
if (extensionByName.size !== extensions.length) throw new Error('Duplicate extension tool name');

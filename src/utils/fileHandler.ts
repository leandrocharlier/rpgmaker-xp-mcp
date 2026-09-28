import { access, readdir } from 'fs/promises';
import { join, extname } from 'path';

export { readRxdataFile, writeRxdataFile } from './rxdata.js';

import { contained, assertId, versionedBackup } from './security.js';
export const backupBeforeWrite = versionedBackup;

/**
 * List all files in a directory with a specific extension
 */
export async function listFiles(dirPath: string, extension: string): Promise<string[]> {
  try {
    const files = await readdir(dirPath);
    return files.filter(file => extname(file) === extension);
  } catch (error) {
    throw new Error(`Failed to list files in ${dirPath}: ${error}`);
  }
}

/**
 * Get the full path to a data file in an RPG Maker XP project
 */
export function getDataPath(projectPath: string, fileName: string): string {
  if (!/^[A-Za-z0-9_-]+\.rxdata$/.test(fileName)) throw new Error('Invalid data filename');
  return contained(projectPath, join(projectPath, 'Data', fileName));
}

/**
 * Get the full path to a map file in an RPG Maker XP project
 */
export function getMapPath(projectPath: string, mapId: number): string {
  assertId(mapId);
  const fileName = `Map${String(mapId).padStart(3, '0')}.rxdata`;
  return getDataPath(projectPath, fileName);
}

/**
 * Get the full path to the project's Game.ini (holds the game title)
 */
export function getGameIniPath(projectPath: string): string {
  return contained(projectPath, join(projectPath, 'Game.ini'));
}

/**
 * Validate RPG Maker XP project path.
 * Requires a Data directory containing System.rxdata; Game.rxproj is not
 * required so the server also works on bare Data folders.
 */
export async function validateProjectPath(projectPath: string): Promise<boolean> {
  try {
    await access(getDataPath(projectPath, 'System.rxdata'));
    return true;
  } catch {
    return false;
  }
}

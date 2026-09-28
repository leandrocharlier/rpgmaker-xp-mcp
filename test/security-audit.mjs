// Security regressions: all mutations target generated scratch data only.
// Usage: node test/security-audit.mjs <existing output directory>
import { mkdtemp, mkdir, writeFile, readFile, access, unlink, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeRxdataFile, readRxdataFile } from '../dist/utils/rxdata.js';
import { makeMap, makeTable } from '../dist/utils/types.js';
import { PNG } from 'pngjs';
import { Script } from 'node:vm';
import { Worker } from 'node:worker_threads';
import { deflateSync } from 'node:zlib';
import { writeRxdataRaw } from '../dist/utils/rxdata.js';

if (!process.argv[2]) throw new Error('An output directory is required');
const root = await mkdtemp(join(resolve(process.argv[2]), 'mcp-security-'));
const project = join(root, 'project');
await mkdir(join(project, 'Data'), { recursive: true });
await mkdir(join(project, 'Graphics', 'Tilesets'), { recursive: true });
await writeRxdataFile(join(project, 'Data', 'System.rxdata'), {
  _class: 'RPG::System', magic_number: 1, variables: [null, 'one'], switches: [null, 'one'],
});
await writeRxdataFile(join(project, 'Data', 'Map001.rxdata'), makeMap(2, 2));
await writeRxdataFile(join(project, 'Data', 'Map002.rxdata'), makeMap(2, 2));
const htmlMarker = '<img src="missing-audit-image" onerror="document.title=\'AUDIT_MARKER\'">';
await writeRxdataFile(join(project, 'Data', 'Tilesets.rxdata'), [null, {
  _class: 'RPG::Tileset', id: 1, name: htmlMarker, tileset_name: 'audit', autotile_names: [],
  passages: makeTable(392, 1, 1), priorities: makeTable(392, 1, 1), terrain_tags: makeTable(392, 1, 1),
}]);
const png = new PNG({ width: 256, height: 32 });
png.data.fill(255);
await writeFile(join(project, 'Graphics', 'Tilesets', 'audit.png'), PNG.sync.write(png));
await writeFile(join(project, 'Game.ini'), '[Game]\r\nTitle=Audit\r\nLibrary=original.dll\r\n');
await writeRxdataFile(join(root, 'outside.rxdata'), makeMap(3, 2));
const target = join(root, 'outside-existing.txt');
await writeFile(target, 'DO NOT OVERWRITE');
const server = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const client = new Client({ name: 'security-audit', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [server], stderr: 'pipe',
  env: { ...process.env, RPGMAKER_PROJECT_PATH: project, RPGMAKER_RTP_PATH: join(root, 'no-rtp') },
});
const results = [];
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { response, text, value: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
function record(name, confirmed, evidence) { results.push({ name, confirmed, evidence }); }
try {
  await client.connect(transport);
  const tools = await client.listTools();
  record('tool_count', true, tools.tools.length);
  const traversal = '/../../../outside';
  const escaped = await call('get_map', { mapId: traversal });
  record('map_path_traversal_read', escaped.value?.data?.xsize === 3, escaped.text);
  const escapedWrite = await call('create_map_event', { mapId: traversal, name: 'outside-marker', x: 0, y: 0 });
  const outside = await readRxdataFile(join(root, 'outside.rxdata'));
  record('map_path_traversal_write', Object.values(outside.events).some(e => e.name === 'outside-marker'), escapedWrite.text);
  const render = await call('render_map', { mapId: 1, outPath: target });
  const bytes = await readFile(target);
  record('preview_overwrites_external_file', bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), render.text);
  await writeFile(join(project, '.mcp-backup'), 'blocks backup directory creation');
  const first = await call('update_game_title', { title: 'first-attempt' });
  const second = await call('update_game_title', { title: 'second-attempt' });
  let backupExists = true;
  try { await access(join(project, '.mcp-backup', 'Game.ini.bak')); } catch { backupExists = false; }
  record('backup_failure_then_unprotected_write', first.text.startsWith('Error:') && (await readFile(join(project, 'Game.ini'), 'utf8')).includes('second-attempt') && !backupExists, { first, second, backupExists });
  record('error_response_missing_isError', first.text.startsWith('Error:') && first.response.isError !== true, first.response);
  await unlink(join(project, '.mcp-backup'));
  await call('update_game_title', { title: 'Audit\r\nInjectedKey=marker' });
  record('title_ini_line_injection', (await readFile(join(project, 'Game.ini'), 'utf8')).includes('\nInjectedKey=marker'), 'An extra INI key was persisted');
  const parallel = await Promise.all(Array.from({ length: 6 }, (_, i) => call('create_map_event', { mapId: 2, name: `parallel-${i}`, x: 0, y: 0 })));
  let persisted;
  try { persisted = Object.values((await readRxdataFile(join(project, 'Data', 'Map002.rxdata'))).events).map(e => e.name); }
  catch (error) { persisted = { parseError: error.message }; }
  record('concurrent_event_loss', !Array.isArray(persisted) || persisted.length < 6, { responses: parallel.map(p => p.text), persisted });
  const harness = await call('create_tileset_identification_harness', { tilesetId: 1, scale: 2, outDir: join(project, 'Data', '.mcp-tilecatalog', 'audit') });
  const html = await readFile(join(project, 'Data', '.mcp-tilecatalog', 'audit', 'index.html'), 'utf8');
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  if (harness.response.isError) throw new Error(harness.text);
  record('unescaped_html_in_preview', html.includes(htmlMarker), { rawMarkerPresent: html.includes(htmlMarker), result: harness.text, note: 'Generated HTML inspected; payload not opened/executed' });
  const title = await call('update_game_title', { title: 'Safe $& title' });
  if (title.response.isError || !(await readFile(join(project, 'Game.ini'), 'utf8')).includes('Title=Safe $& title')) throw new Error('Literal title regression');
  const preview = await call('render_map', { mapId: 1 });
  if (preview.response.isError) throw new Error(preview.text);
  const outsideRead = await call('classify_asset', { filePath: join(root, 'outside-existing.txt') });
  if (!outsideRead.response.isError) throw new Error('External import allowed');
  const junction = join(project, 'Graphics', 'alias');
  await symlink(root, junction, 'junction');
  const linked = await call('classify_asset', { filePath: join(junction, 'outside-existing.txt') });
  if (!linked.response.isError) throw new Error('Junction escape allowed');
  const oversized = await call('render_map', { mapId: 1, scale: 100000 });
  if (!oversized.response.isError) throw new Error('Oversized scale accepted');
  const unknown = await call('get_map', { mapId: 1, unexpected: true });
  if (!unknown.response.isError) throw new Error('Unexpected parameter accepted');
  // Bound CPU testing to an expendable worker; never send this to the live MCP.
  await writeRxdataRaw(join(project, 'Data', 'Scripts.rxdata'), [[1, Buffer.from('audit'), deflateSync(Buffer.from('a'.repeat(32) + '!'))]]);
  const workerPath = join(root, 'regex-worker.mjs');
  await writeFile(workerPath, `import { parentPort, workerData } from 'node:worker_threads';\nimport { searchScripts } from ${JSON.stringify(new URL('../dist/tools/scriptTools.js', import.meta.url).href)};\nparentPort.postMessage('started');\nawait searchScripts(workerData, '^(a+)+$');\nparentPort.postMessage('done');\n`);
  const regexResult = await new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: project });
    let timer;
    worker.on('message', msg => {
      if (msg === 'started') timer = setTimeout(async () => { await worker.terminate(); resolve('still running after 1000 ms; worker terminated'); }, 1000);
      if (msg === 'done') { clearTimeout(timer); resolve('completed'); }
    });
    worker.on('error', err => { clearTimeout(timer); reject(err); });
  });
  record('regex_cpu_exhaustion', regexResult.startsWith('still'), { inputLength: 33, regex: '^(a+)+$', result: regexResult });
  const failures = results.filter(r => r.name !== 'tool_count' && r.confirmed);
  if (failures.length) throw new Error('Security regressions: ' + failures.map(r => r.name).join(', '));
  console.log('PASS security regressions, normal exports, literal title, junction and input limits');
} finally {
  await client.close();
  await writeFile(join(root, 'results.json'), JSON.stringify({ root, results }, null, 2));
  console.log(JSON.stringify({ root, results: results.map(({ name, confirmed }) => ({ name, confirmed })) }, null, 2));
}

// End-to-end MCP contracts and transactional writes on synthetic projects only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readRxdataFile, writeRxdataFile } from '../dist/utils/rxdata.js';
import { makeMap, makeEventPage, makeEventCommand } from '../dist/utils/types.js';

const project = await mkdtemp(join(tmpdir(), 'mcp-npc-'));
await mkdir(join(project, 'Data'));
const mapPath = join(project, 'Data', 'Map001.rxdata');
const systemPath = join(project, 'Data', 'System.rxdata');
const system = { _class: 'RPG::System', magic_number: 10, variables: [null, 'Synthetic'], switches: [null, 'Synthetic'], start_map_id: 1 };
await writeRxdataFile(systemPath, system);
const map = makeMap(20, 15);
map.data.data[3] = 400;
const page = makeEventPage();
// Keep custom command data and even an existing noncanonical terminator untouched.
page.list = [{ ...makeEventCommand(101, 0, ['Existing']), custom_marker: 'preserve' }];
map.events['7'] = { _class: 'RPG::Event', id: 7, name: 'Existing', x: 0, y: 0, pages: [page] };
await writeRxdataFile(mapPath, map);
await writeFile(join(project, 'unrelated.txt'), 'unchanged');
const before = await readRxdataFile(mapPath);
const client = new Client({ name: 'npc-regression', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env: { ...process.env, RPGMAKER_PROJECT_PATH: project }, stderr: 'pipe',
});
const call = (name, args) => client.callTool({ name, arguments: args });
const value = response => { assert.ok(!response.isError, JSON.stringify(response)); return JSON.parse(response.content[0].text); };
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const pages = tools.find(t => t.name === 'create_map_event').inputSchema.properties.pages;
  assert.equal(pages.type, 'array');
  assert.equal(pages.items.type, 'object');
  assert.equal(pages.items.properties.graphic.type, 'object');
  assert.equal(pages.items.properties.list.items.type, 'object');
  assert.ok(tools.some(t => t.name === 'create_npc'));
  const originalBytes = await readFile(mapPath);
  const invalid = await call('create_map_event', { mapId: 1, name: 'Invalid', x: 2, y: 2, pages: ['not a page'] });
  assert.equal(invalid.isError, true);
  assert.deepEqual(await readFile(mapPath), originalBytes);
  console.log('PASS MCP pages schema advertises objects and rejects strings without writing');

  const messages = ['¡Hola! Café y 日本語.\nSecond\nThird\nFourth\nFifth', 'Another box\r\nFinal line'];
  const npc = value(await call('create_npc', { mapId: 1, name: 'Synthetic NPC', x: 3, y: 4, characterName: 'synthetic-character', messages }));
  assert.equal(npc.id, 8);
  const expectedPage = makeEventPage();
  expectedPage.graphic.character_name = 'synthetic-character';
  expectedPage.list = [
    makeEventCommand(101, 0, ['¡Hola! Café y 日本語.']),
    ...['Second', 'Third', 'Fourth'].map(line => makeEventCommand(401, 0, [line])),
    makeEventCommand(101, 0, ['Fifth']), makeEventCommand(101, 0, ['Another box']),
    makeEventCommand(401, 0, ['Final line']), makeEventCommand(),
  ];
  assert.deepEqual(npc.pages, [expectedPage]);
  const after = await readRxdataFile(mapPath);
  assert.deepEqual(after.events['8'], npc);
  delete after.events['8'];
  assert.deepEqual(after, before);
  const updatedSystem = await readRxdataFile(systemPath);
  assert.notEqual(updatedSystem.magic_number, system.magic_number);
  updatedSystem.magic_number = system.magic_number;
  assert.deepEqual(updatedSystem, system);
  assert.equal(await readFile(join(project, 'unrelated.txt'), 'utf8'), 'unchanged');
  assert.equal((await readdir(join(project, 'Data', '.mcp-backup'))).length, 2);
  console.log('PASS UTF-8 dialogue, message boxes, terminator, sprite, action trigger, defaults, backups and unrelated data preservation');

  const explicitPage = makeEventPage();
  explicitPage.graphic.character_name = 'explicit-character';
  const explicit = value(await call('create_map_event', { mapId: 1, name: 'Explicit', x: 5, y: 6, pages: [explicitPage] }));
  assert.deepEqual(explicit.pages, [explicitPage]);
  console.log('PASS complete object pages accepted through the MCP client');

  const stableMap = await readFile(mapPath), stableSystem = await readFile(systemPath);
  for (const overrides of [{ x: 20 }, { y: 15 }, { x: 0.5 }, { messages: [] }, { messages: [123] }]) {
    const result = await call('create_npc', { mapId: 1, name: 'Rejected', x: 1, y: 1, characterName: 'test', messages: ['test'], ...overrides });
    assert.equal(result.isError, true);
    assert.deepEqual(await readFile(mapPath), stableMap);
    assert.deepEqual(await readFile(systemPath), stableSystem);
  }
  console.log('PASS invalid positions and messages leave both data files unchanged');

  // Fail after the map has been staged, while touching the system revision.
  await writeFile(systemPath, 'malformed synthetic data');
  const failed = await call('create_npc', { mapId: 1, name: 'Rollback', x: 1, y: 1, characterName: 'test', messages: ['test'] });
  assert.equal(failed.isError, true);
  assert.deepEqual(await readFile(mapPath), stableMap);
  assert.equal(await readFile(systemPath, 'utf8'), 'malformed synthetic data');
  assert.ok(!(await readdir(join(project, 'Data'))).includes('.mcp-write.lock'));
  console.log('PASS failed operation discards staged NPC and releases the lock');
} finally { await client.close(); }
console.log('Synthetic fixtures:', project);

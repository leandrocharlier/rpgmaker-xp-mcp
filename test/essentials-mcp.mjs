// Read-only integration check against an explicitly supplied Essentials project.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { load, dump } from '../dist/vendor/marshal/index.js';
import { toPlain, toRuby } from '../dist/utils/rxdata.js';

const project = process.argv[2];
assert.ok(project, 'Usage: node test/essentials-mcp.mjs <project>');
let maps = 0;
for (const name of await readdir(join(project, 'Data'))) {
  if (!/^Map\d+\.rxdata$/.test(name)) continue;
  const raw = await readFile(join(project, 'Data', name));
  const plain = toPlain(load(raw, { string: 'utf8', hash: 'map' }));
  assert.deepEqual(toPlain(load(dump(toRuby(plain)), { string: 'utf8', hash: 'map' })), plain);
  maps++;
}
console.log(`PASS ${maps} maps round-tripped in memory`);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env: { ...process.env, RPGMAKER_PROJECT_PATH: project },
});
const client = new Client({ name: 'essentials-integration', version: '1.0.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some(t => t.name === 'get_map'));
  console.log(`PASS MCP initialize and listTools (${tools.length} tools)`);
  for (const [name, args] of [
    ['get_system', {}], ['get_database', { kind: 'tilesets' }], ['get_map', { mapId: 3 }],
    ['get_map_events', { mapId: 3 }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    const text = result.content.find(c => c.type === 'text')?.text;
    assert.ok(text && !text.startsWith('Error:'), text);
    JSON.parse(text);
    console.log(`PASS MCP ${name}`);
  }
} finally {
  await client.close();
}

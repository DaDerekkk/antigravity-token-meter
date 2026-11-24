import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'dist', 'server.mjs');
const htmlPath = path.join(root, 'dist', 'app.html');

assert.ok(fs.existsSync(serverPath), 'dist/server.mjs missing');
assert.ok(fs.existsSync(htmlPath), 'dist/app.html missing');
const html = fs.readFileSync(htmlPath, 'utf8');
assert.ok(html.includes('<script>') && html.length < 10 * 1024 * 1024, 'dist/app.html invalid');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch && !scriptMatch[1].includes('INLINE_SCRIPT'), 'inline script corrupted');
new Function(scriptMatch[1]);

// Smoke-test live MCP stdio handshake + tools/list + resources/read + tools/call
const proc = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const responses = new Map();
proc.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined) responses.set(msg.id, msg);
  }
});

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

async function waitFor(id, ms = 5000) {
  const start = Date.now();
  while (!responses.has(id)) {
    if (Date.now() - start > ms) throw new Error(`Timeout waiting for response ${id}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return responses.get(id);
}

try {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    },
  });
  const initRes = await waitFor(1);
  assert.ok(initRes.result?.capabilities?.tools, 'server must advertise tools');
  assert.ok(initRes.result?.capabilities?.resources, 'server must advertise resources');

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const toolsRes = await waitFor(2);
  const tools = toolsRes.result?.tools || [];
  const openTool = tools.find((t) => t.name === 'open_token_meter');
  assert.ok(openTool, 'open_token_meter tool missing');
  assert.equal(openTool._meta?.ui?.resourceUri, 'ui://token-meter/app.html');
  assert.equal(openTool._meta?.['com.google.antigravity/ui']?.entrypoints?.length, 2);

  send({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'ui://token-meter/app.html' } });
  const resRead = await waitFor(3);
  assert.equal(resRead.result?.contents?.[0]?.mimeType, 'text/html;profile=mcp-app');

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'open_token_meter', arguments: {} } });
  const callRes = await waitFor(4);
  const data = callRes.result?.structuredContent;
  assert.ok(data && typeof data.totals?.totalTokens === 'number', 'structuredContent.totals missing');
  assert.ok(typeof data.totals?.estimatedUsd === 'number', 'structuredContent.totals.estimatedUsd missing');
  assert.ok(Array.isArray(data.projects) && data.projects.length > 0, 'structuredContent.projects missing');
  assert.ok(Array.isArray(data.conversations) && data.conversations.length > 0, 'structuredContent.conversations missing');
  const bareHex = data.conversations.filter((c) => /^[0-9a-f]{8}$/i.test(c.title));
  assert.equal(bareHex.length, 0, `found bare hex UUID titles: ${bareHex.map((c) => c.title).join(', ')}`);

  // Test per-prompt turn breakdown on first conversation
  const sample = data.conversations[0];
  send({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'get_conversation_turns', arguments: { id: sample.id, source: sample.source } },
  });
  const turnsRes = await waitFor(5);
  const turns = turnsRes.result?.structuredContent?.turns;
  assert.ok(Array.isArray(turns) && turns.length > 0, 'get_conversation_turns returned no turns');

  console.log(
    `PASS: ${data.projects.length} projects, ${data.conversations.length} chats (0 hex titles), $${data.totals.estimatedUsd.toFixed(2)} total ($${data.totals.avgPromptUsd.toFixed(2)}/prompt), sample turns=${turns.length}`,
  );
} finally {
  proc.kill();
}

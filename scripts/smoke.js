#!/usr/bin/env node
/**
 * End-to-end smoke test over stdio, against a real SAP system.
 *
 * Unit tests cover the logic; this checks the things only a live backend can
 * answer: that the server starts, authenticates, lists its tools, reads an
 * object, selects a version, and maps a backend rejection into a diagnosable
 * error. Read-only throughout - it never locks, writes or activates anything.
 *
 * Usage (the same env vars the server itself takes):
 *   SAP_URL=... SAP_USER=... SAP_PASSWORD=... [SAP_CLIENT=...] [SAP_LANGUAGE=...] \
 *   [SMOKE_CLASS=ZCL_SOMETHING] node scripts/smoke.js
 *
 * Exits non-zero on the first failed check.
 */
const { spawn } = require('child_process');
const path = require('path');

const required = ['SAP_URL', 'SAP_USER', 'SAP_PASSWORD'];
const missing = required.filter(v => !process.env[v]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(2);
}

const CLASS_NAME = (process.env.SMOKE_CLASS || 'CL_SALV_TABLE').toUpperCase();
const CLASS_URL = `/sap/bc/adt/oo/classes/${CLASS_NAME.toLowerCase()}/source/main`;
const server = path.resolve(__dirname, '..', 'dist', 'index.js');

const child = spawn(process.execPath, [server], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit']
});

let buffer = '';
const pending = new Map();
child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let cut;
  while ((cut = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    } catch {
      // not a protocol line
    }
  }
});

let nextId = 0;
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60000);
});

const call = async (name, args = {}) => {
  const response = await send('tools/call', { name, arguments: args });
  if (response.error) return { protocolError: response.error };
  const item = response.result && response.result.content && response.result.content[0];
  let payload = item && item.text;
  try {
    payload = JSON.parse(item.text);
  } catch {
    // plain text answer
  }
  return { isError: response.result.isError === true, payload };
};

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  }
};

(async () => {
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' }
  });
  check('initialize', !!init.result, init.error);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = (await send('tools/list', {})).result.tools;
  check(`tools/list returns tools (${tools.length})`, tools.length > 0);
  const byName = new Map(tools.map(t => [t.name, t]));
  for (const name of ['healthcheck', 'getObjectSource', 'patchObjectSource', 'activateSafe', 'listLocks']) {
    check(`tool ${name} is exposed`, byName.has(name));
  }
  check('read-only tools are annotated as such',
    byName.get('getObjectSource').annotations.readOnlyHint === true);
  check('deleteObject is annotated destructive',
    !byName.has('deleteObject') || byName.get('deleteObject').annotations.destructiveHint === true);

  const health = await call('healthcheck');
  check('healthcheck reaches ADT', health.payload.status === 'healthy', health.payload);
  check('healthcheck names the system', !!(health.payload.system && health.payload.system.url));
  check('healthcheck reports latency', typeof health.payload.adt.latencyMs === 'number');

  const login = await call('login');
  check('login returns a valid result', login.payload.status === 'success', login.payload);

  const locks = await call('listLocks');
  check('listLocks answers', locks.payload.status === 'success', locks.payload);

  const source = await call('getObjectSource', {
    objectSourceUrl: CLASS_URL, startLine: 1, maxLines: 2
  });
  check(`getObjectSource reads ${CLASS_NAME}`, source.payload.status === 'success', source.payload);
  check('paging reports totals', source.payload.totalLines > 2 && source.payload.returnedLines === 2);

  const active = await call('getObjectSource', {
    objectSourceUrl: CLASS_URL, version: 'active', startLine: 1, maxLines: 1
  });
  check('version=active is honoured', active.payload.version === 'active', active.payload);

  const badVersion = await call('getObjectSource', { objectSourceUrl: CLASS_URL, version: 'latest' });
  check('an invalid version is refused', badVersion.isError === true, badVersion.payload);

  const missingObject = await call('getObjectSource', {
    objectSourceUrl: '/sap/bc/adt/oo/classes/zcl_does_not_exist_smoke/source/main'
  });
  check('a backend rejection keeps its diagnosis',
    missingObject.isError === true &&
    missingObject.payload.diagnostic === 'sap' &&
    !!missingObject.payload.adtType,
    missingObject.payload);

  console.log(failures === 0 ? '\nall smoke checks pass' : `\n${failures} smoke check(s) failed`);
  child.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch(error => {
  console.error('smoke run failed:', error.message);
  child.kill();
  process.exit(1);
});

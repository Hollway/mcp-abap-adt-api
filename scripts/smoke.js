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
  for (const name of ['healthcheck', 'getObjectSource', 'patchObjectSource', 'activateSafe', 'listLocks',
                      'findInSource', 'sourceOutline', 'editObject']) {
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

  const outline = await call('sourceOutline', { objectSourceUrl: CLASS_URL });
  check(`sourceOutline finds the blocks of ${CLASS_NAME}`,
    outline.payload.status === 'success' && outline.payload.entries > 0,
    outline.payload);
  check('sourceOutline reports a class implementation',
    (outline.payload.results || []).some(r =>
      r.entries.some(e => e.kind === 'CLASS-IMPLEMENTATION' || e.kind === 'CLASS-DEFINITION')),
    outline.payload.results && outline.payload.results[0].entries.slice(0, 5));

  const found = await call('findInSource', {
    objectSourceUrl: CLASS_URL, pattern: 'METHOD ', maxMatches: 3
  });
  check('findInSource returns line numbers',
    found.payload.status === 'success' &&
    found.payload.totalMatches > 0 &&
    found.payload.results[0].matches[0].line > 0,
    found.payload);
  check('findInSource caps the list but keeps the total honest',
    found.payload.returnedMatches <= 3 && found.payload.totalMatches >= found.payload.returnedMatches);

  const badRegex = await call('findInSource', {
    objectSourceUrl: CLASS_URL, pattern: '(unclosed', regex: true
  });
  check('findInSource refuses a broken regular expression', badRegex.isError === true, badRegex.payload);

  // Refusals that never reach the backend, so they stay read-only
  const badFragment = await call('fragmentMappings', {
    url: CLASS_URL.replace('/source/main', ''), type: 'FORM', name: 'ANYTHING'
  });
  check('fragmentMappings refuses a type that is not one', badFragment.isError === true, badFragment.payload);

  const includeThroughCreate = await call('createObject', {
    objtype: 'PROG/I', name: 'ZSMOKE_INCLUDE', parentName: 'ZSMOKE',
    description: 'smoke', parentPath: '/sap/bc/adt/packages/$tmp'
  });
  check('createObject refuses PROG/I and names createInclude',
    includeThroughCreate.isError === true &&
    /createInclude/.test(JSON.stringify(includeThroughCreate.payload)),
    includeThroughCreate.payload);

  // dryRun takes no lock and writes nothing
  const preview = await call('editObject', {
    objectSourceUrl: CLASS_URL,
    edits: [{ insertAfterLine: 0, insertion: '* smoke test, never written' }],
    dryRun: true
  });
  check('editObject dryRun returns a diff without touching anything',
    preview.payload.status === 'success' &&
    preview.payload.dryRun === true &&
    /smoke test, never written/.test(preview.payload.patch.diff),
    preview.payload);

  const afterPreview = await call('listLocks');
  check('editObject dryRun took no lock', afterPreview.payload.count === 0, afterPreview.payload);

  console.log(failures === 0 ? '\nall smoke checks pass' : `\n${failures} smoke check(s) failed`);
  child.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch(error => {
  console.error('smoke run failed:', error.message);
  child.kill();
  process.exit(1);
});

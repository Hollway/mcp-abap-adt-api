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
const STRUCTURE_NAME = (process.env.SMOKE_STRUCTURE || 'T000').toUpperCase();
const PACKAGE_NAME = (process.env.SMOKE_PACKAGE || 'SABAPDEMOS').toUpperCase();
// An object that carries a source enhancement. Find one on another system with
// SELECT ENHNAME, PROGRAMNAME FROM ENHINCINX WHERE VERSION = 'A' AND ENHMODE = 'S'.
const ENHANCED_CLASS = (process.env.SMOKE_ENHANCED || 'CL_FEBAN_ALV_GRID').toLowerCase();
// A function module every system has, for the by-name lookup.
const FUNCTION_MODULE = (process.env.SMOKE_FUNCTION || 'GUI_UPLOAD').toUpperCase();
// One with a mandatory parameter that can be filled with anything, for the
// generated call. The dry run never executes it, but the values are checked
// against the signature before that, so they have to be complete.
const CALL_FUNCTION = (process.env.SMOKE_CALL_FUNCTION || 'DATE_CHECK_PLAUSIBILITY').toUpperCase();
const CALL_VALUES = JSON.parse(process.env.SMOKE_CALL_VALUES || '{"DATE":"20260101"}');
const CLASS_URL = `/sap/bc/adt/oo/classes/${CLASS_NAME.toLowerCase()}/source/main`;
// The debugger identifies a listener by terminal and IDE, both GUIDs in ADT.
// Any pair will do for a read: nothing is registered under them.
const SMOKE_TERMINAL = process.env.SMOKE_TERMINAL || '3C4A5B6D7E8F41A2B3C4D5E6F7A8B9C0';
const SMOKE_IDE = process.env.SMOKE_IDE || '3C4A5B6D7E8F41A2B3C4D5E6F7A8B9C1';
// Set SMOKE_ATC_OBJECT to a class to have the ATC checks run over it as well.
const ATC_OBJECT = (process.env.SMOKE_ATC_OBJECT || '').toUpperCase();
// Reading a trace needs one that is closed, unexpired and not aggregated, which
// no system is guaranteed to hold - name one with SMOKE_TRACE_ID to check it.
const TRACE_ID = process.env.SMOKE_TRACE_ID || '';
const server = path.resolve(__dirname, '..', 'dist', 'main.js');

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

/**
 * A second server, started with extra environment, driven once and stopped.
 *
 * The tool list is the one thing a server decides before anything is asked of
 * it, so the only way to check that narrowing it works is to start one that
 * way. Answers whatever the given call returns; with no call, the tool list.
 */
const onServer = async (env, name, args) => {
  const other = spawn(process.execPath, [server], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'ignore']
  });
  let rest = '';
  const waiting = new Map();
  other.stdout.on('data', chunk => {
    rest += chunk.toString();
    let cut;
    while ((cut = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, cut).trim();
      rest = rest.slice(cut + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && waiting.has(message.id)) {
          waiting.get(message.id)(message);
          waiting.delete(message.id);
        }
      } catch { /* not a protocol line */ }
    }
  });
  const ask = (id, method, params) => new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    other.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60000);
  });
  try {
    await ask(1, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' }
    });
    other.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    if (!name) return (await ask(2, 'tools/list', {})).result.tools;
    const response = await ask(2, 'tools/call', { name, arguments: args || {} });
    const item = response.result && response.result.content && response.result.content[0];
    let payload = item && item.text;
    try { payload = JSON.parse(item.text); } catch { /* plain text */ }
    return { isError: response.result.isError === true, payload };
  } finally {
    other.kill();
  }
};
const toolsListOf = env => onServer(env);
const callOn = (env, name, args) => onServer(env, name, args);

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
  check('the server names the version of the package it was built from',
    init.result && init.result.serverInfo
    && init.result.serverInfo.version === require('../package.json').version,
    init.result && init.result.serverInfo);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = (await send('tools/list', {})).result.tools;
  check(`tools/list returns tools (${tools.length})`, tools.length > 0);
  const byName = new Map(tools.map(t => [t.name, t]));
  for (const name of ['healthcheck', 'getObjectSource', 'patchObjectSource', 'activateSafe', 'listLocks',
                      'findInSource', 'sourceOutline', 'editObject', 'createAndWrite', 'runTests',
                      'createDataElement', 'createDomain', 'getDataElementProperties',
                      'getDomainProperties', 'transportDetails', 'typeHierarchy', 'whereUsedMethod',
                      'objectEnhancements', 'getTextElements', 'atcDocumentation',
                      'getMessages', 'getMessageLongtext', 'setMessages', 'createMessageClass',
                      'getStructureSource', 'createStructure',
                      'packageTree', 'readSources', 'searchInPackage', 'atcCheck',
                      'changePackagePreview', 'rapGenIsAvailable',
                      'compareRevisions', 'impactOf', 'abapPath', 'callsFrom', 'abapGraph', 'addMethod', 'deleteMethod', 'addAttribute',
                      'getFunctionModule', 'listFunctionGroup', 'createFunctionModule',
                      'runSnippet', 'callFunction', 'callMethod',
                      'tableFields', 'tableIndexes', 'tableKeys']) {
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
  // Which build answered: the smoke drives the dist it was told to, and a
  // stale one is worth catching here rather than in a puzzling result later.
  const build = health.payload.server || {};
  check('healthcheck names the build that answered',
    build.version === require('../package.json').version, build);
  check('healthcheck says when that build was compiled and when it started',
    !Number.isNaN(Date.parse(build.built)) && !Number.isNaN(Date.parse(build.startedAt)), build);

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

  // A syntax check with nothing but the URL. This used to be refused with
  // "mainUrl and content are required", two parameters that for a class can
  // only ever hold the URL itself and the source behind it.
  const syntax = await call('syntaxCheckCode', { objectSourceUrl: CLASS_URL, url: CLASS_URL });
  check(`syntaxCheckCode checks ${CLASS_NAME} from its URL alone`,
    syntax.payload.status === 'success' && Array.isArray(syntax.payload.result),
    syntax.payload);
  check('syntaxCheckCode says where the source it checked came from',
    syntax.payload.readSource === true || syntax.payload.usedCachedSource === true,
    syntax.payload);

  const syntaxGone = await call('syntaxCheckCode', { url: '/sap/bc/adt/oo/classes/zsmoke_no_such_class/source/main' });
  check('syntaxCheckCode says so when there is no source to check',
    syntaxGone.isError === true && /reading it failed/.test(JSON.stringify(syntaxGone.payload)),
    syntaxGone.payload);

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

  // The lookups that work out a cursor position from a name
  const hierarchy = await call('typeHierarchy', { className: CLASS_NAME, superTypes: true });
  check(`typeHierarchy resolves ${CLASS_NAME} from its name`,
    hierarchy.payload.status === 'success' &&
    hierarchy.payload.resolvedAt.line > 0 &&
    Array.isArray(hierarchy.payload.nodes),
    hierarchy.payload);

  const noSuchMethod = await call('whereUsedMethod', {
    className: CLASS_NAME, method: 'ZZ_NO_SUCH_METHOD_SMOKE'
  });
  check('whereUsedMethod says which source it looked in',
    noSuchMethod.isError === true &&
    /No declaration or implementation/.test(JSON.stringify(noSuchMethod.payload)),
    noSuchMethod.payload);

  // Dictionary reads. Domains are not served over ADT on every release, so the
  // check is that the answer is either the definition or the explanation.
  const element = await call('getDataElementProperties', { name: 'WERKS_D' });
  check('getDataElementProperties reads a standard element',
    element.payload.status === 'success' &&
    element.payload.typeKind === 'domain' &&
    element.payload.properties.dataTypeLength > 0,
    element.payload);

  const domain = await call('getDomainProperties', { name: 'WERKS' });
  check('getDomainProperties answers, or explains that this release has no domain endpoint',
    (domain.payload.status === 'success' && !!domain.payload.properties) ||
    (domain.isError === true && /does not serve DDIC domains/.test(JSON.stringify(domain.payload))),
    domain.payload);

  // A request that cannot exist: found:false rather than an empty request
  const noSuchTransport = await call('transportDetails', { transportNumber: 'ZZZK9999999' });
  check('transportDetails reports a missing request as not found',
    noSuchTransport.payload.status === 'success' && noSuchTransport.payload.found === false,
    noSuchTransport.payload);

  const rap = await call('rapGenIsAvailable');
  check('rapGenIsAvailable answers either way',
    rap.payload.status === 'success' && typeof rap.payload.available === 'boolean',
    rap.payload);

  const texts = await call('getTextElements', { objectName: CLASS_NAME, objectType: 'CLAS/OC' });
  check('getTextElements answers, or explains that this release has no text element endpoint',
    (texts.payload.status === 'success' && Array.isArray(texts.payload.textElements)) ||
    (texts.isError === true && /does not serve text elements/.test(JSON.stringify(texts.payload))),
    texts.payload);

  // Enhancements. The answer is an object with an implementations array, and
  // most objects have none - so this passes either way and only fails if the
  // endpoint itself is gone.
  const enhanced = await call('objectEnhancements', {
    sourceMainPath: `/sap/bc/adt/oo/classes/${ENHANCED_CLASS}/source/main`
  });
  check('objectEnhancements answers with the implementations of an object',
    enhanced.payload.status === 'success' && Array.isArray(enhanced.payload.implementations),
    enhanced.payload);
  if (enhanced.payload.count > 0) {
    const implementation = enhanced.payload.implementations[0];
    check('an implementation names itself and where it is injected',
      !!implementation.name && (implementation.elements || []).length > 0 &&
      typeof implementation.elements[0].position?.startLine === 'number',
      implementation);
  }

  // ATC. The whole sequence, because the run needs a worklist id where the
  // library asks for a check variant - a variant name there answers 500.
  const atc = await call('atcCheck', { objectName: CLASS_NAME, objectType: 'CLAS/OC', maxFindings: 5 });
  check('atcCheck runs the checks and reports findings, or reports none',
    atc.payload.status === 'success' && typeof atc.payload.totalFindings === 'number' &&
    typeof atc.payload.variant === 'string',
    { variant: atc.payload.variant, total: atc.payload.totalFindings });
  if (atc.payload.totalFindings > 0) {
    const finding = atc.payload.objects[0].findings[0];
    check('a finding carries the check, the message and the line it points at',
      !!finding.check && !!finding.message && typeof finding.line === 'number', finding);
    if (finding.documentationUri) {
      const rule = await call('atcDocumentation', { docUri: finding.documentationUri });
      check('atcDocumentation reads the rule behind a finding',
        !rule.isError && String(JSON.stringify(rule.payload)).length > 100, rule.payload);
    }
  }

  // A standard SAP object is dropped from the run by the backend, so "no
  // findings" there says nothing about the object - the answer has to say
  // which of the two it is.
  if (atc.payload.totalFindings === 0) {
    const info = JSON.stringify(atc.payload.steps || []);
    const wasExcluded = /excluded from ATC check run/i.test(info);
    check('atcCheck tells an object the run excluded from one it checked and cleared',
      wasExcluded
        ? /excluded the object/.test(String(atc.payload.hint))
        : /No findings at all/.test(String(atc.payload.hint)),
      { excluded: wasExcluded, hint: atc.payload.hint });
  }

  const atcNothing = await call('atcCheck', {});
  check('atcCheck asks what to check',
    atcNothing.isError === true && /What should be checked/.test(JSON.stringify(atcNothing.payload)),
    atcNothing.payload);

  // A package walk. SMOKE_PACKAGE should be a package that holds objects;
  // ZAPP_BASE on the system this was written against holds 906.
  const tree = await call('packageTree', { packageName: PACKAGE_NAME, maxDepth: 1, maxObjects: 50 });
  check('packageTree lists a package and resolves source locations',
    tree.payload.status === 'success' && tree.payload.objectCount > 0 &&
    tree.payload.objects.some(o => typeof o.sourceUrl === 'string'),
    { count: tree.payload.objectCount, types: tree.payload.countsByType });

  const unknownPackage = await call('packageTree', { packageName: 'ZSMOKE_NO_SUCH_PACKAGE' });
  check('packageTree tells an unknown package from an empty one',
    unknownPackage.payload.exists === false,
    unknownPackage.payload);

  const readable = (tree.payload.objects || []).filter(o => o.sourceUrl).slice(0, 2)
    .map(o => ({ name: o.name, objectType: o.objectType }));
  if (readable.length) {
    const many = await call('readSources', { objects: readable, maxLinesPerObject: 10 });
    check('readSources reads several objects in one call',
      many.payload.read === readable.length &&
      many.payload.sources.every(s => s.totalLines > 0),
      { read: many.payload.read, failed: many.payload.failed });
  }

  const unreadable = await call('readSources', {
    objects: [{ name: 'ZSMOKE_ANY', objectType: 'DTEL/DE' }]
  });
  check('readSources says which types ADT serves no source for',
    /serves no source/.test(JSON.stringify(unreadable.payload)),
    unreadable.payload);

  const inPackage = await call('searchInPackage', {
    packageName: PACKAGE_NAME, pattern: 'REPORT', objectTypes: ['PROG/P'], maxDepth: 1, maxObjects: 5
  });
  check('searchInPackage walks and scans sources',
    inPackage.payload.status === 'success' && inPackage.payload.objectsScanned > 0,
    { scanned: inPackage.payload.objectsScanned, matches: inPackage.payload.totalMatches });

  // Tables and structures come from one endpoint, and the source form is the
  // only place their fields can be read: searchObject answers a table with a
  // SAPGUI bridge URI and objectStructure shows no field at all.
  const structureSource = await call('getStructureSource', { name: STRUCTURE_NAME });
  check('getStructureSource reads a table and parses its fields',
    structureSource.payload.status === 'success' &&
    structureSource.payload.fieldCount > 0 &&
    typeof structureSource.payload.source === 'string',
    structureSource.payload);
  check('getStructureSource marks the key fields',
    structureSource.payload.fields.some(f => f.keyField === true),
    structureSource.payload.fields);

  const noStructure = await call('getStructureSource', { name: 'ZSMOKE_NO_SUCH_TABLE' });
  check('getStructureSource says an unknown name is neither table nor structure',
    noStructure.isError === true &&
    /No table or structure/.test(JSON.stringify(noStructure.payload)),
    noStructure.payload);

  const structureDryRun = await call('createStructure', {
    name: 'ZSMOKE_STRUC', packageName: '$TMP', description: 'smoke',
    fields: [{ name: 'WERKS', type: 'WERKS_D', keyField: true }], dryRun: true
  });
  check('createStructure builds the DDL on a dry run without creating anything',
    structureDryRun.payload.status === 'success' &&
    structureDryRun.payload.created === false &&
    /key werks : werks_d not null;/.test(String(structureDryRun.payload.source)),
    structureDryRun.payload);

  // Message classes. Class 00 is on every system and is the size that makes
  // the filters matter: 875 messages in one 478 KB document.
  const messages = await call('getMessages', { className: '00', fromNumber: '001', toNumber: '005' });
  check('getMessages narrows a standard class down to a range',
    messages.payload.status === 'success' && messages.payload.matched === 5 &&
    messages.payload.totalMessages > 100,
    messages.payload);
  check('getMessages unescapes the placeholders of a message text',
    messages.payload.messages.some(m => m.text.includes('&1')),
    messages.payload.messages);

  const cappedMessages = await call('getMessages', { className: '00', maxMessages: 3 });
  check('getMessages caps the answer and says it was cut',
    cappedMessages.payload.truncated === true && cappedMessages.payload.messages.length === 3,
    cappedMessages.payload.messages && cappedMessages.payload.messages.length);

  const longtext = await call('getMessageLongtext', { className: '00', number: '2', language: 'E' });
  check('getMessageLongtext reads the documentation of a standard message',
    longtext.payload.status === 'success' && String(longtext.payload.longtext).length > 10,
    longtext.payload);

  const unknownClass = await call('getMessages', { className: 'ZSMOKE_NO_SUCH_CLASS' });
  check('getMessages says an unknown class does not exist',
    unknownClass.isError === true && /does not exist/.test(JSON.stringify(unknownClass.payload)),
    unknownClass.payload);

  // Refusals that never reach the backend
  const bothTypes = await call('createDataElement', {
    name: 'ZSMOKE_DTEL', description: 'smoke', packageName: '$TMP',
    domain: 'ZSMOKE_DOMA', dataType: 'CHAR', length: 4
  });
  check('createDataElement refuses a domain and a built-in type at once',
    bothTypes.isError === true && /either from a domain/.test(JSON.stringify(bothTypes.payload)),
    bothTypes.payload);

  const noTransport = await call('createAndWrite', {
    objtype: 'CLAS/OC', name: 'ZCL_SMOKE_NEVER', description: 'smoke',
    packageName: 'ZSMOKE_PACKAGE', source: 'CLASS zcl_smoke_never DEFINITION. ENDCLASS.'
  });
  check('createAndWrite refuses a real package without a transport',
    noTransport.isError === true && /transport request/.test(JSON.stringify(noTransport.payload)),
    noTransport.payload);

  const unplaceable = await call('createAndWrite', {
    objtype: 'ENQU/DL', name: 'ZSMOKE_LOCK', description: 'smoke',
    packageName: '$TMP', source: 'nothing'
  });
  check('createAndWrite refuses a type whose source it cannot place',
    unplaceable.isError === true &&
    /does not know where the source/.test(JSON.stringify(unplaceable.payload)),
    unplaceable.payload);

  // Not a policy of this server: the type map inside abap-adt-api points at a
  // ddic/tables collection that a classic ERP system does not have.
  const table = await call('createAndWrite', {
    objtype: 'TABL/DT', name: 'ZSMOKE_TABLE', description: 'smoke',
    packageName: '$TMP', source: 'define type zsmoke_table { a : abap.char(1); }'
  });
  check('createAndWrite explains why a transparent table cannot be created',
    table.isError === true && /no ddic\/tables collection/.test(JSON.stringify(table.payload)),
    table.payload);

  const noMessages = await call('setMessages', { className: '00', messages: [] });
  check('setMessages asks for messages',
    noMessages.isError === true && /Pass messages/.test(JSON.stringify(noMessages.payload)),
    noMessages.payload);

  const messageClassNoTransport = await call('createMessageClass', {
    name: 'ZSMOKE_MSG_NEVER', packageName: 'ZSMOKE_PACKAGE', description: 'smoke'
  });
  check('createMessageClass refuses a real package without a transport',
    messageClassNoTransport.isError === true &&
    /transport request/.test(JSON.stringify(messageClassNoTransport.payload)),
    messageClassNoTransport.payload);

  const noPattern = await call('searchInPackage', { packageName: PACKAGE_NAME });
  check('searchInPackage asks what to look for',
    noPattern.isError === true && /Pass pattern/.test(JSON.stringify(noPattern.payload)),
    noPattern.payload);

  const nothingToRead = await call('readSources', {});
  check('readSources asks what to read',
    nothingToRead.isError === true && /Pass objects/.test(JSON.stringify(nothingToRead.payload)),
    nothingToRead.payload);

  const noObject = await call('runTests', {});
  check('runTests asks which object', noObject.isError === true, noObject.payload);

  // Revisions and what changed between two of them. The class is read-only
  // here; the history of a standard class is long enough to test the cap.
  const history = await call('revisions', { objectName: CLASS_NAME, limit: 3 });
  check(`revisions reads the history of ${CLASS_NAME}`,
    history.payload.status === 'success' && Array.isArray(history.payload.revisions),
    history.payload);
  check('revisions caps the list',
    history.payload.returned <= 3 && history.payload.total >= history.payload.returned,
    history.payload);
  check('a revision carries its number and its transport',
    history.payload.returned === 0 ||
    (typeof history.payload.revisions[0].revision === 'string' &&
     'transport' in history.payload.revisions[0]),
    history.payload.revisions && history.payload.revisions[0]);

  const noSuchSide = await call('compareRevisions', {
    objectName: CLASS_NAME, to: 'ZZ_NO_SUCH_REQUEST'
  });
  check('compareRevisions refuses a side that is in no version',
    noSuchSide.isError === true &&
    /neither a revision number nor a transport/.test(JSON.stringify(noSuchSide.payload)),
    noSuchSide.payload);

  const sameVersion = await call('compareRevisions', {
    objectName: CLASS_NAME, from: 'active', to: 'active'
  });
  check('compareRevisions calls a version identical to itself identical',
    sameVersion.payload.status === 'success' && sameVersion.payload.summary.identical === true,
    sameVersion.payload);

  // Impact: the roll-up of a where-used answer, which raw is past the cap.
  const impact = await call('impactOf', { objectName: CLASS_NAME, maxObjects: 5 });
  check(`impactOf rolls up the usages of ${CLASS_NAME}`,
    impact.payload.status === 'success' && typeof impact.payload.summary.objects === 'number',
    impact.payload);
  check('impactOf reports how many rows the backend sent',
    typeof impact.payload.rowsFromBackend === 'number', impact.payload);
  check('impactOf lists no more objects than asked for',
    (impact.payload.usedBy || []).length <= 5, impact.payload);

  const impactNothing = await call('impactOf', {});
  check('impactOf asks what to check',
    impactNothing.isError === true && /Pass objectName/.test(JSON.stringify(impactNothing.payload)),
    impactNothing.payload);

  // Snippets: only a live backend can prove usageReferenceSnippets round-trips
  // real content for a real objectIdentifier.
  const impactSnippets = await call('impactOf', {
    objectName: CLASS_NAME, maxObjects: 1, maxPlacesPerObject: 1, snippets: true
  });
  check(`impactOf(snippets=true) fetches a real source snippet for a use of ${CLASS_NAME}`,
    impactSnippets.payload.status === 'success' && impactSnippets.payload.snippetsFetched > 0,
    impactSnippets.payload);
  const snippetPlace = ((impactSnippets.payload.usedBy || [])[0] || {}).places || [];
  check('impactOf(snippets=true) attaches the snippet to the place it belongs to, and hides the correlation id',
    Array.isArray(snippetPlace[0] && snippetPlace[0].snippets) && snippetPlace[0].snippets.length > 0 &&
    !('objectIdentifier' in (snippetPlace[0] || {})),
    impactSnippets.payload);

  // abapPath: reuse a caller impactOf just reported, so the check needs no
  // object name guessed in advance and stays correct on any system.
  const realCaller = (impact.payload.usedBy || []).find(o => o.objectUrl);
  if (realCaller) {
    const path = await call('abapPath', { toName: CLASS_NAME, fromUrl: realCaller.objectUrl });
    check(`abapPath finds the one-hop path from ${realCaller.name}, a caller impactOf just reported, to ${CLASS_NAME}`,
      path.payload.found === true && path.payload.hops === 1,
      path.payload);
  } else {
    check('abapPath live check skipped: impactOf reported no caller with a URL to use', true);
  }

  const pathMissingTarget = await call('abapPath', { fromName: CLASS_NAME });
  check('abapPath asks for the target when toName/toUrl are both missing',
    pathMissingTarget.isError === true && /What is the target object/.test(JSON.stringify(pathMissingTarget.payload)),
    pathMissingTarget.payload);

  // callsFrom: the other direction, read from the source itself. CLASS_NAME is
  // a standard class on any system, so this asks for standard targets too -
  // with the default filter a standard class calls nothing by definition.
  const calls = await call('callsFrom', { objectName: CLASS_NAME, onlyCustom: false, maxTargets: 5 });
  check(`callsFrom scans the real source of ${CLASS_NAME} and reports what it calls`,
    calls.payload.status === 'success' && calls.payload.summary.statements > 0
    && (calls.payload.calls || []).length > 0,
    calls.payload);
  check('callsFrom lists no more targets than asked for, and says what it left out',
    (calls.payload.calls || []).length <= 5
    && (calls.payload.summary.targets >= (calls.payload.calls || []).length),
    calls.payload);
  check('callsFrom quotes the statement each call was found in, with its line',
    ((calls.payload.calls || [])[0].places || []).every(place => typeof place.line === 'number' && !!place.statement),
    calls.payload);

  const callsFiltered = await call('callsFrom', { objectName: CLASS_NAME, onlyCustom: false, kinds: ['method'] });
  check('callsFrom keeps only the kinds asked for',
    (callsFiltered.payload.calls || []).every(entry => entry.kind === 'method'),
    callsFiltered.payload);

  const callsBadKind = await call('callsFrom', { objectName: CLASS_NAME, kinds: ['methods'] });
  check('callsFrom rejects a kind that does not exist, naming the ones that do',
    callsBadKind.isError === true && /not one of method/.test(JSON.stringify(callsBadKind.payload)),
    callsBadKind.payload);

  const callsNothing = await call('callsFrom', {});
  check('callsFrom asks whose calls to scan',
    callsNothing.isError === true && /Whose calls/.test(JSON.stringify(callsNothing.payload)),
    callsNothing.payload);

  // abapGraph: the same scan over a whole package. Kept small on purpose -
  // this is one source read per object, and the package here is whatever the
  // system has, not one written for the test.
  const graph = await call('abapGraph', {
    packageName: PACKAGE_NAME, maxObjects: 8, onlyCustom: false
  });
  check(`abapGraph reads ${PACKAGE_NAME} and answers with a node per object it read`,
    graph.payload.status === 'success'
    && graph.payload.scanned.objects > 0
    && graph.payload.nodes.length === graph.payload.scanned.objects,
    graph.payload);
  check('abapGraph reads no more objects than it was allowed to',
    graph.payload.scanned.objects <= 8, graph.payload);
  check('abapGraph draws every edge between two objects it actually read',
    (graph.payload.edges || []).every(edge =>
      graph.payload.nodes.some(node => node.name === edge.from)
      && graph.payload.nodes.some(node => node.name === edge.to)),
    graph.payload.edges);
  check('abapGraph counts the degree of a node from the edges it drew',
    graph.payload.nodes.every(node =>
      node.callsIn === (graph.payload.edges || []).filter(edge => edge.to === node.name).length
      || graph.payload.edgesHidden > 0),
    graph.payload.nodes);
  check('abapGraph says which objects nothing inside the package calls',
    Array.isArray(graph.payload.entryPoints) && Array.isArray(graph.payload.orphans)
    && graph.payload.entryPoints.length + graph.payload.orphans.length <= graph.payload.nodes.length,
    graph.payload);
  check('abapGraph leaves the statements out until they are asked for',
    (graph.payload.edges || []).every(edge => edge.places === undefined), graph.payload.edges);

  const graphAgain = await call('abapGraph', {
    packageName: PACKAGE_NAME, maxObjects: 8, onlyCustom: false, places: true
  });
  check('abapGraph reuses the sources this session already read',
    graphAgain.payload.scanned.fromCache > 0, graphAgain.payload.scanned);
  check('abapGraph quotes the statement behind an edge when asked',
    (graphAgain.payload.edges || []).length === 0
    || (graphAgain.payload.edges[0].places || []).every(place => typeof place.line === 'number' && !!place.statement),
    graphAgain.payload.edges);

  const graphUnknown = await call('abapGraph', { packageName: 'ZSMOKE_NO_SUCH_PACKAGE' });
  check('abapGraph says an empty package and a missing one look the same',
    graphUnknown.payload.status === 'success' && /packageTree/.test(String(graphUnknown.payload.emptyNote)),
    graphUnknown.payload);

  const graphBadKind = await call('abapGraph', { packageName: PACKAGE_NAME, kinds: ['calls'] });
  check('abapGraph rejects a kind that does not exist',
    graphBadKind.isError === true && /not one of method/.test(JSON.stringify(graphBadKind.payload)),
    graphBadKind.payload);

  // Function modules by name alone, and the group they live in.
  const fm = await call('getFunctionModule', { name: FUNCTION_MODULE });
  check(`getFunctionModule finds ${FUNCTION_MODULE} without being told its group`,
    fm.payload.status === 'success' && !!fm.payload.functionGroup, fm.payload);
  check('getFunctionModule answers with a signature as data',
    !!fm.payload.signature && Array.isArray(fm.payload.signature.importing), fm.payload);
  check('getFunctionModule leaves the body out unless asked',
    fm.payload.body === undefined && typeof fm.payload.bodyLines === 'number', fm.payload);

  const noFm = await call('getFunctionModule', { name: 'Z_SMOKE_NO_SUCH_FM' });
  check('getFunctionModule says a module is not there',
    noFm.isError === true && /No function module/.test(JSON.stringify(noFm.payload)),
    noFm.payload);

  const group = await call('listFunctionGroup', { functionGroup: fm.payload.functionGroup });
  check('listFunctionGroup lists the modules of that group',
    group.payload.status === 'success' && group.payload.counts.modules > 0, group.payload);
  check('listFunctionGroup leaves out the SAPGUI padding',
    !/OBJECT_VIT_URI/.test(JSON.stringify(group.payload)), group.payload);

  const noGroup = await call('listFunctionGroup', { functionGroup: 'ZSMOKE_NO_SUCH_FG' });
  check('listFunctionGroup tells an unknown group from an empty one',
    noGroup.payload.status === 'error' && /No function group/.test(JSON.stringify(noGroup.payload)),
    noGroup.payload);

  const fmNoGroup = await call('createFunctionModule', {
    name: 'Z_SMOKE_NEVER', functionGroup: 'ZSMOKE_NO_SUCH_FG', description: 'smoke'
  });
  check('createFunctionModule refuses a group that is not there',
    fmNoGroup.isError === true && /No function group/.test(JSON.stringify(fmNoGroup.payload)),
    fmNoGroup.payload);

  // Class members and the snippet runner: only their dry runs and refusals,
  // because everything else here writes.
  const memberDry = await call('addMethod', {
    className: CLASS_NAME, methodName: 'Z_SMOKE_NEVER', dryRun: true
  });
  check('addMethod computes the edits without writing',
    memberDry.payload.dryRun === true && !!memberDry.payload.patch, memberDry.payload);

  const memberTwice = await call('addMethod', { className: CLASS_NAME, methodName: 'CONSTRUCTOR' });
  check('addMethod refuses a member that is already there',
    memberTwice.isError === true && /already there/.test(JSON.stringify(memberTwice.payload)),
    memberTwice.payload);

  const memberNoName = await call('deleteMethod', { className: CLASS_NAME });
  check('deleteMethod asks which method',
    memberNoName.isError === true && /Pass methodName/.test(JSON.stringify(memberNoName.payload)),
    memberNoName.payload);

  const snippetDry = await call('runSnippet', { code: ['out->write( 1 ).'], dryRun: true });
  check('runSnippet builds a class that implements the run interface',
    snippetDry.payload.dryRun === true &&
    /INTERFACES if_oo_adt_classrun/.test(snippetDry.payload.source || ''),
    snippetDry.payload);

  const snippetEmpty = await call('runSnippet', { code: [] });
  check('runSnippet asks for some code',
    snippetEmpty.isError === true && /Pass code/.test(JSON.stringify(snippetEmpty.payload)),
    snippetEmpty.payload);

  // Calling something with values: only the dry run and the refusals, because
  // a real call executes code on the system.
  const callDry = await call('callFunction', {
    name: CALL_FUNCTION, values: CALL_VALUES, dryRun: true
  });
  check('callFunction generates the call without touching the system',
    callDry.payload.dryRun === true && /CALL FUNCTION/.test(callDry.payload.source || ''),
    callDry.payload);
  check('callFunction rolls a call back unless it is told otherwise',
    callDry.payload.rolledBack === true && /ROLLBACK WORK/.test(callDry.payload.source || ''),
    callDry.payload);
  check('callFunction reports what it had to substitute for a generic type',
    callDry.payload.typeSubstitutions === undefined ||
    typeof callDry.payload.typeSubstitutions === 'object',
    callDry.payload);

  const callUnknown = await call('callFunction', {
    name: CALL_FUNCTION, values: { Z_SMOKE_NO_SUCH_PARAMETER: '1' }
  });
  check('callFunction refuses a parameter the module does not have',
    callUnknown.isError === true && /no parameter/.test(JSON.stringify(callUnknown.payload)),
    callUnknown.payload);

  const methodNoName = await call('callMethod', { className: CLASS_NAME });
  check('callMethod asks which method',
    methodNoName.isError === true && /Pass className and methodName/.test(JSON.stringify(methodNoName.payload)),
    methodNoName.payload);

  const methodUnknown = await call('callMethod', { className: CLASS_NAME, methodName: 'Z_SMOKE_NEVER' });
  check('callMethod answers an unknown method with the ones the class has',
    methodUnknown.isError === true && /does not declare/.test(JSON.stringify(methodUnknown.payload)),
    methodUnknown.payload);

  // The dictionary, read whole.
  const fields = await call('tableFields', { name: STRUCTURE_NAME });
  check('tableFields reads the fields of a table',
    fields.payload.status === 'success' && fields.payload.fieldCount > 0, fields.payload);
  check('tableFields reports what kind of table it is',
    typeof fields.payload.tableClass === 'string', fields.payload);
  check('tableFields names the data element of a field',
    (fields.payload.fields || []).some(field => !!field.dataElement), fields.payload);
  check('tableFields marks the key fields',
    (fields.payload.fields || []).some(field => field.key === true), fields.payload);

  const keysOnly = await call('tableFields', { name: STRUCTURE_NAME, keysOnly: true });
  check('tableFields keeps the full count when it narrows the list',
    keysOnly.payload.fieldCount === fields.payload.fieldCount &&
    (keysOnly.payload.fields || []).every(field => field.key === true),
    keysOnly.payload);

  const noTable = await call('tableFields', { name: 'ZSMOKE_NO_SUCH_TABLE' });
  check('tableFields says a name that is not a table is not one',
    noTable.payload.status === 'error' && /not a table or structure/.test(JSON.stringify(noTable.payload)),
    noTable.payload);

  const badTable = await call('tableFields', { name: "T000' OR '1'='1" });
  check('tableFields refuses a name that could carry SQL',
    badTable.isError === true && /not a valid/.test(JSON.stringify(badTable.payload)),
    badTable.payload);

  const indexes = await call('tableIndexes', { name: STRUCTURE_NAME });
  check('tableIndexes answers with a list, empty or not',
    indexes.payload.status === 'success' && Array.isArray(indexes.payload.indexes),
    indexes.payload);

  const foreign = await call('tableKeys', { name: STRUCTURE_NAME });
  check('tableKeys answers with a list, empty or not',
    foreign.payload.status === 'success' && Array.isArray(foreign.payload.foreignKeys),
    foreign.payload);

  // Traces, users and the debugger - the surfaces a live run found broken.
  const traces = await call('tracesList');
  check('tracesList reads the trace feed',
    traces.payload.status === 'success' && Array.isArray(traces.payload.runs) &&
    typeof traces.payload.total === 'number',
    traces.payload);
  check('tracesList survives a trace that carries no title',
    (traces.payload.runs || []).every(run => typeof run.title === 'string'),
    traces.payload);

  if ((traces.payload.total || 0) > 1) {
    const oneTrace = await call('tracesList', { limit: 1 });
    check('tracesList caps the runs and says what it left out',
      oneTrace.payload.returned === 1 && oneTrace.payload.total === traces.payload.total &&
      oneTrace.payload.truncated === true,
      oneTrace.payload);
  }

  if (TRACE_ID) {
    const hits = await call('tracesHitList', { id: TRACE_ID, limit: 3, heaviestFirst: true });
    check('tracesHitList caps a hit list that would not fit',
      hits.payload.status === 'success' && hits.payload.returned <= 3 &&
      hits.payload.total >= hits.payload.returned,
      hits.payload);

    const statements = await call('tracesStatements', { id: TRACE_ID, limit: 3 });
    check('tracesStatements survives a statement with no calling program',
      statements.payload.status === 'success' && Array.isArray(statements.payload.entries) &&
      statements.payload.total > 0,
      statements.payload);

    const db = await call('tracesDbAccess', { id: TRACE_ID });
    check('tracesDbAccess reads the database side of a trace',
      db.payload.status === 'success' && !!db.payload.dbAccess, db.payload);
  }

  const listeners = await call('debuggerListeners', {
    debuggingMode: 'user',
    terminalId: SMOKE_TERMINAL,
    ideId: SMOKE_IDE,
    user: process.env.SAP_USER.toUpperCase()
  });
  check('debuggerListeners answers without the conflict check dumping',
    listeners.payload.status === 'success' &&
    ['none', 'conflict'].includes(listeners.payload.listener),
    listeners.payload);

  const someUsers = await call('systemUsers', { filter: process.env.SAP_USER, limit: 5 });
  check('systemUsers finds one user without listing the system',
    someUsers.payload.status === 'success' && someUsers.payload.matched >= 1 &&
    someUsers.payload.matched < someUsers.payload.total,
    someUsers.payload);

  const atcApprovers = await call('atcUsers', { limit: 3 });
  check('atcUsers caps its answer and counts the rest',
    atcApprovers.payload.status === 'success' && atcApprovers.payload.returned <= 3 &&
    atcApprovers.payload.total >= atcApprovers.payload.returned,
    atcApprovers.payload);

  // ATC over a real object takes minutes on a large one, so it runs only when
  // an object is named for it.
  if (ATC_OBJECT) {
    const atc = await call('atcCheck', { objectName: ATC_OBJECT, maxFindings: 5 });
    check('atcCheck runs the checks and reports them',
      atc.payload.status === 'success' && typeof atc.payload.totalFindings === 'number',
      atc.payload);
    const withFindings = (atc.payload.objects || []).flatMap(object => object.findings || []);
    if (withFindings.length) {
      check('atcCheck hands out the finding URI the exemption tools take',
        withFindings.every(finding => typeof finding.findingUri === 'string'),
        withFindings[0]);
      // The one tool no run had ever reached: a standard object is excluded
      // from the check, so there was never a finding to follow.
      const documented = withFindings.find(finding => finding.documentationUri);
      if (documented) {
        const rule = await call('atcDocumentation', { docUri: documented.documentationUri });
        check('atcDocumentation reads the rule behind a real finding',
          !rule.isError && typeof rule.payload.documentation === 'string'
          && rule.payload.documentation.length > 0,
          { check: documented.check, chars: String(rule.payload.documentation || '').length });
      }
    }
  }

  // The two data preview endpoints, which count rows differently and neither
  // of them the way the SQL text asks. Everything here is a read of a table
  // every system has.
  const capped = await call('runQuery', { sqlQuery: 'SELECT mandt FROM t000', rowNumber: 3 });
  check('runQuery returns exactly the rows asked for by rowNumber',
    capped.payload.status === 'success'
    && capped.payload.result.values.length <= 3
    && capped.payload.rows.limitedBy === 'rowNumber',
    capped.payload.rows);

  const upTo = await call('runQuery', { sqlQuery: 'SELECT mandt FROM t000 UP TO 2 ROWS' });
  check('an UP TO n ROWS the endpoint ignores is applied as the row cap instead',
    upTo.payload.result.values.length <= 2
    && upTo.payload.rows.limitedBy === 'upToRows'
    && /ignores UP TO 2 ROWS/.test(String(upTo.payload.rows.limitNote)),
    upTo.payload.rows);

  const tableRows = await call('tableContents', { ddicEntityName: 'T000', rowNumber: 2 });
  check('tableContents trims the extra row its endpoint adds past the cap',
    tableRows.payload.status === 'success' && tableRows.payload.result.values.length === 2,
    tableRows.payload.rows);
  check('tableContents spends that extra row on saying whether there is more',
    tableRows.payload.rows.more === true || tableRows.payload.rows.more === undefined,
    tableRows.payload.rows);

  const filtered = await call('tableContents', { ddicEntityName: 'T000', sqlQuery: "MANDT = '000'", rowNumber: 5 });
  check('a bare condition is completed into the SELECT the endpoint insists on',
    filtered.payload.status === 'success'
    && /^SELECT \* FROM T000 WHERE/.test(String(filtered.payload.sqlRewritten)),
    filtered.payload.sqlRewritten || filtered.payload);

  const badField = await call('runQuery', { sqlQuery: 'SELECT nosuchfield FROM t000', rowNumber: 1 });
  check('a query naming a field that does not exist answers with SAP\'s own diagnosis',
    badField.isError === true && /NOSUCHFIELD/i.test(JSON.stringify(badField.payload)),
    badField.payload);
  const afterBadField = await call('runQuery', { sqlQuery: 'SELECT mandt FROM t000', rowNumber: 1 });
  check('and does not take the session down with it',
    afterBadField.payload.status === 'success', afterBadField.payload);

  // The package graph, drawn and followed outwards.
  const drawn = await call('abapGraph', {
    packageName: PACKAGE_NAME, maxObjects: 8, onlyCustom: false, diagram: 'mermaid'
  });
  check('abapGraph draws the package when a notation is asked for',
    drawn.payload.diagram && drawn.payload.diagram.format === 'mermaid'
    && /^flowchart LR/.test(drawn.payload.diagram.text),
    drawn.payload.diagram);
  check('the drawing holds only objects the graph actually has',
    (drawn.payload.diagram.text.match(/\["([^"]+)"\]/g) || [])
      .map(box => box.slice(2, -2))
      .every(name => drawn.payload.nodes.some(node => node.name === name)),
    drawn.payload.diagram.text);

  const dot = await call('abapGraph', {
    packageName: PACKAGE_NAME, maxObjects: 8, onlyCustom: false, diagram: 'dot'
  });
  check('and draws the same graph as dot when that is what is wanted',
    /^digraph /.test(String(dot.payload.diagram.text)) && dot.payload.diagram.text.trim().endsWith('}'),
    dot.payload.diagram && dot.payload.diagram.text.slice(0, 80));

  const badFormat = await call('abapGraph', { packageName: PACKAGE_NAME, diagram: 'svg' });
  check('abapGraph refuses a notation it cannot draw',
    badFormat.isError === true && /mermaid/.test(JSON.stringify(badFormat.payload)),
    badFormat.payload);

  const outward = await call('abapGraph', {
    packageName: PACKAGE_NAME, maxObjects: 8, onlyCustom: false, resolveOutside: true, maxResolve: 5
  });
  check('abapGraph says which packages the targets outside this one live in',
    Array.isArray(outward.payload.outsidePackages)
    && outward.payload.outsidePackages.every(entry => typeof entry.package === 'string' && entry.objects.length > 0),
    outward.payload.outsidePackages);
  check('and leaves them as plain names when it was not asked',
    drawn.payload.outsidePackages === undefined, drawn.payload.outsidePackages);

  // The navigation family: position-taking calls and where-used. None of it
  // was smoked before, and none of it is forgiving - a position out by one is
  // answered confidently about the wrong object, and a where-used answer runs
  // to millions of characters unless it is paged.
  const navSource = await call('getObjectSource', { objectSourceUrl: CLASS_URL, startLine: 1, maxLines: 400 });
  const navLines = String(navSource.payload.source || '').split(/\r?\n/);
  const navText = navLines.join('\n');
  let navAt = null;
  for (let index = 0; index < navLines.length && !navAt; index++) {
    const arrow = navLines[index].indexOf('=>');
    const name = arrow > 0 && (navLines[index].slice(0, arrow).match(/([A-Za-z_][\w]*)\s*$/) || [])[1];
    if (name) navAt = { line: index + 1, start: arrow - name.length, end: arrow, afterArrow: arrow + 2, name };
  }
  check(`${CLASS_NAME} has a static call to point a cursor at`, !!navAt);

  if (navAt) {
    // No source passed: the whole stored one is read. A page of a source is a
    // different, broken source as far as the backend is concerned, and the
    // 400 lines read above are exactly the page a caller would send.
    const definition = await call('findDefinition', {
      url: CLASS_URL, line: navAt.line, startCol: navAt.start, endCol: navAt.end
    });
    check('findDefinition resolves the name under the cursor and quotes it back',
      definition.payload.found === true
      && String(definition.payload.at || '').toLowerCase() === navAt.name.toLowerCase()
      && typeof definition.payload.result.url === 'string',
      definition.payload);
    check('and says the source came from the server rather than the call',
      definition.payload.sourceFrom === 'server', definition.payload.sourceFrom);

    if (navSource.payload.totalLines > navLines.length) {
      const cut = await call('findDefinition', {
        url: CLASS_URL, source: navText, line: navAt.line, startCol: navAt.start, endCol: navAt.end
      });
      check('a source cut to a page is refused by the backend, with its own words',
        cut.isError === true && /incomplete/i.test(JSON.stringify(cut.payload)), cut.payload);
    }

    const offSource = await call('findDefinition', {
      url: CLASS_URL, source: navText, line: navAt.line, startCol: 0, endCol: 1
    });
    check('findDefinition refuses a cursor that is not on a name rather than answering an empty URL',
      offSource.isError === true && /not on a name/.test(JSON.stringify(offSource.payload)),
      offSource.payload);

    const past = await call('findDefinition', {
      url: CLASS_URL, line: navSource.payload.totalLines + 500, startCol: 0, endCol: 1
    });
    check('findDefinition refuses a line outside the source instead of spending a call on a 500',
      past.isError === true && /outside the source/.test(JSON.stringify(past.payload)),
      past.payload);

    const proposals = await call('codeCompletion', {
      sourceUrl: CLASS_URL, line: navAt.line, column: navAt.afterArrow
    });
    check('codeCompletion proposes something after a static call arrow',
      proposals.payload.proposals > 0 && Array.isArray(proposals.payload.result),
      { proposals: proposals.payload.proposals });

    const outside = await call('codeCompletion', {
      sourceUrl: CLASS_URL, line: navSource.payload.totalLines + 500, column: 1
    });
    check('codeCompletion refuses a position outside the source instead of answering an empty list',
      outside.isError === true && /outside the source/.test(JSON.stringify(outside.payload)),
      outside.payload);

    const first = (proposals.payload.result || [])[0];
    if (first && first.IDENTIFIER) {
      const inserted = await call('codeCompletionFull', {
        sourceUrl: CLASS_URL, line: navAt.line, column: navAt.afterArrow, patternKey: first.IDENTIFIER
      });
      check('codeCompletionFull answers one insert text, or says the proposal inserts none',
        typeof inserted.payload.result === 'string'
        && (inserted.payload.result.length > 0 || /no insert text/.test(String(inserted.payload.hint))),
        inserted.payload);
    }
    const blankKey = await call('codeCompletionFull', {
      sourceUrl: CLASS_URL, line: navAt.line, column: navAt.afterArrow, patternKey: ' '
    });
    check('codeCompletionFull refuses a blank patternKey rather than letting the backend raise',
      blankKey.isError === true && /IDENTIFIER of the proposal/.test(JSON.stringify(blankKey.payload)),
      blankKey.payload);

    const element = await call('codeCompletionElement', {
      sourceUrl: CLASS_URL, line: navAt.line, column: navAt.afterArrow
    });
    check('codeCompletionElement names what the cursor is on',
      typeof element.payload.result === 'object' && typeof element.payload.result.name === 'string',
      element.payload.result && element.payload.result.name);
  }

  const usages = await call('usageReferences', {
    url: `/sap/bc/adt/oo/classes/${CLASS_NAME.toLowerCase()}`, maxResults: 5
  });
  check('usageReferences answers a summary of the whole tree and one small page of it',
    usages.payload.summary.total >= usages.payload.returned
    && usages.payload.returned <= 5
    && typeof usages.payload.summary.usageSites === 'number'
    && JSON.stringify(usages.payload).length < 40000,
    { summary: usages.payload.summary, returned: usages.payload.returned, chars: JSON.stringify(usages.payload).length });
  check('usageReferences says how to ask for the next page when there is one',
    usages.payload.more === false || /offset=/.test(String(usages.payload.hint)),
    usages.payload.hint);

  const sites = await call('usageReferences', {
    url: `/sap/bc/adt/oo/classes/${CLASS_NAME.toLowerCase()}`, maxResults: 3, onlyWithSnippets: true
  });
  check('onlyWithSnippets keeps just the rows a snippet can be fetched for',
    sites.payload.rows.every(row => typeof row.objectIdentifier === 'string' && row.objectIdentifier.length > 0),
    sites.payload.rows.map(row => row.name));

  if ((sites.payload.rows || []).length > 0) {
    const snippets = await call('usageReferenceSnippets', { references: sites.payload.rows.slice(0, 2) });
    check('usageReferenceSnippets reads the call sites of the rows it was given',
      snippets.payload.asked > 0 && Array.isArray(snippets.payload.result),
      { asked: snippets.payload.asked, ignored: snippets.payload.ignored });
  }
  const groupingRows = (usages.payload.rows || []).filter(row => !row.objectIdentifier);
  if (groupingRows.length > 0) {
    const refusedRows = await call('usageReferenceSnippets', { references: groupingRows.slice(0, 2) });
    check('usageReferenceSnippets refuses the grouping rows instead of answering nothing',
      refusedRows.isError === true && /onlyWithSnippets/.test(JSON.stringify(refusedRows.payload)),
      refusedRows.payload);
  }

  const printerSetting = await call('prettyPrinterSetting');
  check('prettyPrinterSetting answers the two settings it has',
    typeof printerSetting.payload.settings === 'object'
    && 'abapformatter:style' in printerSetting.payload.settings,
    printerSetting.payload.settings);

  const formatted = await call('prettyPrinter', {
    source: 'report z_smoke.\ndata lv_x type i.\nif lv_x = 1.\nwrite / lv_x.\nendif.'
  });
  check('prettyPrinter reformats the source it is given and writes nothing',
    /REPORT/.test(String(formatted.payload.result || formatted.payload.source || '')),
    formatted.payload.result || formatted.payload.source);

  // The refactorings, at the steps that only read. extractMethodEvaluate
  // answers even for a standard SAP class; renameEvaluate refuses a symbol
  // used too widely, and that refusal is the thing worth checking.
  if (navAt) {
    const extract = await call('extractMethodEvaluate', {
      uri: CLASS_URL,
      range: JSON.stringify({ start: { line: navAt.line, column: 0 }, end: { line: navAt.line + 1, column: 0 } })
    });
    check('extractMethodEvaluate answers with a proposal that quotes the lines it would move',
      extract.isError === true
        ? /refactoring|not possible/i.test(JSON.stringify(extract.payload))
        : typeof extract.payload.result === 'object' && !!extract.payload.result.genericRefactoring,
      extract.isError ? extract.payload : Object.keys(extract.payload.result || {}));
  }

  // The reading tools no smoke run had ever called. Three of them answer past
  // the response cap unless they are narrowed, and three answer nothing in a
  // way that reads like an answer.
  const discovery = await call('adtDiscovery', { maxResults: 5 });
  check('adtDiscovery counts every collection this system serves and returns one page',
    discovery.payload.summary.collections > discovery.payload.summary.returned
    && discovery.payload.summary.returned <= 5
    && JSON.stringify(discovery.payload).length < 20000,
    { summary: discovery.payload.summary, chars: JSON.stringify(discovery.payload).length });
  check('and leaves the template links out of the page unless they are asked for',
    discovery.payload.collections.every(collection => collection.templateLinks === undefined),
    discovery.payload.collections[0]);
  const searchedDiscovery = await call('adtDiscovery', { search: 'atc', maxResults: 5 });
  check('adtDiscovery narrows to the collections a search matches',
    searchedDiscovery.payload.summary.matched > 0
    && searchedDiscovery.payload.summary.matched < discovery.payload.summary.collections
    && searchedDiscovery.payload.collections.every(collection => /atc/i.test(
      `${collection.href} ${collection.title} ${collection.workspace}`)),
    searchedDiscovery.payload.collections.map(collection => collection.href));

  const feedList = await call('feeds');
  check('feeds names the dump feed among the ones it publishes',
    Array.isArray(feedList.payload.feeds)
    && feedList.payload.feeds.some(feed => /dumps/.test(String(feed.href))),
    (feedList.payload.feeds || []).map(feed => feed.href));

  const shortDumps = await call('dumps', { max: 3 });
  check('dumps answers the headers without the ST22 pages behind them',
    typeof shortDumps.payload.count === 'number'
    && shortDumps.payload.returned <= 3
    && (shortDumps.payload.dumps.dumps || []).every(entry => entry.text === undefined),
    { count: shortDumps.payload.count, returned: shortDumps.payload.returned });
  check('and the headers still say which runtime error it was',
    (shortDumps.payload.dumps.dumps || []).length === 0
    || (shortDumps.payload.dumps.dumps || []).every(entry => typeof entry.textChars === 'number'),
    (shortDumps.payload.dumps.dumps || [])[0]);

  const classMeta = await call('objectStructure', { objectUrl: `/sap/bc/adt/oo/classes/${CLASS_NAME.toLowerCase()}` });
  check('objectStructure reads the metadata of a class and its source link',
    classMeta.payload.structure.metaData['adtcore:name'] === CLASS_NAME
    || String(classMeta.payload.structure.objectUrl).includes(CLASS_NAME.toLowerCase()),
    classMeta.payload.structure.objectUrl);
  const tableMeta = await call('objectStructure', { objectUrl: `/sap/bc/adt/ddic/structures/${STRUCTURE_NAME.toLowerCase()}` });
  check('objectStructure reads a table from the structures collection both types share',
    tableMeta.payload.structure.metaData['adtcore:name'] === STRUCTURE_NAME,
    tableMeta.payload.structure.metaData['adtcore:name']);

  const searched = await call('searchObject', { query: `${CLASS_NAME}*`, max: 3 });
  check('searchObject finds an object by name, with its type and package',
    (searched.payload.results || []).some(row => row['adtcore:name'] === CLASS_NAME
      && row['adtcore:type'] === 'CLAS/OC' && !!row['adtcore:packageName']),
    searched.payload.results);
  const missed = await call('searchObject', { query: 'ZZZ_NO_SUCH_OBJECT_AT_ALL*', max: 3 });
  check('searchObject answers an empty list for a name nothing matches',
    Array.isArray(missed.payload.results) && missed.payload.results.length === 0);

  const registration = await call('objectRegistrationInfo', { objectUrl: `/sap/bc/adt/oo/classes/${CLASS_NAME.toLowerCase()}` });
  check('objectRegistrationInfo says how the object travels and whether a key is needed',
    !!registration.payload.info.object && 'reg:isRequired' in registration.payload.info.object,
    registration.payload.info.object);

  const level = await call('nodeContents', { parent_type: 'DEVC/K', parent_name: PACKAGE_NAME, maxResults: 5 });
  check(`nodeContents counts the whole level of ${PACKAGE_NAME} and returns one page of it`,
    level.payload.counts.nodes >= level.payload.returned
    && level.payload.returned <= 5
    && JSON.stringify(level.payload).length < 40000,
    { nodes: level.payload.counts.nodes, returned: level.payload.returned, chars: JSON.stringify(level.payload).length });
  check('and says which types the level holds, so the next page can be narrowed',
    Object.keys(level.payload.counts.byType || {}).length > 0, level.payload.counts.byType);

  const nowhere = await call('nodeContents', { parent_type: 'DEVC/K', parent_name: 'ZZZ_NO_SUCH_PACKAGE' });
  check('nodeContents says an empty level cannot be told from a package that is not there',
    nowhere.payload.total === 0 && /unknown package/.test(String(nowhere.payload.hint)),
    nowhere.payload.hint);

  const entity = await call('ddicElement', { path: STRUCTURE_NAME });
  check(`ddicElement reads the fields of ${STRUCTURE_NAME} with their data elements`,
    entity.payload.found === true && entity.payload.fields > 0,
    { found: entity.payload.found, fields: entity.payload.fields });
  const notAnEntity = await call('ddicElement', { path: 'WERKS_D' });
  check('ddicElement says a data element gets the same empty shell as a name that is not there',
    notAnEntity.payload.found === false && /getDataElementProperties/.test(String(notAnEntity.payload.hint)),
    notAnEntity.payload.hint);

  const configurations = await call('transportConfigurations');
  check('transportConfigurations answers with a list, empty or not',
    Array.isArray(configurations.payload.configurations));

  const mine = await call('userTransports', { user: process.env.SAP_USER, status: 'all' });
  check('userTransports answers a flat list of requests for the connected user',
    typeof mine.payload.count === 'number' && Array.isArray(mine.payload.requests)
    && mine.payload.requests.every(request => !!request.number && !!request.status),
    { count: mine.payload.count });

  // Transport hygiene, read from the organizer tables. The request is
  // whichever one the connected user owns - there is nothing to configure,
  // and nothing here writes.
  const longQuery = await call('runQuery', {
    sqlQuery: `SELECT trkorr FROM e070 WHERE trkorr IN (${Array.from({ length: 30 }, () => "'DEVK900001'").join(', ')})`
  });
  check('runQuery refuses a statement past the 255 characters the endpoint accepts',
    longQuery.isError === true && /refuses anything over 255/.test(JSON.stringify(longQuery.payload)),
    longQuery.payload);

  const anyRequest = (mine.payload.requests || [])[0];
  if (anyRequest) {
    const readiness = await call('transportReadiness', { transport: anyRequest.number });
    check(`transportReadiness answers for ${anyRequest.number} with a verdict per check`,
      typeof readiness.payload.ready === 'boolean'
      && ['status', 'tasks', 'objects', 'conflicts', 'activation', 'locks']
        .every(name => (readiness.payload.checks || []).some(check => check.check === name)),
      (readiness.payload.checks || []).map(check => `${check.check}:${check.ok}`));
    check('and says how many objects it examined and how many it left out',
      readiness.payload.objects && typeof readiness.payload.objects.total === 'number'
      && readiness.payload.objects.examined + readiness.payload.objects.skipped === readiness.payload.objects.total,
      readiness.payload.objects);

    const conflicts = await call('transportConflicts', { transport: anyRequest.number, maxObjects: 5 });
    check('transportConflicts counts the objects it looked up and the requests they sit in',
      typeof conflicts.payload.summary.objects === 'number'
      && typeof conflicts.payload.summary.conflicting === 'number'
      && conflicts.payload.conflicts.every(row => !!row.otherRequest && !!row.owner),
      conflicts.payload.summary);

    const objectRow = (readiness.payload.inactive || [])[0];
    const objectName = objectRow ? String(objectRow.name).split(' ')[0] : undefined;
    if (objectName) {
      const travelled = await call('objectTransports', { objectName, maxResults: 3 });
      check(`objectTransports answers the history of ${objectName}`,
        travelled.payload.found === true && travelled.payload.summary.requests > 0,
        travelled.payload.summary);
    }
  }

  const missingRequest = await call('transportReadiness', { transport: 'ZZZK999999' });
  check('transportReadiness says a request number nothing answers to is not there',
    missingRequest.isError === true
    && /(No transport request|not a transport request number)/.test(JSON.stringify(missingRequest.payload)),
    missingRequest.payload);

  const localObject = await call('objectTransports', { objectName: 'ZZZ_NO_SUCH_OBJECT_AT_ALL' });
  check('objectTransports says an object travels in no request rather than answering with nothing',
    localObject.payload.found === false && /\$TMP/.test(String(localObject.payload.hint)),
    localObject.payload.hint);

  const repos = await call('gitRepos');
  check('gitRepos either lists the repositories or says abapGit is not installed here',
    repos.isError === true
      ? /abapGit is not installed/.test(JSON.stringify(repos.payload))
      : Array.isArray(repos.payload.repos),
    repos.payload);

  const annotations = await call('annotationDefinitions');
  check('annotationDefinitions either answers or says this system does not serve them',
    annotations.isError === true
      ? /does not serve the CDS annotation definitions/.test(JSON.stringify(annotations.payload))
      : !!annotations.payload,
    annotations.isError ? annotations.payload.error : 'served');

  const noClass = await call('unitTestEvaluation', {});
  check('unitTestEvaluation asks for the test class instead of failing on undefined',
    noClass.isError === true && /Pass clas/.test(JSON.stringify(noClass.payload)),
    noClass.payload);

  // The second half of the never-called reading tools. Three of them answered
  // whole catalogues - 141,045 characters for loadTypes alone - and six
  // answered nothing at all in a way that read like an answer.
  const types = await call('loadTypes', { name: 'CLAS', maxResults: 3 });
  check('loadTypes counts the whole catalogue and returns one filtered page of it',
    types.payload.summary.total > types.payload.summary.matched
    && types.payload.summary.returned <= 3
    && JSON.stringify(types.payload).length < 20000,
    { summary: types.payload.summary, chars: JSON.stringify(types.payload).length });
  check('and every type on the page matches what was asked for',
    types.payload.types.every(type => /clas/i.test(`${type.type} ${type.label}`)),
    types.payload.types.map(type => type.type));

  const compat = await call('adtCompatibiliyGraph', { maxResults: 3 });
  check('adtCompatibiliyGraph counts its nodes and edges and returns a page of edges',
    compat.payload.summary.edges >= compat.payload.summary.returned
    && compat.payload.summary.nodes > 0
    && compat.payload.edges.every(edge => !!edge.from && !!edge.to)
    && JSON.stringify(compat.payload).length < 20000,
    { summary: compat.payload.summary, chars: JSON.stringify(compat.payload).length });

  const noFeature = await call('featureDetails', { title: 'No Such Feature At All' });
  check('featureDetails says a title is not there rather than answering with nothing',
    noFeature.payload.found === false && typeof noFeature.payload.titleCount === 'number',
    noFeature.payload);

  const collectionTemplate = await call('collectionFeatureDetails', { url: '/sap/bc/adt/oo/classes' });
  check('collectionFeatureDetails says a collection address is not the template link it matches on',
    collectionTemplate.payload.found === false && /collection/i.test(String(collectionTemplate.payload.reason)),
    collectionTemplate.payload.reason);

  const served = await call('findCollectionByUrl', { url: '/sap/bc/adt/oo/classes' });
  check('findCollectionByUrl resolves a collection address to the collection that serves it',
    served.payload.found === true && !!served.payload.collection,
    served.payload.found);
  const unserved = await call('findCollectionByUrl', { url: '/sap/bc/adt/no/such/collection' });
  check('and says so, with the nearest addresses, when nothing serves one',
    unserved.payload.found === false && (unserved.payload.nearestCollections || []).length > 0,
    unserved.payload.nearestCollections);

  const checkTypes = await call('syntaxCheckTypes');
  check('syntaxCheckTypes answers with the flavours themselves, not with an empty Map',
    checkTypes.payload.checkTypes > 0
    && Object.values(checkTypes.payload.result).every(list => Array.isArray(list)),
    checkTypes.payload.result);

  const catalogue = await call('objectTypes');
  check('objectTypes either lists the types or says this system publishes none',
    catalogue.payload.found === true
      ? catalogue.payload.count > 0
      : /loadTypes/.test(String(catalogue.payload.hint)),
    { found: catalogue.payload.found, count: catalogue.payload.count });

  const includes = await call('classIncludes', { clas: CLASS_NAME });
  check(`classIncludes answers for ${CLASS_NAME} by name, which used to throw on every call`,
    includes.payload.found === true
    && !!includes.payload.result.main
    && includes.payload.includes.every(include => !!include.includeType && !!include.url),
    Object.keys(includes.payload.result || {}));

  const methods = await call('classComponents', { url: CLASS_NAME, type: 'CLAS/OM', maxResults: 3 });
  check('classComponents counts the components of a class and returns one filtered page',
    methods.payload.summary.total >= methods.payload.summary.matched
    && methods.payload.components.length <= 3
    && methods.payload.components.every(component => component.type === 'CLAS/OM')
    && JSON.stringify(methods.payload).length < 20000,
    { summary: methods.payload.summary, chars: JSON.stringify(methods.payload).length });

  const keyword = await call('abapDocumentation', {
    objectUri: CLASS_URL,
    body: `CLASS ${CLASS_NAME.toLowerCase()} DEFINITION.\nENDCLASS.`,
    line: 1,
    column: 2
  });
  check('abapDocumentation answers with the text of the page, not with the page',
    keyword.payload.text !== undefined
    && keyword.payload.chars < keyword.payload.htmlChars
    && !/<html|<head|doctype/i.test(String(keyword.payload.text)),
    { chars: keyword.payload.chars, htmlChars: keyword.payload.htmlChars });

  const fixes = await call('fixProposals', {
    url: CLASS_URL,
    source: `CLASS ${CLASS_NAME.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PRIVATE.\n  PUBLIC SECTION.\nENDCLASS.\nCLASS ${CLASS_NAME.toLowerCase()} IMPLEMENTATION.\nENDCLASS.`,
    line: 1,
    column: 7
  });
  check('fixProposals answers with proposals whose description can be read',
    typeof fixes.payload.found === 'number'
    && (fixes.payload.proposals || []).every(proposal => !/&lt;|&gt;/.test(String(proposal.description))),
    (fixes.payload.proposals || []).map(proposal => proposal.name));
  const badProposal = await call('fixEdits', { proposal: {}, source: 'REPORT z.' });
  check('fixEdits names what a proposal is missing instead of reading a field of undefined',
    badProposal.isError === true && /fixProposals/.test(JSON.stringify(badProposal.payload)),
    badProposal.payload);

  const unknownDdic = await call('ddicRepositoryAccess', { path: 'ZZZ_NO_SUCH_NAME' });
  check('ddicRepositoryAccess says the dictionary knows nothing under a name',
    unknownDdic.payload.found === false, unknownDdic.payload);

  const wrongHelp = await call('packageSearchHelp', { type: 'PACKAGE' });
  check('packageSearchHelp refuses a value-help name that is not one of the four',
    wrongHelp.isError === true && /applicationcomponents/.test(JSON.stringify(wrongHelp.payload)),
    wrongHelp.payload);
  const help = await call('packageSearchHelp', { type: 'transportlayers' });
  check('and either answers the value help or says this release does not serve it',
    help.isError === true
      ? /does not serve the package value helps/.test(JSON.stringify(help.payload))
      : typeof help.payload.found === 'number',
    help.isError ? help.payload.error : help.payload.found);

  const noCds = await call('syntaxCheckCdsUrl', { cdsUrl: '/sap/bc/adt/ddic/ddl/sources/zzz_no_such_view' });
  check('syntaxCheckCdsUrl does not call a view that is not there clean',
    noCds.payload.found === false && noCds.payload.clean === undefined,
    noCds.payload);

  const inactive = await call('inactiveObjects');
  check('inactiveObjects answers in an envelope with a count, like every other tool',
    inactive.payload.status === 'success' && typeof inactive.payload.count === 'number',
    inactive.payload);

  const classInclude = await call('mainPrograms', { includeUrl: `${CLASS_URL.replace('/source/main', '')}/includes/implementations` });
  check('mainPrograms says which includes it answers for when the backend only says 404',
    classInclude.isError === true && /classIncludes/.test(JSON.stringify(classInclude.payload)),
    classInclude.payload);

  const packagePath = await call('findObjectPath', { objectUrl: `/sap/bc/adt/packages/${PACKAGE_NAME.toLowerCase()}` });
  check('findObjectPath says which addresses it maps when it is handed a package',
    packagePath.isError === true
      ? /repository object/.test(JSON.stringify(packagePath.payload))
      : Array.isArray(packagePath.payload.path),
    packagePath.isError ? packagePath.payload.error : 'answered');

  const madeUpVariant = await call('atcCheckVariant', { variant: 'ZZZ_NO_SUCH_VARIANT' });
  check('atcCheckVariant refuses a variant the system does not have instead of opening a worklist on it',
    madeUpVariant.isError === true && /no ATC check variant/.test(JSON.stringify(madeUpVariant.payload)),
    madeUpVariant.payload);
  const unsafeVariant = await call('atcCheckVariant', { variant: 'DEFAULT&checkVariant=OTHER' });
  check('and refuses a name that would carry something else into the query string',
    unsafeVariant.isError === true && /not a check variant name/.test(JSON.stringify(unsafeVariant.payload)),
    unsafeVariant.payload);

  const madeUpConfig = await call('transportsByConfig', { configUri: '/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/zzz' });
  check('transportsByConfig refuses an address no configuration has, rather than answering with every request in the system',
    madeUpConfig.isError === true
    && /(no organizer configuration|publishes no transport organizer)/.test(JSON.stringify(madeUpConfig.payload)),
    madeUpConfig.payload);

  const repoAsName = await call('checkRepo', { repo: 'ZREPO' });
  check('checkRepo says what a repository object is instead of reading a field of undefined',
    repoAsName.isError === true && /gitRepos/.test(JSON.stringify(repoAsName.payload)),
    repoAsName.payload);

  const externalRepo = await call('gitExternalRepoInfo', { repourl: 'https://example.invalid/none.git' });
  check('gitExternalRepoInfo says abapGit is absent the same way gitRepos does',
    externalRepo.isError !== true
    || /abapGit is not installed|Failed to get external repo info/.test(JSON.stringify(externalRepo.payload)),
    externalRepo.payload);

  // ---------------------------------------------------------------------
  // The reads nothing used to call.
  //
  // A measurement over this script found 26 read-only tools it never touched,
  // among them every one repaired in the session before this: repairs that
  // nothing would notice losing again. These are their checks. All of them
  // read, and the ones that pass a made-up argument check the refusal, which
  // is the part that used to be a crash inside the library.
  // ---------------------------------------------------------------------

  const coreDiscovery = await call('adtCoreDiscovery');
  check('adtCoreDiscovery lists the core collections',
    coreDiscovery.payload.status === 'success' && Array.isArray(coreDiscovery.payload.discovery)
    && coreDiscovery.payload.discovery.length > 0,
    coreDiscovery.payload);

  const ticket = await call('reentranceTicket');
  check('reentranceTicket answers a ticket',
    ticket.payload.status === 'success' && typeof ticket.payload.ticket === 'string'
    && ticket.payload.ticket.length > 0,
    ticket.payload.status);

  const hasConfig = await call('hasTransportConfig');
  check('hasTransportConfig answers yes or no, not undefined',
    hasConfig.payload.status === 'success' && typeof hasConfig.payload.hasConfig === 'boolean',
    hasConfig.payload);

  const organizerConfigs = await call('transportConfigurations');
  check('transportConfigurations answers a list',
    organizerConfigs.payload.status === 'success' && Array.isArray(organizerConfigs.payload.configurations),
    organizerConfigs.payload);
  const configLink = (organizerConfigs.payload.configurations || [])
    .map(entry => entry && (entry.link || entry.uri || entry.url))
    .find(Boolean);
  if (configLink) {
    const configuration = await call('getTransportConfiguration', { url: configLink });
    check('getTransportConfiguration reads the configuration transportConfigurations named',
      configuration.payload.status === 'success', configuration.payload);
  } else {
    const noConfiguration = await call('getTransportConfiguration', {
      url: '/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/zzz_no_such'
    });
    check('getTransportConfiguration says where the address comes from when the system has none',
      noConfiguration.isError === true && /transportConfigurations/.test(JSON.stringify(noConfiguration.payload)),
      noConfiguration.payload);
  }

  // A standard SAP class answers this with a refusal, and the refusal is the
  // backend's own: recording a change to an SAP object needs a modification
  // licence, and without one the system says so instead of describing the
  // change. Either answer is the tool working; an empty success is not.
  const transportInfo = await call('transportInfo', { objSourceUrl: CLASS_URL, operation: 'I' });
  check(`transportInfo answers for ${CLASS_NAME} about ${CLASS_NAME}`,
    transportInfo.isError === true
      ? new RegExp(CLASS_NAME, 'i').test(JSON.stringify(transportInfo.payload))
      : String((transportInfo.payload.transportInfo || {}).OBJECTNAME || '').toUpperCase() === CLASS_NAME,
    transportInfo.payload);

  const reference = await call('transportReference', {
    pgmid: 'R3TR', obj_wbtype: 'CLAS', obj_name: CLASS_NAME
  });
  check('transportReference maps a transport entry back to an ADT address',
    reference.payload.status === 'success' && typeof reference.payload.reference === 'string'
    && reference.payload.reference.includes(CLASS_NAME.toLowerCase()),
    reference.payload);

  const traceRequests = await call('tracesListRequests', { user: process.env.SAP_USER });
  check('tracesListRequests answers the trace request feed',
    traceRequests.payload.status === 'success' && !!traceRequests.payload.requests,
    traceRequests.payload);

  const freeName = await call('validateNewObject', {
    options: { objtype: 'CLAS/OC', objname: 'ZSMOKE_FREE_NAME', packagename: '$TMP', description: 'smoke' }
  });
  check('validateNewObject answers for a name nothing has taken',
    freeName.payload.status === 'success', freeName.payload);

  // The regression this guards: the package of an object used to be read as
  // the OUTERMOST package of its path, so the refactoring was built against a
  // package the object is not in, and the backend refused it with "Package
  // assignment ... changed since the refactoring started".
  const objectPath = await call('findObjectPath', { objectUrl: CLASS_URL.replace('/source/main', '') });
  const innermostPackage = ((objectPath.payload && objectPath.payload.path) || [])
    .filter(step => String(step['adtcore:type'] || '').startsWith('DEVC'))
    .map(step => step['adtcore:name'])
    .pop();
  const movePreview = await call('changePackagePreview', {
    objectUrl: CLASS_URL.replace('/source/main', ''), newPackage: '$TMP'
  });
  check('changePackagePreview works from the package the object is really in',
    movePreview.isError === true
      ? !/changed since the refactoring started/.test(JSON.stringify(movePreview.payload))
      : String(movePreview.payload.oldPackage || '').toUpperCase() === String(innermostPackage || '').toUpperCase(),
    { innermostPackage, answered: movePreview.payload });

  const customizing = await call('atcCustomizing');
  check('atcCustomizing names how ATC is set up here',
    customizing.payload.status === 'success' && Array.isArray(customizing.payload.result.properties),
    customizing.payload);

  const madeUpWorklist = await call('atcWorklists', { runResultId: 'NO_SUCH_WORKLIST' });
  check('atcWorklists says where a run result id comes from instead of repeating a 500',
    madeUpWorklist.isError === true && /createAtcRun|atcCheck/.test(JSON.stringify(madeUpWorklist.payload)),
    madeUpWorklist.payload);

  const madeUpMarker = await call('atcExemptProposal', { markerId: 'NO_SUCH_MARKER' });
  check('atcExemptProposal answers a made-up marker with a diagnosis, not a crash',
    !/Cannot read propert/.test(JSON.stringify(madeUpMarker.payload)),
    madeUpMarker.payload);

  const noFinding = await call('atcContactUri', {});
  check('atcContactUri asks for the finding rather than calling with nothing',
    noFinding.isError === true && /Pass findingUri/.test(JSON.stringify(noFinding.payload)),
    noFinding.payload);

  const noProposal = await call('isProposalMessage', {});
  check('isProposalMessage says what a proposal is instead of reading a field of undefined',
    !/Cannot read propert/.test(JSON.stringify(noProposal.payload)),
    noProposal.payload);

  const noBinding = await call('bindingDetails', {});
  check('bindingDetails names the object it needs instead of reading a field of undefined',
    noBinding.isError === true && /binding/.test(JSON.stringify(noBinding.payload))
    && !/Cannot read propert/.test(JSON.stringify(noBinding.payload)),
    noBinding.payload);

  const noRepo = await call('remoteRepoInfo', {});
  check('remoteRepoInfo points at gitRepos instead of reading a field of undefined',
    noRepo.isError === true && /gitRepos/.test(JSON.stringify(noRepo.payload)),
    noRepo.payload);

  const markerSource = await call('getObjectSource', { objectSourceUrl: CLASS_URL, startLine: 1, maxLines: 40 });
  const markers = await call('unitTestOccurrenceMarkers', {
    url: CLASS_URL, source: markerSource.payload.source || ''
  });
  check('unitTestOccurrenceMarkers answers the coverage markers, even when there are none',
    markers.payload.status === 'success' && Array.isArray(markers.payload.markers),
    markers.payload);

  const renameNothing = await call('renamePreview', {});
  check('renamePreview names the proposal it needs instead of reading a field of undefined',
    renameNothing.isError === true && !/Cannot read propert/.test(JSON.stringify(renameNothing.payload)),
    renameNothing.payload);

  const renameNowhere = await call('renameEvaluate', { uri: CLASS_URL, line: 1, startColumn: 0, endColumn: 1 });
  check('renameEvaluate answers a position that names nothing with a diagnosis',
    renameNowhere.isError !== true
    || /refactoring|rename|Failed to evaluate/i.test(JSON.stringify(renameNowhere.payload)),
    renameNowhere.payload);

  const extractJunk = await call('extractMethodPreview', { proposal: 'not json' });
  check('extractMethodPreview refuses a proposal that is not one',
    extractJunk.isError === true && !/Cannot read propert/.test(JSON.stringify(extractJunk.payload)),
    extractJunk.payload);

  const extractNothing = await call('extractMethodEvaluate', {
    uri: CLASS_URL, range: JSON.stringify({ start: { line: 1, column: 0 }, end: { line: 1, column: 3 } })
  });
  check('extractMethodEvaluate answers a range that is not a statement with a diagnosis',
    extractNothing.isError !== true
    || /refactoring|selection|Failed to evaluate/i.test(JSON.stringify(extractNothing.payload)),
    extractNothing.payload);

  // A bare CLAS is what a caller writes by hand; it used to be refused as an
  // unknown type by every tool that resolves a URL from a name.
  const bareType = await call('revisions', { objectName: CLASS_NAME, objectType: 'CLAS' });
  const fullType = await call('revisions', { objectName: CLASS_NAME, objectType: 'CLAS/OC' });
  check('a bare object type resolves the same object as the full one',
    bareType.isError === fullType.isError
    && JSON.stringify(bareType.payload.objectUrl) === JSON.stringify(fullType.payload.objectUrl),
    { bare: bareType.payload.objectUrl, full: fullType.payload.objectUrl });

  const deleteNothing = await call('deleteObject', {});
  check('deleteObject asks which object rather than guessing',
    deleteNothing.isError === true && /Pass objectUrl/.test(JSON.stringify(deleteNothing.payload)),
    deleteNothing.payload);

  // Last of the group: it ends the stateful session, and everything after it
  // logs on again by itself.
  const dropped = await call('dropSession');
  check('dropSession succeeds and says what it forgot',
    dropped.payload.status === 'success'
    && typeof dropped.payload.locksForgotten === 'number'
    && typeof dropped.payload.sourcesForgotten === 'number',
    dropped.payload);

  const afterReads = await call('listLocks');
  check('the read-only checks took no lock', afterReads.payload.count === 0, afterReads.payload);

  // A second server, started the way an operator would start a narrowed one.
  // The whole tool list is the largest single thing this server sends, and
  // this is the check that narrowing it actually narrows it.
  const narrowed = await toolsListOf({ SAP_TOOLS_PROFILE: 'min' });
  check(`SAP_TOOLS_PROFILE=min serves fewer tools than the full list (${narrowed.length} of ${tools.length})`,
    narrowed.length > 0 && narrowed.length < tools.length);
  check('a narrowed server still serves healthcheck, so it can say what it is',
    narrowed.some(tool => tool.name === 'healthcheck'));
  check('a narrowed server drops the groups the preset leaves out',
    !narrowed.some(tool => tool.name.startsWith('debugger') || tool.name.startsWith('traces')));
  check('a narrowed tool list is smaller in characters, which is the point of it',
    JSON.stringify(narrowed).length < JSON.stringify(tools).length);

  const named = await toolsListOf({ SAP_TOOLS_INCLUDE: 'impactOf' });
  check('SAP_TOOLS_INCLUDE serves a single tool named on its own',
    named.length === 2 && named.some(tool => tool.name === 'impactOf'),
    named.map(tool => tool.name));

  const graphProfile = await toolsListOf({ SAP_TOOLS_PROFILE: 'graph' });
  check(`SAP_TOOLS_PROFILE=graph serves the analysis tools and nothing that writes (${graphProfile.length} tools)`,
    ['abapGraph', 'callsFrom', 'impactOf', 'abapPath'].every(name => graphProfile.some(tool => tool.name === name))
    && !graphProfile.some(tool => ['setObjectSource', 'deleteObject', 'activateSafe'].includes(tool.name)),
    graphProfile.map(tool => tool.name));

  const atcProfile = await toolsListOf({ SAP_TOOLS_PROFILE: 'atc' });
  check(`SAP_TOOLS_PROFILE=atc serves the checks (${atcProfile.length} tools)`,
    atcProfile.some(tool => tool.name === 'atcCheck') && !atcProfile.some(tool => tool.name === 'abapGraph'),
    atcProfile.map(tool => tool.name));

  const typo = await callOn({ SAP_TOOLS_INCLUDE: 'source,sources' }, 'healthcheck', {});
  check('a token in the tool lists that matches nothing is named rather than silently ignored',
    (typo.payload.profile.unknownTokens || []).includes('sources'),
    typo.payload.profile);

  const refused = await callOn({ SAP_TOOLS_INCLUDE: 'impactOf' }, 'packageTree', { packageName: PACKAGE_NAME });
  check('a tool left out of the list is refused when called anyway',
    refused.isError === true && /not in SAP_TOOLS_INCLUDE/.test(JSON.stringify(refused.payload)),
    refused.payload);

  console.log(failures === 0 ? '\nall smoke checks pass' : `\n${failures} smoke check(s) failed`);
  child.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch(error => {
  console.error('smoke run failed:', error.message);
  child.kill();
  process.exit(1);
});

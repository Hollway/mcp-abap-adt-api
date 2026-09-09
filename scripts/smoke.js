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
                      'findInSource', 'sourceOutline', 'editObject', 'createAndWrite', 'runTests',
                      'createDataElement', 'createDomain', 'getDataElementProperties',
                      'getDomainProperties', 'transportDetails', 'typeHierarchy', 'whereUsedMethod',
                      'objectEnhancements', 'getTextElements', 'atcDocumentation',
                      'getMessages', 'getMessageLongtext', 'setMessages', 'createMessageClass',
                      'getStructureSource', 'createStructure',
                      'packageTree', 'readSources', 'searchInPackage', 'atcCheck',
                      'changePackagePreview', 'rapGenIsAvailable']) {
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

  const atcNothing = await call('atcCheck', {});
  check('atcCheck asks what to check',
    atcNothing.isError === true && /What should be checked/.test(JSON.stringify(atcNothing.payload)),
    atcNothing.payload);

  // A package walk. SMOKE_PACKAGE should be a package that holds objects;
  // ZMM_BASE on the system this was written against holds 906.
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

  const afterReads = await call('listLocks');
  check('the read-only checks took no lock', afterReads.payload.count === 0, afterReads.payload);

  console.log(failures === 0 ? '\nall smoke checks pass' : `\n${failures} smoke check(s) failed`);
  child.kill();
  process.exit(failures === 0 ? 0 : 1);
})().catch(error => {
  console.error('smoke run failed:', error.message);
  child.kill();
  process.exit(1);
});

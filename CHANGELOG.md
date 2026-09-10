# Changelog

This fork adds tools, guardrails and tests on top of the upstream server. Every
version below was developed against live SAP systems (a classic ERP system, an
S/4 system and a read-only QA system), and the entries record what the backend
actually does — not what its documentation implies.

The versions here were never published to npm: `package.json` stays on the
upstream `0.1.1`, and the numbers below are the history of this fork.

## [0.8.0] — a call graph over usageReferences

Tools 176 → **177**, tests 635 → **643** in 39 suites. Read-only smoke run: 146
checks.

### A path between two objects

- **`abapPath`** answers whether one object's code reaches another, and
  through what: breadth-first over `usageReferences`, walking backwards from
  the target through its callers until it reaches the start or runs out of
  budget (`maxDepth`, default 8; `maxNodes`, default 300). The first path
  found is the shortest one, because BFS visits every object at distance N
  before any at distance N+1. Each step in the answer carries the places
  inside it that call the next one — the same `places` `impactOf` already
  reports, just followed as a chain instead of rolled up one level. Pure ADT
  data, no ABAP parsing: a call made only dynamically (`CALL METHOD (name)`)
  is invisible to it, exactly as it is to `usageReferences` itself.
- Two objects that turn out to be the same one answer instantly, with no
  backend call at all.

### `impactOf` fetches its own snippets

- **`snippets`** on `impactOf` fetches the source of the places actually
  listed, in the same call — one more request to `usageReferenceSnippets`,
  scoped to what depth 1 shows rather than to the raw backend answer, which
  for a widely used class is the difference between a handful of snippets and
  hundreds. Indirect (`depth=2`) places never get one.
- The correlation between a place and its snippet never leaves this call:
  `objectIdentifier` matches a place to its snippet internally and is
  stripped from every answer, with or without `snippets` set.

## [0.7.0] — calling existing code, and the dictionary in full

Tools 171 → **176**, tests 457 → **635** in 39 suites. Read-only smoke run: 141
checks.

### Calling code that already exists, with parameters

- **`callFunction`** takes a function module name and parameter values, reads
  the signature, generates the call and runs it through a throwaway class in
  `$TMP`. The answer carries exporting/changing/tables by name, `sy-subrc`
  turned back into the **name** of the classic exception, a class-based
  exception with its T100 text, the real row count of every table, and whatever
  was substituted for a generic type.
- **`callMethod`** does the same for a **static** method. The signature has to
  come from the class source: `classComponents` lists methods but not their
  parameters. An instance method is refused with a pointer to `runSnippet`.
- Values are checked against the signature **before** anything is sent: an
  unknown parameter name or a missing mandatory one is refused with the list of
  what the call accepts. Otherwise a typo would come back as a compile error in
  code nobody wrote.
- Both **execute code** on the system as the connected user, so they count as
  writing tools and are hidden in read-only mode. Results are **not** kept by
  default: the generated code ends in `ROLLBACK WORK` unless `commit` is passed.
  A function module that commits on its own cannot be rolled back — the tool
  description says so.
- Results travel through `CALL TRANSFORMATION id` and are printed base64 between
  markers: the console is a formatted channel, free to break a long line, and a
  break inside a field value would corrupt it silently.

### The dictionary in full

- **`tableFields`** returns the fields of a table or structure with includes
  **expanded**: for a large purchasing-item table that is 702 fields against the
  307 its own definition lists. Each field carries position, key and `NOT NULL`
  flags, data element, domain, type, length, decimals, check table, unit or
  currency field, conversion exit and the text in the logon language.
  `keysOnly`, `fields` and `maxFields` keep hundreds-of-fields tables usable.
- **`tableIndexes`** and **`tableKeys`** return secondary indexes with their
  fields in order, and foreign keys with check table, what fills its key,
  cardinality and whether the value is checked on input.
- All of it is **read-only** — nothing is executed. The dictionary is most often
  needed on exactly the systems where nothing may be run.
- A domain's value table is **not** passed off as a field's check table: it is
  not one, and saying so would be worse than saying nothing.

### What the data preview endpoint turned out to require

Two limits, both found by running against a live system, shaped every query:

- **255 characters per query**, counting the whole query. Splitting across lines
  does not help: a newline there is not even whitespace, and the parser reads a
  table name with a newline and `WHERE` as one identifier. So columns are
  requested densely, `ORDER BY` is dropped where sorting can happen afterwards,
  and name lists are cut by what fits rather than by count.
- **Spaces are required around `=`.** `tabname='EKPO'` is rejected with "a
  logical expression is required at positions starting from TABNAME=". Commas in
  the select list do not need spaces.

Three columns are also not named the way they sound: `DD12L` has no
`UNIQUE_SQL`, `DD05S` calls the position `PRIMPOS` and has no `CHECKFIELD`, and
`DD08L` keeps cardinality in `CARDLEFT` and `CARD`, not `CARDLEFT`/`CARDRIGHT`.

### Seven defects the live runs found

Each one passed the unit tests and was wrong against a real system.

1. **A generic type cannot be declared.** Half the standard function modules
   type a parameter that way — `CONVERSION_EXIT_ALPHA_INPUT` takes `CLIKE` — and
   `DATA` refuses it. A concrete type is now substituted, and the substitution
   is reported in the answer. Unqualified character types are widened too:
   `DATA x TYPE c` compiles and means `C(1)`, so a value would have been
   silently truncated to one character.
2. **`LIKE` becomes `TYPE`, and a `TABLES` parameter becomes a table.**
   `DDIF_FIELDINFO_GET` declares `TABLES DFIES_TAB LIKE DFIES`, and both halves
   were being taken literally: a dictionary type cannot be referenced through
   `LIKE`, and a `TABLES` parameter needs a table, not one of its rows.
3. **You cannot ask at runtime whether a result is a table.** `lines( )` of a
   non-table is a syntax error, and so is `ASSIGN` into a field symbol of
   `TYPE ANY TABLE`. Every call with an elementary exporting parameter died
   there. Row counting stays with `TABLES`, where the table is known.
4. **A table is not serialised as `<item>` rows.** When it has a named row type,
   asXML names the rows after it, and a table arrived as a structure with one
   component. A repeated name is now read as a table, and
   because a one-row table of a named type is indistinguishable from a
   structure, the generated code asks RTTI which results are tables and reports
   it.
5. **A type declared inside a class must be qualified.** A method taking
   `CHANGING ct_x TYPE tt_x` cannot be called from outside without
   `zcl_something=>tt_x` — the snippet was refused with "type TT_X is unknown".
   Class types are collected and qualified, including inside composite
   expressions. `BEGIN OF … END OF` components are deliberately not collected: a
   component named `MATNR`, mistaken for a type, would turn every `MATNR`
   parameter into a class-qualified type that does not exist.
6. **`TYPE p` is left alone.** Widening it means guessing the decimals, and the
   guess is wrong in both directions: `DECIMALS 4` made a timestamp method
   reject its argument, `DECIMALS 0` would silently cut the fraction off a
   quantity. The ABAP default is at least documented.
7. **An exception class name arrives as an absolute type.** RTTI answers
   `\CLASS=CX_...`, and only the class name is wanted.

**Not verified live:** `commit: true` — no run committed on purpose.

## [0.6.0] — function modules, an ABAP console, revisions, impact, class members

Tools 162 → **171**, tests 284 → **457** in 33 suites. Read-only smoke run: 121
checks.

This is where wrapping the library ran out: of the 158 public `ADTClient`
methods, 12 remain uncovered, and all 12 deliberately (`activate` is replaced by
`activateObjects`/`activateByName`/`activateSafe`, `syntaxCheck` by
`syntaxCheckCode`, `changePackageExecute` is preview-only, eight `rapGen*` by
`rapGenIsAvailable`, `objectStructureElements` is a helper). Everything added
after this the library cannot do at all.

### Function modules

- **`getFunctionModule`, `listFunctionGroup`, `createFunctionModule`.** You
  could not ask about a function module with what you actually have in hand:
  `CALL FUNCTION 'Z_SOMETHING'` gives a name, and every endpoint wants the
  **group**. The signature is worse: ADT serves it as the first statement of the
  source rather than the `*"` block SE37 shows, so answering "what does this
  module take" meant reading the whole source and parsing ABAP by eye.
- `getFunctionModule` takes one name, finds the group and returns the signature
  as data: importing / exporting / changing / tables / exceptions with types,
  defaults and a pass-by-value flag (`VALUE(NAME)` versus a bare name is easy to
  read backwards). The body is not returned by default.
- `listFunctionGroup` lists a group's modules, includes and global data. So does
  `nodeContents`, but every row there carries a SAP GUI bridge link padded to 30
  characters, multiplying the size of the answer for no added information.
- `createFunctionModule` creates a module in an existing group together with its
  interface — otherwise the signature cannot be set, since it lives in the
  source text. A missing group is refused with a pointer to what creates one.

### ABAP console

- **`runSnippet`** executes a piece of ABAP and returns what it printed. There
  was nothing to execute code with: `runQuery` reads only SELECT, `runClass`
  needs an existing class implementing `IF_OO_ADT_CLASSRUN`. So the fragment is
  wrapped in such a class, created in `$TMP`, activated, run and deleted.
- This **executes code** as the connected user: the tool counts as writing and
  is refused in read-only mode. A fragment that does not compile comes back with
  the activation messages, the line, and the source that was written.

### Revisions and version comparison

- **`revisions`** rewritten: takes a name and type (the URL still works),
  returns the newest 20 instead of the whole history, and filters by author,
  transport and description. On a class with a long history that is tens of
  thousands of characters saved on the question "what changed last". It also
  names what the backend does not: what it calls the "version" is the
  **transport request**, and the version number lives only in the content
  URI.
- **`compareRevisions`** shows what changed between two versions as a unified
  diff. A side can be a revision number, a request number, or the words
  `active` / `inactive` / `latest`, so an edit that is written but not activated
  is visible too — version history does not show that at all.
- The diff uses the **patience algorithm** rather than plain LCS: ABAP source is
  full of repeats (`ENDIF.`, `ENDMETHOD.`, blank lines), and a minimal LCS pairs
  one method's `ENDMETHOD` with another's, so inserting a method reads as
  rewriting two unrelated ones. Only lines occurring once on each side anchor.

### Impact analysis

- **`impactOf`** answers what depends on an object or on one of its methods:
  objects, the places inside them, each one's package, worst first.
  `usageReferences` answers the same question with a flat list that is really a
  tree — on a widely used class it runs past the response cap. Uses from test
  includes are marked, standard SAP is counted but hidden by default, and
  `depth=2` goes one step further and names the caller it arrived through.

### Class members

- **`addMethod`, `addAttribute`, `deleteMethod`.** A method lives in two places
  in one source, so adding one by hand is two `patchObjectSource` edits whose
  line numbers must both still line up after the first. The signature is passed
  as data, the ABAP is assembled here, and the indentation is taken from the
  class. The edits are planned and handed to `editObject`, so the lock cycle,
  diff and activation check are the ones already proven.
- Where it refuses instead of guessing: the method already exists (with line
  numbers), the class has no such visibility section, no IMPLEMENTATION part, no
  `ENDMETHOD`, or a `METHODS:` chain line declares two methods at once —
  deleting part of it would rewrite someone else's declaration. A single entry
  in a chain is removed, closing the chain if it was the last.

### Tool descriptions

- **112 of 171** tools carried upstream one-line stubs ("Runs a class.", "Lock
  an object", "Deletes a trace."). The description is the only thing a model
  picks a tool by, and not one measured limit had made it in. They are now
  detailed where behaviour is non-obvious (locks, deletion, activation,
  transports, debugger, refactorings, reading data) and one exact line where the
  name speaks for itself — descriptions are paid for on every request.
- Now stated outright: a lock handle dies with the session and must be released
  **before** activation; `activateObjects` can answer success and leave the
  object inactive; deletion does not release the lock; `validateNewObject`
  answers 200 with an empty body on some collections; `runQuery` is SELECT only;
  `tableContents` returns data, not fields; `searchObject`'s `objType` filter
  silently loses subtypes such as `FUGR/FF`; `gitPullRepo` overwrites the
  package's objects; releasing a request is irreversible and changes another
  system. Plus the debugger order of work: breakpoints → listener → start the
  program **from outside**, because this server cannot start it.

### Small things and dead code

- The trailing loop in the package walk was unreachable: a subpackage found at
  the depth limit lands in `notWalked` where it is seen, so the level the walk
  ends on is always empty. Removed.
- **The source cache was never invalidated**: after `deleteObject` it still held
  the deleted object's text, and `syntaxCheckCode` reuses that text — so
  checking an object that no longer exists answered "all fine". `forgetUnder`
  now drops everything belonging to the object.
- Three source-map addresses that had no test got one, including the only one
  never verified by reading — `DCLS/DL`, for which no object exists on any of
  the systems available; the address comes from discovery, and the code says so.

### Six defects these runs found

1. A class include with no history answered "Revision URL not found for object
   X" — as if a class with a long history had none at all. The refusal now
   names the includes that do have one.
2. Comparing the two newest versions often comes out empty by default: releasing
   a request leaves a copy with identical text. That is now said, rather than
   read as "the last change did nothing".
3. `FUGR/FF` matched the `FUGR/F` family prefix in impact parsing and hid the
   group it belongs to.
4. A standalone include was reported as a place inside itself.
5. Search with `objType=FUGR/FF` answers an empty list: quick search does not
   accept that subtype. The search now runs unfiltered and the type is selected
   on this side.
6. Body assembly ate the caller's indentation — an `IF` block turned into a
   flat list. Fixed in class method assembly too.

Plus two found by a fragment that dumps: **a dump takes the session with it**
(the run answers 500, the next call an empty 400), so the cleanup right after it
failed — and every failed fragment left its class behind in `$TMP`. Deletion now
logs in again and retries. The 500 itself says nothing: the cause is in the dump
feed, a ten-thousand-character ST22 HTML page, from which six fields and the
failing source line are now extracted.

## [0.5.0] — SE91 messages, tables and structures, package-wide work, ATC

Tools 152 → **162**, tests 174 → **284** in 25 suites. Read-only smoke run: 90
checks.

### Messages (SE91)

- **`getMessages`, `getMessageLongtext`, `setMessages`, `createMessageClass`.**
  What `MESSAGE e001(zfoo)` raises was unreachable: `objectStructure` calls
  exactly the endpoint that carries the messages and throws them away, keeping
  the general metadata. So a report written through this server could raise
  messages that do not exist, and a message class could not be filled.
- Four backend facts, measured live, shaped the tools. Messages live **inside
  the class document** and nowhere else: the individual message resource answers
  an empty stub to any GET. The only write that works is a **PUT of the whole
  document** under the class lock; PUT and DELETE on a message resource are
  refused with "Message X is not locked" for any handle. Messages are **merged
  by number**, so writing one leaves the rest alone — and therefore **a message
  cannot be deleted through ADT**. The class header, by contrast, is
  **replaced**, so a write without the current description wipes it:
  `setMessages` reads first.
- A message text is an XML attribute, and almost every real message contains
  `&1`, `&2`. Without escaping, the backend fails the whole parse and writes
  nothing.
- The long text can be read (`?language=E`, with no fallback to another
  language) but **not written** — that resource has no PUT. No activation is
  needed: the text is in T100 as soon as the answer comes back.

### Tables, structures and CDS

- **`getStructureSource`** returns a table or structure definition: the DDL text
  plus a parsed field list with types and key flags. There was no other way to
  read a table's fields: `searchObject` returns a SAP GUI bridge link for a
  table, `objectStructure` only metadata. `TABL/DT` and `TABL/DS` both come from
  the `ddic/structures` collection.
- **`createStructure`** creates a structure and sets its fields in one call,
  with a syntax check between write and activation: the dictionary error names
  the field and the reason, whereas the same trouble from activation arrives as
  a localised phrase about reference tables. Two release-dependent things are
  therefore not guessed: the **opening keyword** is taken from the stub the
  backend just created (`define type` on classic ERP, `define table` on S/4),
  and the **reference in a unit or currency annotation** is qualified with the
  structure name (`'mseg.meins'`, not `'meins'`) — hence `unitField` and
  `currencyField`.
- **`createAndWrite`** learned where CDS view (`DDLS/DF`) and structure
  (`TABL/DS`) sources live, so both are one call now.
- **What cannot be created, and why** — refused with a reason instead of a 404.
  A transparent table: the library's type map POSTs to `/sap/bc/adt/ddic/tables`,
  a collection classic ERP does not have at all, and the technical settings are
  not in the source form either. A package: `/sap/bc/adt/packages` is not served
  at all — only `packages/settings` — so creating, name-checking and even reading
  an existing package answer 404.

### Package-wide work

- **`packageTree`, `readSources`, `searchInPackage`.** The first question about
  an unfamiliar development ("what is in this package, and where is this string
  used") was the most expensive one: a level from `nodeContents`, a guess at
  which objects matter, then a read and a search per object.
- `packageTree` walks the tree breadth-first and resolves where each object's
  source lives — without that the list is useless, because for most types
  `nodeContents` hands back a SAP GUI bridge link that serves properties and no
  content. Hitting the limit leaves the upper levels complete and names the
  packages left unopened. An unknown package is distinguished from an empty one,
  which object properties cannot do: the bridge URL answers 200 and echoes any
  invented name back. Only a repository search knows.
- Two collections are not where they look: transformations are served from
  `xslt/transformations`, not `xslt/sources`; metadata extensions (`DDLX/EX`)
  have no collection at all, so the type is not registered — better than an
  address that can only 404.

### ATC

- **`atcCheck`** runs the checks over an object or package with a readable
  report: priority, rule, message and source line, worst first. Running one was
  impossible: `createAtcRun` POSTs to `/sap/bc/adt/atc/runs?worklistId=` and the
  library puts the argument it calls "variant" — a variant name — there, so the
  backend answers 500 with no explanation. The ID has to come from
  `atcCheckVariant`, which, despite its name, opens a worklist and returns its
  ID. A package is addressed by its SAP GUI bridge link:
  `/sap/bc/adt/packages/ZFOO` is refused with "No URI-Mapping defined for URI".
- The `atcCheckVariant` and `createAtcRun` descriptions now say what those tools
  actually do.

### Fixes

- **A validation answer with no verdict is no longer read as a refusal.** The
  library scores success as `!!CHECK_RESULT || !!SEVERITY`, and the message-class
  endpoint answers validation with 200 and an empty body — so both creation
  paths refused a free name with "The system refused the name: see the validate
  step", having created nothing.
- **`objectEnhancements`: a positive answer finally seen.** The earlier
  conclusion "the endpoint answers, but empty" was wrong — it was the objects,
  which had no enhancements. Real ones answer with their implementations, the
  elements inside them and each insertion line. An empty answer now says where
  to look for such objects: `ENHINCINX`.

### Domains and text elements: writing verified on S/4, two wrong assumptions exposed

- **`setDomainProperties` and `setDataElementProperties` now take and release
  the lock themselves** and activate on request. They used to demand a handle
  and refuse without one, pointing at `createDomain` — no help for an existing
  object: changing one field turned into a three-call chain. A handle passed in,
  or a lock this process already holds, is still used as is and not released.
- The text-element tool had been written blind: on classic ERP
  `/sap/bc/adt/textelements` does not exist at all, so the code had never run
  against a working backend. Two things it got wrong: **the text resource must
  be locked, not the object** (with a program lock the write is refused 423,
  naming the text pool, not the program — the old hint sent you the opposite
  way), and **a write leaves two rows inactive**, the object (`PROG/P`) and its
  text pool (`PROG/PX`); one activation by name closes both, while activation by
  the object URL would never see the `PROG/PX` row.

### A fix found along the way: the inactive list was read in the wrong session

`inactiveObjects` went through the stateless clone like every other read — and
sessions **disagree** about that list. After a text write and its activation,
the session that did the work saw nothing inactive while the clone kept showing
the program, three reads running, with the object provably active. That list is
asked precisely to learn whether an edit reached the system, so an answer from
another session turns finished work into "not activated yet". It is now read on
the stateful client, where `activateSafe`'s own check reads it.

## [0.4.0] — dictionary, texts, enhancements, composite tools

Tools 135 → **152**, tests 117 → **174** in 18 suites. Read-only smoke run: 57
checks.

### New tools — dictionary

- **`createDataElement` and `createDomain`** create the object and set its
  definition in one go: name check, create, lock, read the metadata the system
  assigned, write the definition, unlock, activate with verification.
  `createObject` handles `DTEL/DE` and `DOMA/DD`, and that was the trouble: you
  got a typeless object that will not activate and surfaces as an error the next
  time the package is touched. There is no rollback — the answer shows which
  step it stopped at and what state the object is in. A data element's type is
  either a domain or a built-in type, not both; labels are cut to the lengths
  SAP allows (10/20/40/55) and the answer says which were cut. A package other
  than `$TMP` without a transport request is refused before creation.
- **`getDataElementProperties` / `setDataElementProperties`,
  `getDomainProperties` / `setDomainProperties`** read and change the
  definition. A PUT replaces the definition wholesale, so a change is passed as
  a patch and applied over what is in the system now.

### New tools — what the source does not show

- **`getTextElements` / `setTextElements`** — text symbols, selection texts and
  list headings. They live outside the source, so `getObjectSource` never showed
  them, and a program written through this server came out with unnamed
  selection-screen fields.
- **`objectEnhancements`** — the enhancement implementations active on an
  object, with the insertion point and, on request, the source. Reasoning about
  a standard include from its own source alone is wrong: what runs is the source
  plus what enhancements inject, and the text does not show them.

### New tools — navigation and transport

- **`transportDetails`** — what is inside a request: its tasks and every object.
  That list used to be fetched with a `SELECT` from `E071` through `runQuery`.
- **`typeHierarchy`** (ancestors and descendants of a class or interface) and
  **`whereUsedMethod`** (callers of a method). Both take a name: the backend
  answers by cursor position, and counting line and column in a source you have
  not read is exactly what kept `usageReferences` unused. The position is found
  in the source, a declaration is preferred over an implementation, and the
  answer quotes the line it landed on.
- **`atcDocumentation`** (the rule text behind a worklist link),
  **`changePackagePreview`** (what moving an object to another package would
  mean — preview only: the library has no `evaluate` step, the document has to
  be assembled here, and running that unverified against a live package is not
  worth it) and **`rapGenIsAvailable`**.

### New tools — whole chains in one call

- **`createAndWrite`** creates an object and writes its source in one call, with
  activation and verification. Half of that pair is worse than neither: an
  object with no source will not activate, and that surfaces later and to
  someone else. It knows where the source lives for `CLAS/OC`, `INTF/OI`,
  `PROG/P`, `PROG/I`, `FUGR/F`, `FUGR/FF` and `FUGR/I`.
- **`runTests`** activates, runs the tests and explains the result: how many
  methods ran, how many passed, and every failure with class, method and ABAP
  Unit message. Against an inactive object the tests do not run at all, and the
  answer to that is an empty list, which reads as "everything passed".

### Fixes the live runs found

- **Objects are created in the logon language, not EN.** The library puts
  `language="EN"` in the creation document and makes it the original language,
  and SAP files every text of the object under it — a data element was created
  "successfully" and read back with an empty description and four empty labels.
  There is now a `language` parameter, defaulting to the logon language.
- **`transportDetails` works on a backend that answers with a list.** The
  library asks `/cts/transportrequests/<number>` and reads one request from the
  answer; this system ignores the number and returns the user's whole request
  list, so the parse found nothing — a released request with seven objects
  showed as empty. The request is now found in the list, a task number resolves
  to its request, and a request that is not there is named as such.
- **The lock handle comes from the registry.** `unLock`, `setObjectSource`,
  `createTestInclude` and `deleteObject` demanded it even though the server
  holds it — a three-call chain could not be run without carrying the handle by
  hand.
- **The registry finds a lock that covers the URL.** A class include (tests,
  local definitions) is written under its own URL while the lock belongs to the
  class, so looking the write URL up found nothing. The longest held lock whose
  URL is a prefix of the requested one now answers.
- **`changePackagePreview` no longer corrupts the protocol.** The library prints
  its argument with `console.log`, and stdout is the MCP channel; `console.log`
  is redirected to stderr for the duration of the call.
- **Every call in a writing chain stays in the session holding the lock.** A
  routing audit caught `createAndWrite` reading through the stateless clone.

### System limits established live

- **Domains are not served through ADT on classic ERP**:
  `/sap/bc/adt/ddic/domains/...` answers 404 for any name, including the
  validation resource, while data elements on the same system work normally.
  `createDomain` stops at the name check, so it creates nothing, and explains
  why.
- **Text elements are unavailable there too**: `/sap/bc/adt/textelements` is
  absent entirely. Both tools explain that rather than looking like a typo in
  the object name.

### Internal

- New modules: `lib/ddicProperties` (dictionary documents assembled by pure
  functions, so "what is not mentioned is preserved" is testable without a
  system), `lib/symbolPosition` (a name's position in the source) and
  `lib/lockCycle` (taking and releasing a lock — three tools did it their own
  way).

## [0.3.0] — crooked endpoints and reading source

Tools 132 → **135**, tests 61 → **117**. Smoke run: 30 checks.

### New tools

- **`editObject`** walks the whole edit chain in one call: lock, edit, unlock,
  activate, verify. The order matters — an object your own session holds cannot
  be activated — and every step can fail in its own way. There is no rollback:
  on failure the source stays in an inactive version the system does not run,
  and the answer shows how far it got.
- **`findInSource` and `sourceOutline`** read source as text. ADT can only find
  a fragment of a class, so finding a subroutine in a report used to mean
  reading the whole source through the caller — and asking `fragmentMappings`
  for a type the backend does not know is one way to kill the session.
  `sourceOutline` returns a table of contents (`REPORT`, `CLASS`, `METHOD`,
  `FORM`, `MODULE`, `FUNCTION`, `INCLUDE`, event blocks) with line numbers;
  `findInSource` searches for text or a regular expression and, with
  `searchIncludes`, walks a report's includes.

### Crooked endpoints that are honest now

- **`activateByName` no longer reports what it wishes were true.** The library
  call answers `success: true` for objects that stayed inactive; the handler now
  re-reads the inactive list and reports `verified` and `stillInactive`,
  lowering `success` if the object is still there. Prefer `activateSafe` anyway.
- **`createObject` refuses `PROG/I` outright** and names the replacement
  (`createInclude`) — the backend used to answer 400 or 500, and the error read
  as a wrong package.
- **`fragmentMappings` rejects a type that is not a type** (`FORM`, for example)
  before touching the system, and on a backend refusal says where to go:
  `CLAS/OM` for a class method, `findInSource` for everything else.

### Fixes the live runs found

- **The `patchObjectSource` anchor is matched against the source's line
  endings.** ADT serves this system's sources with CRLF while an anchor is
  written with plain newlines, so no multi-line anchor ever matched. The
  replacement text was already translated; the anchor is now too.
- **The package for activation is looked up.** The inactive-object list leaves
  `adtcore:parentUri` empty for a program, and activation without it is refused
  — a finished edit failed on the last step over a value the system knows
  perfectly well (`findObjectPath` names the package).

## [0.2.0] — reliability, guardrails, first tools

Tools 127 → **132**. There were no tests at all — now **73** in 7 suites, plus
`npm run smoke` (19 stdio checks against a live system, read-only).

### Reliability

- **ADT errors keep SAP's diagnostics.** Every handler used to repack the
  exception into an axios message ("Request failed with status code 400"), and
  anything that was not an `McpError` became "Internal server error". An error
  now carries `status`, `adtType`, `t100`, `localizedMessage` and `diagnostic`:
  `sap` for a real refusal, `transport` for an HTTP failure SAP never answered.
- **The ADT session recovers itself.** `abap-adt-api` does not re-login while
  the client is stateful, and this server kept it stateful always — so a dead
  session meant every later call failed until `login` was called by hand. The
  server recognises the pattern, reconnects, and retries reading calls once,
  marking the answer `sessionRecovered`. Writing calls are never retried: the
  session is restored, but the caller is told the lock handle is dead.
- **Reads go through a separate session.** Reading calls run on a stateless
  clone, so the library recovers them itself and they do not disturb the
  stateful session holding the locks. Writes, locks and the debugger stay on it.
- **`healthcheck` actually checks.** It reaches the system and reports which one
  it is connected to, the session state, the tool profile, metrics and response
  time — instead of an unchanging "healthy".
- **`login`, `logout` and `dropSession` return a valid result.** `login`
  returned no text at all, so the client rejected the answer against the schema
  even though re-authentication had succeeded.

### New tools

- **`patchObjectSource`** changes part of an object: the server reads the
  current source, applies the edits (line range, exact text fragment or an
  insertion) and returns a unified diff — a small change no longer costs a full
  re-upload. `dryRun` shows the result without writing.
- **`activateSafe`** activates and then verifies that nothing was left inactive.
- **`listLocks` / `unlockAll`** show the locks the process holds and release
  them at once; they are also released when the server stops.
- **`createInclude`** creates an include program (`PROG/I`), which
  `createObject` cannot: the library does not pass the main program reference.

### Fixes the live runs found

- **`deleteObject` releases the deleted object's lock**: ADT does not, and the
  registry entry went on pointing at an object that no longer existed.
- **The `patchObjectSource` diff describes the edit honestly**: an insertion
  showed a spurious blank line and lost a context line.

### Convenience

- `getObjectSource` takes `version` (`active` / `inactive` / `workingArea`) —
  the active version was unreachable through the tool before.
- `unitTestRun` explains an empty result rather than leaving it to be read as
  "everything passed".
- `userTransports` returns a flat list with filters on status, owner, number and
  description; `raw` returns the original structure.
- `runQuery` and `tableContents` take `offset`.
- Object and array parameters are declared as such and parsed: flags, the class
  to evaluate, references, proposals, configurations and breakpoints were all
  declared as strings and reached the library unparsed.

### Operations

- `SAP_READONLY` refuses every changing tool, `SAP_READONLY_ALLOW` lets
  individual groups or tools through that fence (for example `debugger` — a
  system nobody develops on may still need debugging), and
  `SAP_TOOLS_EXCLUDE` hides whole groups; tools carry `readOnlyHint` and
  `destructiveHint`. Excluding a group beats allowing it.
- An answer larger than `SAP_MAX_RESPONSE_CHARS` is replaced by an envelope with
  the size and a truncated fragment.
- `LOG_LEVEL` (default `warn`) instead of a metrics line on every request;
  metrics moved into `healthcheck`; an unused rate limiter was removed.
- On start-up the server prints which system it connected to, and warns when the
  settings came from `.env` rather than from the client.

## [0.1.1] — uniform response shape

- Tool answers brought to a common shape.

## [0.1.0] — first commit

- Initial project structure.

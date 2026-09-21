# Changelog

This fork adds tools, guardrails and tests on top of the upstream server. Every
version below was developed against live SAP systems (a classic ERP
system, an S/4 system and a read-only QA system), and the entries record what
the backend actually does — not what its documentation implies.

The versions here are not published to a registry; the numbers track the work
rather than a release.

## [1.8.0] — the debugger, and the session it was holding

Measured against the tool list again: of the 186 tools this server exposes, 48
are never named by the smoke run, and every one of them writes or changes
state — which a read-only run cannot exercise by definition. The largest island
inside that remainder is the debugger — fourteen
tools, one narrow fix in its whole history, and no run from breakpoint to
variables ever. It was driven by hand this time against a live classic ERP
system, with a class and a report of my own in `$TMP` and three different ways
of triggering them.

The debugger turned out to be unusable here for a reason that has nothing to do
with debugging, and then unusable for a second reason that has everything to do
with the system.

### The listener that held the whole server

`debuggerListen` answers only when a process stops at a breakpoint, and
`abap-adt-api` sends that request with a timeout of 360000000 ms — one hundred
hours. It waited on the stateful client, which is the session the locks and
the source writes travel on, and SAP serialises the requests of one session. So
a listener with nothing to trigger it did not merely wait: it queued every
writing tool behind it, for as long as nobody hit the breakpoint. Its own tool
text told the caller to "run the program from somewhere else", and there was no
somewhere else — a client drives this server one call at a time, measured here
as two runs that never overlapped (one ended 09:49:57, the next started
09:50:05).

The debugger has a SAP session of its own now, opened when a debug session
starts and closed when it ends. The listener waits there, for `waitSeconds` at
a time (60 by default, 900 at most), and the call comes back saying the
listener is still registered and still waiting. Calling again rejoins the same
listener rather than starting a second one, which the backend refuses anyway.
Proof from the live run: while a listener was waiting, the main session created
a class, activated it, ran it and deleted it again, answering at 10:21:16.

Deleting a listener deliberately does *not* go through that session: the DELETE
has to overtake the listener's own pending POST, and inside the same session it
would queue behind exactly the call it is meant to end.

### The answer that arrived while nobody was waiting

The first version of the bounded wait threw away what it did not wait for. A
listener started at 07:20:04 answered at about 07:24, minutes after the wait
had returned; the state treated that listener as spent and the next call
started a new one — and had a process really been standing stopped, it would
have stood there with nobody coming to attach to it. The answer is kept now and
handed to the next call, which says `caughtWhileNotWaiting` and that the
process is held until somebody attaches or terminates it.

### Three and a half minutes, not a hundred hours

The hundred-hour timeout never applies on this landscape. The listening POST
was cut with **504** after about three and a half minutes by the proxy in front
of the system, and the listener died with the connection. A bare "Request
failed with status code 504" says nothing about that, so a gateway timeout on
the listening call now reports how long it waited, that the answer came from
what sits in front of the system rather than from SAP, and that another
listener has to be started.

### A breakpoint the backend accepts and nothing honours

The backend accepted every breakpoint and answered with the resolved ids —
`INCLUDE=ZMCP_DBG_WORK...CM001.LINE_NR=6` for a class of mine,
`INCLUDE=LMRFCU05.LINE_NR=14` for a standard function module. Nothing ever
stopped:

- a background job that ran the report (10:22:02 to 10:22:05, status finished);
- a task started with `CALL FUNCTION ... STARTING NEW TASK`, twice, the second
  time with `systemDebugging` on;
- the class executed directly through `runClass`.

So on that system external debugging delivers no debuggee to an ADT listener,
and `debuggerAttach` and everything downstream of it cannot be reached at all.
Both tool texts say so now: a breakpoint the backend accepts is not a
breakpoint that stops anything, and it is worth proving once with something
harmless before relying on the debugger for real work. (The trigger had to be a
standard function module because `createFunctionModule` cannot make one
remote-enabled — the flag is a property, not source.)

### A 404 that means "nobody is registered"

Cleaning up after the run broke a smoke check that had been green for months.
`debuggerListeners` answered **404** — `ExceptionResourceNotFound`, "Resource
does not exist." with the resource named as a blank — and went on answering it
on a fresh session. The service was fine: every other debugger call still
answered its usual 500. What had changed was that the last listener
registration for this user was now gone, and the backend refuses the listeners
resource itself when there is none, rather than answering an empty list.
Measured both ways within the hour: 200 while a listener was registered, 404
from the moment it was deleted. The check had been passing on a registration
left behind by earlier work.

That 404 is read as the answer it is now: no listener, no registration, and
what to do about it.

### The settings that were always the defaults

`debuggerSaveSettings` declared `settings` as a **string** and handed it
straight to the library, which destructures the six flags out of whatever it is
given. A string has none of them, so every flag fell back to its default and
two calls with different JSON sent byte-identical bodies. It takes an object
now — the six flags are named in the schema, a JSON string is parsed — and the
answer reports what was actually sent.

### A frame number the tool could not express

`debuggerGoToStack` takes a stack URI *or* a frame number, and the library
picks the endpoint by the type: a string is checked against the URI pattern, a
number goes to the older `setStackPosition`. The schema had only a string, so
naming frame 1 was refused by the client with "Invalid stack URL: 1", and on a
system that reports no stack URIs at all — this one — the tool had no usable
form. It takes both now and refuses anything else by naming both.

### What a failure says when nothing is attached

Every debugger call that needs an attached session answers the same thing
otherwise: 500 `AdiFailed`, "Обнаружена особая ситуация" — an exception was
raised — in the system's language, whether the session is missing, the debuggee
is gone or the release cannot do it. Measured on the stack trace, the
variables, a step, a frame change and the settings. The one thing this server
knows for certain is whether *it* attached anything, so that is what the
message adds.

`debuggerDeleteBreakpoints`, `debuggerVariables` and `debuggerChildVariables`
also passed their structured arguments through unparsed, the way the settings
did; they go through the same JSON parsing as the rest now.

### What the smoke run now watches

Four checks for the debugger refusals that never leave the process — a frame
that is neither form, a run-to-line step with no line, settings as text — and
the listener read that reports whether this server is holding a debug session.
311 checks before, 315 now, all of them green on a live run; 1,176 tests
before, 1,197 now; 48 tools the smoke run never named before, 45 now.

## [1.7.0] — the reads nothing watched, the writes nothing had run, and what an operator reads

The smoke run was measured against the tool list again: of 183 tools it
reached 104, and 79 it had never called. Twenty-six of those only read —
among them every tool repaired in 1.6.0, so those repairs had nothing
watching them. The rest write, which a read-only smoke run cannot exercise
at all, so they were driven by hand against a live system instead: a
transport of my own, created and deleted; trace configuration on my own user,
created and deleted; a throwaway class in `$TMP` for the refactorings that
rewrite source; and the refusal paths of abapGit, the ATC exemption workflow
and OData publishing, none of which this system runs.

Six defects came out of the reading run and four out of the writing one. Then
three new tools for what an operator looks at, which had no answer here at
all.

### The package an object is in

`changePackagePreview` was refused by the backend with *"Package assignment of
object ZCL_APP changed since the refactoring started"* — a message that sounds
like a race and is not one. The package of an object was read as the **first**
`DEVC` step of its workbench path, and on a nested tree that is the
superpackage: a class in `ZAPP_BASE` under `ZAPP` came back as `ZAPP`, so the
refactoring was built against a package the object is not in. It is read from
the object's own step now, which names its package in `parentUri`. The same
lookup fills in the `parentUri` an activation needs, which was getting the
same wrong package.

### The type name a caller writes by hand

`atcCheck` with `objectType: 'CLAS'` answered *"atcCheck does not know the ADT
URI of a CLAS"*. The URL map is keyed by the full ADT type — `CLAS/OC` — which
is what a repository node carries, and not what someone naming an object
writes. The bare transport types are completed in one place now, so every tool
that resolves a URL from a name takes both.

### A session that was never there

`dropSession` failed every time it was the first call. The library sends its
drop request without the auto-login the normal path has, and reads run on the
stateless clone, so the stateful client had usually never logged in and the
backend answered 401 for a session that did not exist. It drops only when
there is something to drop, treats an unauthenticated answer as the state it
wanted to reach, and clears its own bookkeeping either way: the lock handles
taken in that session died with it, and the registry went on offering them to
the next write.

### The lock a deletion needs

`deleteObject` refused unless a lock was already held. That is friction with
no safety in it — the caller has just asked for the object to be deleted — and
it broke the obvious cleanup after `createAndWrite`, which releases its lock
when it is done: deleting the class this server had created a minute earlier
failed with *"no lockHandle given and none recorded"*. It takes the lock
itself now.

### Findings that could not be followed

An ATC finding carries the id the exemption tools take — the backend calls it
`quickfixInfo`, `atcExemptProposal` calls it `markerId` — and the report
dropped it, so nothing `atcCheck` answered could be fed to the exemption
chain. It is reported when the system gives one.

`atcRequestExemption` answered *"Cannot read properties of undefined (reading
'rangeOfFindings')"*: the library destructures the proposal two levels down.
The shape is checked first now, the way the repository and refactoring
parameters already are.

`atcContactUri`, `atcChangeContact` and both service binding publishers
answered 404 for collections this system does not serve at all — the exemption
approval workflow, and OData publishing. Each 404 read as a fact about the
finding or the binding that was named. They say which of the two it is.

### Two names for one transport

The transport family had grown two spellings of one parameter:
`transportNumber` in the tools wrapping the library, `transport` in the ones
written here. A call to `transportReadiness` with the other name answered
*'"undefined" is not a transport request number'* — a complaint about the
value for what is a difference in spelling. Every transport tool takes both.

`transportAddUser` answers with three `tm:` fields whose number is the **new
task**, not the request that was passed: adding a user to a request answered
with a task number, and the next call then found two open tasks to choose
between with nothing having said a second one had appeared. The answer says so
now.

### stdout belongs to the protocol

`abap-adt-api` prints its change-package refactoring with a plain
`console.log`, and the workaround was a swap of `console.log` around that one
call. Over stdio, stdout carries the protocol, and any other dependency
printing anywhere would corrupt it the same way. Everything `console` prints
goes to stderr for the whole process now.

### What an operator reads: `backgroundJobs`, `spoolRequests`, `applicationLog`

SM37, SP01 and SLG1 have no ADT endpoint. Their tables do, and the data
preview reads a table without executing anything — so these three work on a
system where nothing may run, and need no developer key. `backgroundJobs`
answers the jobs with their status in words and, with `withSteps`, the program
and variant of each step and the spool request it produced; `spoolRequests`
answers the requests, their owner, device and whether they are complete;
`applicationLog` answers the log headers with the message counts each one
holds.

Three things the live run settled, all of them in the answers rather than in
the code:

- a job start time arrives as six digits and its date as an ISO string at UTC
  midnight, so both are read as what they are rather than through `String()`;
- `TSP01` records the spool stamp in **UTC** while a job time is local — on a
  system three hours ahead, the spool a job had just produced read three hours
  older than the job, so the field is called `createdUtc` rather than converted
  with a guess at the time zone;
- the message **text** of an application log cannot be read this way at all:
  `BALDAT` holds it as a compressed cluster rather than as rows. The headers
  carry the counts and say where the text is not.

Filters are checked before they reach the statement, both ways round: a name
that is not a name is refused, and so is a SELECT that would exceed the 255
characters the data preview accepts.

### What the smoke run now watches

Twenty-five checks for the reads it had never called, four for the refusals of
the writing tools — the ones that never leave the process — and eight for the
three new tools. 271 checks before, 311 now; 1,097 tests before, 1,176 now.

`transportInfo` is checked either way round on purpose: a standard SAP class
answers it with the backend's own refusal, because recording a change to an
SAP object needs a modification licence, and that is the tool working while an
empty success would not be.

### Left undone, deliberately

`transportRelease` can only be verified by releasing a real request into the
landscape, which is irreversible; it stays unverified rather than tested on
something that cannot be taken back. The debugger — thirteen tools — needs a
session sitting on a breakpoint, which is a person at a keyboard, not a script.

## [1.6.0] — the tools nobody had ever called, and the questions before a release

Ninety-three of the 180 tools had never been reached by a smoke run. Forty-six
of those only read, so they were called against a live system one after
another and their answers compared with what their descriptions promised. What
follows is what came back. Three new tools answer the questions that get asked
before a transport is released; everything else in this release is an answer
that was already being given, and was wrong or unreadable.

### Tools that could not work at all

`classIncludes` threw `clas.includes is not iterable` on every call ever made
to it. Its schema takes a class name; the library method behind it is a pure
function over a class structure, and a name has no `includes` to iterate. The
structure is read first now, and an object that has no includes - a program,
say - is told so and pointed at `mainPrograms`.

`syntaxCheckTypes` answered `{}` on every system it has ever run on. The
library hands back a `Map`, and `JSON.stringify` writes a `Map` as `{}`. It
answers with the flavours themselves now: two of them on a classic ERP system,
each with the object types it accepts.

`packageSearchHelp` declared its type as a free string where the endpoint
takes exactly four names — `applicationcomponents`, `softwarecomponents`,
`transportlayers`, `translationrelevances` — and anything else answers 404. The
four are in the schema, and a classic ERP release, which serves none of them,
is reported as a release without the endpoint rather than as a bad request.

### Answers that were empty but looked like answers

Six reads answered success with nothing in it, which is indistinguishable from
a real empty result:

- `featureDetails`, `collectionFeatureDetails` and `findCollectionByUrl` each
  answered `{"status":"success"}` and no field at all, for a title that exists
  and for one that does not alike. They say `found: false` now, with the
  nearest titles or addresses and how many there were to choose from.
  `collectionFeatureDetails` turned out to match template links rather than
  collection addresses — `/sap/bc/adt/oo/classes`, a collection that plainly
  exists, is found by nothing there — which is now said rather than implied;
- `objectTypes` answered an empty list as a successful retrieval. The endpoint
  behind it keeps only the named items carrying a type and a `usedBy` field,
  and a classic ERP release sends neither, so nothing ever survives the parse.
  It says so and points at `loadTypes`;
- `ddicRepositoryAccess` answered an empty list for a name the dictionary does
  not know, and for an address rather than a name;
- `syntaxCheckCdsUrl` called a view that does not exist clean: the backend
  answers an empty message list, which is exactly what a passed check looks
  like. The object is confirmed first;
- `inactiveObjects` was the one tool of the server answering with a bare array.

### Object-shaped parameters, checked before the library reads a field of undefined

`checkRepo`, `renamePreview`, `fixEdits` and `bindingDetails` each ended in
`Cannot read properties of undefined` — a TypeError reported as a transport
error — when handed something that was not the object the library
dereferences. Three of them declared that object as a **string** in their own
schema, so the wrong shape was what the schema asked for. Each now names the
fields that are missing and the call that produces them.

Every abapGit read says the plugin is absent the way `gitRepos` already did:
`/sap/bc/adt/abapgit/...` answering 404 is a system without abapGit, not a
failed call.

### Catalogues, cut to a size that can be read

Three discovery reads handed back the whole system. Measured on a classic ERP
system: `loadTypes` **141,045 characters**, `adtDiscovery` **42,033**,
`adtCompatibiliyGraph` **29,039**. Each now answers with a summary over the
whole catalogue — totals, categories, namespaces — plus one filtered page, so
a narrowed answer can never be read as a complete one. `classComponents` did
the same with 13,501 characters of backend tree for one class, and now answers
a component list filtered by name, type and visibility.

`abapDocumentation` and `atcDocumentation` answered with whole HTML pages -
13,893 characters of doctype, head and icon links around a few paragraphs of
help - and answer with the text now, the page only when `html` is set.
Quick-fix proposals arrived with their descriptions escaped twice over
(`&lt;p&gt;Starts the rename wizard`) and are decoded, keeping every field
`fixEdits` needs so a row can be handed straight back.

### An answer about something else entirely

`transportsByConfig` with an address no configuration has was not refused by
the backend: it dropped the filter and answered with **every transport request
in the system**, 327,499 characters, shaped exactly like the answer for the
configuration that was asked about. The address is checked against
`transportConfigurations` first, and a system with no configurations at all is
said to have none.

`atcCheckVariant` posts to the worklist endpoint, and that endpoint answers
with an id whatever name it is given: a variant invented on the spot got one,
the empty string got one, and the same name got a **different id on every
call**. The run started on such a worklist fails several calls later with a
bare 500, and nothing connects that failure to the name. Code Inspector keeps
the variants in `SCICHKV_HD`, so the name is checked there first and refused
with the global variants of the system named. A name outside `A-Z`, digits,
underscore and the namespace slash is refused before it can travel into the
query string.

### What the data preview actually accepts

The freestyle SQL endpoint refuses a statement longer than **255 characters**,
and says so as "Maximum number of characters in a row exceeds 255" — which
reads as a limit on the rows of the result rather than on the query. Measured:
250 characters answer, 292 do not, and wrapping the text over several lines
changes nothing, because the whole statement is counted. `runQuery` now checks
the length before the call and names the ways out; the limit is in the schema,
where a caller composing a join can see it.

### Three questions asked before a transport is released

- **`transportReadiness`** — a verdict per check: the status and owner of the
  request, tasks still open under it, an empty request, objects that also sit
  in other open requests, objects with an inactive version saved and never
  activated, and locks this server still holds. A task number is resolved to
  the request above it.
- **`transportConflicts`** — the objects of a request that are also recorded
  in somebody else open request, which is the case where the later release
  overwrites the earlier work. On one customizing request measured live, 49 of
  its 79 objects sat in 110 other open requests under 24 owners. Each object
  costs a read, so the number examined is capped and the answer says how many
  were left out.
- **`objectTransports`** — every request one object has travelled in, newest
  first, including the entries recorded under its parts (REPS and REPT for a
  report, METH and CLSD for a class) which a search by the object name alone
  never shows. One report came back with eleven requests under three owners.

The activation check reads `REPOSRC` and the dictionary tables rather than
ADT, because ADT cannot answer it: `objectStructure` reports version `active`
for an object whose inactive version was saved years ago, and asking for
version `inactive` explicitly answers with the active one rather than with
nothing. A class is recorded in `REPOSRC` under its name padded with `=` to
thirty characters plus a part suffix, which is how one request came back with
ten parts of a class saved and never activated.

### Smaller things said plainly

`mainPrograms` answers for program and function-group includes only, and a
class include is now told so instead of getting a bare 404. `findObjectPath`
maps repository objects, not packages, which is what "No URI-Mapping defined
for URI" meant. The ATC reads that answer a wrong id with a bare 500 say where
a run result id and a marker id come from.

### Numbers

183 tools (180 before), 1,097 tests in 63 suites (1,032 in 60), 271 smoke
checks (237). The tool list grew from 166,279 to about 176,000 characters -
three new tools and the descriptions that record what the twenty-odd fixed
ones actually do. Profiles remain the cheaper answer: `graph` 27 tools,
`atc` 23, `min` 21.

## [1.5.0] — the answers that never fitted, and the ones that were not answers

Every tool in this release was picked the same way: by calling it against a
live system and comparing what came back with what its description promised.
Two families had never been called by the smoke run at all, which is why what
follows was there to find.

### Where-used, cut to a size that can be read

`usageReferences` reaches an endpoint with no paging of its own. Measured on a
classic ERP system, `CL_ABAP_TYPEDESCR` answers with **40,660 rows and
21,075,252 characters** — a hundred times the response cap, so the tool could
only ever hand back a truncated blob. A class picked for being rarely used,
`CL_ABAP_GZIP`, still answers with 256,575.

Two things make that payload what it is, and both are dealt with now:

- a row averages some 500 characters, most of it ADT bookkeeping — who is
  responsible, the description, the package URI — around the hundred that
  identify the place. Rows are trimmed to name, type, package, uri and the
  `objectIdentifier` the next call needs;
- the list is a tree flattened: one row per package, per object, per include.
  Only the rows carrying an `objectIdentifier` are usage sites, and
  `usageReferenceSnippets` silently drops every row without one — so a caller
  handing back the grouping rows gets an empty answer and no reason for it.

The answer is now a summary over the whole result — rows, usage sites,
objects, packages, counts by type, the heaviest packages — and one page of
rows, steered with `maxResults`, `offset` and `onlyWithSnippets`. Snippet rows
that carry no identifier are refused with the reason rather than answered with
nothing. The fetch still costs the backend what it costs; what is saved is the
reading.

### A cursor checked before a call is spent on it

The position-taking calls were pass-throughs, and the backend answers a wrong
position without saying it was wrong:

- a line counted from 0 instead of 1 answered confidently about a **different
  class**, and nothing in the answer said so;
- a cursor on blank space answered `{url: "", line: 0, column: 0}` with status
  200 — an answer shaped like a result;
- a line past the end of the source answered HTTP 500;
- `codeCompletion` answered `[]` for both, which reads as "nothing may be
  written here" rather than "you are not pointing at the source".

The position is now checked against the source before the call, the name under
the cursor is quoted back in the answer, and nothing found is said as
`found: false`. Lines count from 1 and columns from 0, which is now written in
the schema rather than left to be discovered.

The source these calls take is the text the backend parses, so **a page of a
source is not a smaller source but a broken one**: the first 400 lines of
`CL_SALV_TABLE` — the page a caller would naturally read — answer "The source
code of this class is incomplete". `source` may now be omitted, and then the
whole stored source is read, from the session cache when it is there.

`codeCompletionFull` answers a single string, not the "proposals with the text
to insert and the position to insert it at" its description promised;
`patternKey` is the `IDENTIFIER` of a `codeCompletion` proposal, and a value
naming no proposal makes the backend raise rather than answer empty. Both are
written down now, a blank key is refused, and an empty answer says so.
`prettyPrinterSetting` answers two settings — indentation and case style — not
the three the description implied.

### Three answers that did not fit, and three that were not answers

- **`nodeContents`** answers a whole level at once: `SABAPDEMOS` holds 802
  nodes and 238,596 characters, past the cap. A node writes the same SAPGUI
  bridge URI twice, as `OBJECT_URI` and `OBJECT_VIT_URI`. The level is now
  counted by object type and returned one trimmed page at a time, with
  `maxResults`, `offset` and `objectType`.
- **`dumps`** answers six entries in 61,644 characters, because each carries
  its whole ST22 page — 11,739 characters for the first. Headers only by
  default, with the runtime error and the program that died pulled out of the
  categories; `full: true` for the pages themselves, `max` for the count.
- **`ddicElement`** answers `T000` with its 17 fields and a data element with
  an empty shell and status 200 — the same answer a name that does not exist
  gets. Which is precisely what the tool said it was for: "a data element, a
  domain or a type". It reaches the CDS element-info endpoint, it answers for
  entities with fields, and it now says `found: false` with where to go
  instead.
- **`unitTestEvaluation`** without a class read `testmethods` off `undefined`,
  and the TypeError left as a *transport* error — a diagnosis pointing at the
  network for a missing argument.
- **`gitRepos`** and **`annotationDefinitions`** answer 404 "Resource … does
  not exist" where the collection is simply not installed on this release.
  That is not the same as having nothing to list, and both now say which.
- **`atcCheck`** over a standard SAP object answered "No findings at all" —
  a clean bill of health for an object the backend had dropped from the run,
  as its own run info said: "SAP object(s) were excluded from ATC check run".
  The exclusion is now quoted and explained.

### `atcDocumentation`, verified at last

It was the only tool never confirmed against a live system: the run used to
answer 500 for a check variant name where a worklist id belongs, and once that
was fixed there was still no finding to follow, because the object under check
was a standard one and those are excluded. A custom class on the same system
answered with 115 findings over three priorities, and the documentation of the
first — the 075 master-language check — came back as the HTML the backend
writes.

### Which build is answering

The version was told to the client once, on `initialize`, where a caller
cannot ask again — so "is this process running what I just compiled" was
answered by calling a tool and watching how it behaved. The version alone
cannot answer it anyway: every build inside a working session carries the same
number, and several servers share one build directory. `healthcheck` now
carries a `server` block with the version, the modification time of the file
the process actually loaded, and the time that process started. Both answers
carry it, the failing one included — that is when it is needed most.

### Checks

1,032 tests in 60 suites, and 237 smoke checks against a live system — 41 of
them new. Twenty cover the navigation family and nineteen the reading tools
neither had ever been called by a smoke run, which is exactly where the
defects above were sitting. One of them was found by the smoke itself rather
than by the probe that preceded it: the truncated source.

## [1.4.0] — the rows an endpoint really returns, and the shape drawn

### The two data preview endpoints count rows their own way

`runQuery` and `tableContents` reach two different ADT endpoints, and neither
of them behaves the way the tools said. Measured live, on a table every system
has:

- **`UP TO n ROWS` in the query text is ignored.** `SELECT … UP TO 3 ROWS` with
  no `rowNumber` answered with a hundred rows; the same query with
  `rowNumber: 3` answered with three. The only cap the backend honours is the
  `rowNumber` query parameter — and the tool description used to advise the
  opposite, so following it cost a hundred rows of every selected column.
  A limit written into the text is now read out and applied as `rowNumber`.
- **`tableContents` answers with `rowNumber + 1` rows.** It reads one row past
  the cap to see whether anything follows, then hands that row over as if it
  had been asked for: `rowNumber: 1` returned two rows, `4` returned five. The
  extra row is now trimmed and spent on the answer it was fetched for.
- **The filter of `tableContents` is not a `WHERE` clause.** A bare condition
  is refused — "Only the SELECT statement is allowed" — although both the tool
  and its parameter described the argument as a filter. A condition is now
  completed into `SELECT * FROM <entity> WHERE <condition>`, and the answer
  says what was actually sent (`sqlRewritten`).

Both tools now answer with a `rows` block: how many rows came back, which cap
produced that number (`rowNumber`, `upToRows` or the library's default
hundred), and whether the result stopped at the cap. `more: true` means a row
beyond the cap was really seen; `more: 'unknown'` means the result merely
filled the cap exactly, which is all the freestyle endpoint behind `runQuery`
can ever say.

Two things that were measured and turned out to be fixed already, recorded
because the opposite was believed for a year: two `runQuery` calls in one
message no longer break the session, and a query naming a field that does not
exist answers with SAP's own diagnosis and leaves the session alive. Both were
cured by moving reads onto the stateless clone.

### `abapGraph` draws, and says which packages it leans on

- **`diagram: "mermaid" | "dot"`.** A shape is easier seen than read out of
  sixty edges. The picture holds the heaviest edges and says what it left out;
  entry points and orphans are marked, and a hub is marked only when more than
  one object calls it — the hub list is the five most called, which in a small
  package is everybody, and a picture where every box is marked says nothing.
- **`resolveOutside`.** The targets outside the package were names, which is
  not the answer to what a package depends on: the answer is the packages
  those names live in. They are now looked up and grouped, at one quick search
  per name, which is why it is asked for rather than assumed. A function module
  never resolves this way — the repository search does not index modules by
  their own name — and the answer says so instead of leaving it to look like a
  missing object.

### Two more profiles, and a server that admits which build it is

| Profile | Tools | Tool list | What it serves |
| --- | --- | --- | --- |
| `graph` | 27 | 29k | Understanding a system nobody documented: `abapGraph`, `callsFrom`, `impactOf`, `abapPath`, where-used, and the reads that feed them. |
| `atc` | 23 | 16k | Quality checks: the ATC group, plus enough navigation to reach the object a finding points at. |

Both are written tool by tool rather than by group, because the analysis tools
sit in `codeAnalysis` next to completion and syntax checks, and the reads sit
in `source` next to the writes.

A token in `SAP_TOOLS_INCLUDE`, `SAP_TOOLS_EXCLUDE` or `SAP_READONLY_ALLOW`
that matches neither a group nor a tool used to narrow the server in silence —
a misspelled group serves fewer tools than intended, a misspelled exclusion
hides nothing while looking like a fence. `healthcheck` now names them, and
every preset is checked against the real tool list in a test.

And the version the server announces on `initialize` was a literal: it said
1.0.0 while the package was at 1.3.0, so the one place a client can ask which
build it is talking to answered with a number nobody had shipped. It is read
from the package now.

### Checks

995 tests in 56 suites, and 196 smoke checks against a live system — 17 of
them new, covering the query tools, which had never had a live check at all.
That absence is how an endpoint ignoring `UP TO` and another returning a row
more than asked for both went unnoticed.

## [1.3.0] — the graph of a whole package

### `abapGraph`: a package, not an object at a time

`callsFrom` answers for one object. Asked for every object of a package, the
answers stop being a list and become a shape — and that shape is the thing
worth having:

- **entry points**, the objects nothing inside the package calls, which is
  where work comes in from outside;
- **hubs**, the objects everything calls, which is what cannot be changed
  cheaply;
- **orphans**, connected to nothing, which is where dead code shows;
- **cycles**, the circles the calls run in;
- **what the package depends on outside itself**, gathered from every object
  rather than looked up one at a time.

A function module is matched to the group that defines it, which the group's
own source says: `CALL FUNCTION 'Z_APP_SAVE'` names a module, and the package
list names a group, so without that step the edge would point outside the
package it is inside. A call an object makes to itself is counted on the
object and left off the graph.

The cost is one source read per object — a function group also reads its
includes — so this is a call to make once for a package being worked on, not
a lookup. Sources this session already read are reused (`fresh` reads them
again, for a package changed from ADT since), the answer says how many came
that way, and every budget it stops at is named rather than left to look like
the package is smaller than it is. Statements are quoted only with `places`.

### The tool list is context, and now it can be narrowed

180 tools are described to the model before it is asked anything: about
158,000 characters, spent on every session, most of it on tools that session
will never call. `SAP_TOOLS_EXCLUDE` could hide a group, which is the wrong
way round when what is wanted is ten tools out of a hundred and eighty.

`SAP_TOOLS_INCLUDE` serves a list and nothing else, and `SAP_TOOLS_PROFILE`
names a ready-made one: `min` (21 tools, 22k — find an object, read it, walk
its package), `ddic` (40, 47k), `read` (79, 86k — everything that reads) and
`dev` (132, 130k — no debugger, traces, ATC, git, RAP or service bindings).
Exclusion still wins over inclusion, a tool left out is refused if called
anyway and says what is served instead, and `healthcheck` is served whatever
the list says: a server that cannot say which system it is on is a worse trade
than one extra tool. It reports `toolsExposed`, `toolsTotal` and
`toolListChars`, so the cost of the list is a number rather than a guess.

No tool was merged away to make the list shorter. Names that are already being
called keep working; the four parameter lists of `createFunctionModule`, which
were the same schema written out four times, are the one piece of length that
was duplication rather than knowledge.

### Two answers that read as success and were not

**An activation reports what it did not do.** `activateByName` checks itself
against the name it was given, and with `mainInclude` it activates exactly one
include per call — so a program with five changed includes answered
`verified: true, stillInactive: []` four times over while it was still
inactive. The answer now carries `othersInactive` as well: what is still
inactive that this call did not cover. `activateSafe` reports the same, for
the same reason.

**A syntax check on an include was an error about the wrong object.** This
backend reads the content it is given as the main program, so an include's own
text came back as `REPORT/PROGRAM statement missing` — a syntax error on an
include that is perfectly fine. An include is compiled as part of its program
and cannot be checked any other way, so for an include URL the main program is
looked up, its stored source is what gets checked, and the answer says so in
`checkedAgainst` (write the include first: what is not saved cannot be checked
this way).

Two more things that call needed and would not say: the source, which it now
reads when it was neither passed nor read this session, and `mainUrl`, which
for anything that is not an include can only ever be the URL itself — a check
on a class with nothing but its URL used to be refused outright.

### What a declaration reaches

`callsFrom` read statements that act — a call, a select, a perform — and not
the ones that only declare. A report that types its work area over `ZORDERS`
and passes it to a function module was reported as depending on the function
module and not on the table, though changing the table is what breaks it.

Declarations are read now, under the new kind `type`:

- `TYPE zorders`, `TYPE zde_order_id`, `LIKE zorders-id`, and the same over a
  table type: `TYPE STANDARD TABLE OF zorders`, `TYPE RANGE OF zorders-id`;
- `SELECT-OPTIONS s_id FOR zorders-id` and `RANGES`, where the dictionary name
  is the only thing that says what the selection is over.

`TYPE REF TO` stays out: it is already read as the class behind a reference,
and so as the calls made through it — reporting it again would say the same
thing twice. So do the built-in types, which are the language rather than the
dictionary, and every name the source declares itself, because `TYPE ty_row`
is local and only the declarations tell the two apart. A type owned by a class
(`TYPE zcl_return=>tt_return`) remains a `reference` to that class.

### Macros are named instead of passing silently

A macro expands to code that is not on the line that expands it. The body of
one defined in the object's own source was already scanned, so what it reaches
was found — but whatever the call site passes in was not, and nothing said so.
A line that expands a macro the object defines is now reported as `unresolved`
with the kind `macro`, naming the macro and the line it was defined on. A
macro defined in a type pool or an include that was not read still cannot be
recognised at all: there, the word is a word like any other.

## [1.2.0] — what an object calls, read from its own source

`impactOf` and `abapPath` both answer the same question from the same data:
who calls this. The backend has no answer for the other direction. ADT has
none either — the arrows in its dependency diagrams come out of the same
where-used index, read one object at a time — so the only place the answer
exists is the source text.

`callsFrom` reads it. Given an object it returns what that code reaches,
grouped by target, with the line and the statement each call was found in:

- static and instance method calls, the instance ones resolved through the
  `TYPE REF TO` the source declares — a call written `lo_ref->add( )` names no
  class anywhere on that line, and the declaration is the only thing that does;
- an interface-qualified call is reported against the **interface**
  (`lo_ref->zif_log~write( )` is a dependency on ZIF_LOG), because that is the
  edge that survives a change of implementation;
- `NEW`, `CREATE OBJECT` and `RAISE EXCEPTION TYPE`;
- `CALL FUNCTION`, `PERFORM … IN PROGRAM`, `SUBMIT`, `CALL TRANSACTION`;
- database tables, from `SELECT`/`JOIN`/`UPDATE`/`INSERT`/`MODIFY`/`DELETE`
  and from `TABLES`;
- `INHERITING FROM`, `INTERFACES` and `INCLUDE`;
- `zcl_x=>co_value` and `zcl_x=>ty_row`, which are a dependency on the class
  without being a call, kept apart under the kind `reference`.

Each finding carries a `kind`, and `kinds` narrows the answer to the ones
wanted. Targets outside `Z*`, `Y*` and `/namespace/` are counted rather than
listed, as in `impactOf`: a class that calls `CL_GUI` and `CX_ROOT` everywhere
would otherwise bury its own dependencies.

### What it does not know, said rather than hidden

A name assembled at runtime cannot be resolved before the program runs, and a
reference whose type is declared somewhere else cannot be resolved from this
source alone. Both are reported in `unresolved`, with the reason and the line:
`CALL METHOD (lv_class)=>(lv_meth)`, `CALL FUNCTION lv_fm`, `SELECT … FROM
(lv_table)`, a chained call on what another call returned, a variable this
source never declares. A missing edge that is named can be settled with
`usageReferences` on the suspected target; a missing edge that is silent
reads as proof that nothing is there. Macros are not expanded, and no target
is checked against the repository.

### Statements, not lines

The scan works on logical ABAP statements. `CALL FUNCTION` with its parameters
runs over a dozen lines and `SELECT` often carries its `FROM` on the next one,
so a line-by-line regular expression would miss both. Chain statements are
split into their parts, each keeping the line it was written on, and a period
inside a literal ends nothing.

A function group is read together with its includes whether or not
`followIncludes` was passed: its own source holds nothing but `INCLUDE` lines,
and every function module body lives in one of them. Sources read together are
also scanned together: a group declares its globals in the TOP include and uses
them in another, so every call through `gs_screen-handler` would otherwise be
unresolvable. Each source still prefers its own declarations, because a name
reused in one include means what that include says it means. They are served under the
group (`/functions/groups/<group>/includes/<include>`), with the report include
collection as a fallback; one that cannot be read is reported by name instead
of losing the rest. A program's includes are read only when asked, because
each is a call of its own.

### Fixed along the way: a string template was cut short

`codeOf`, which strips comments before any scan, knew `'` literals only. ABAP
has three delimiters, and a `"` inside a string template is not a comment —
`|{ "id": 1 }|`, the everyday way JSON is built, was cut at the first quote.
It now tracks `'`, `` ` `` and `|` with their escapes, which also fixes
`findInSource` with `skipComments` and `sourceOutline` on any line that builds
a template containing a quote.

## [1.1.0] — text elements on a system that serves none, and the transport they travel in

`getTextElements` and `setTextElements` were written against an endpoint that
half the releases do not have. On the classic ERP system
`/sap/bc/adt/textelements` is not there at all — ADT itself reaches text
elements there only through the SAPGUI bridge — so both tools answered 404 and
the texts of a program written through this server stayed as numbered fields and
empty selection screens.

They now fall back to the text pool: `READ TEXTPOOL` and `INSERT TEXTPOOL`, run
as a snippet in a throwaway class. Every answer says which way it went in `via`
(`adt` or `textpool`).

### What the pool actually holds

Measured on two systems rather than guessed: a scan of 1,835 standard reports
yielded exactly five `ID` letters — `I` text symbols, `S` selection texts, `R`
the program title, `T` the list header, `H` the column headers. Three of them
contradicted what the fallback was going to assume:

- **`headings` is two letters at once.** ADT answers it as five elements —
  `listHeader` (the `T` row) and `columnHeader_1..4` (the `H` rows, keys
  `001..004`) — and answers with all five even when the program has none. The
  fallback fills the missing ones in as empty texts, because that is what the
  endpoint does.
- **The program title is not in any category.** ADT never serves the `R` row, so
  neither does the fallback; the title cannot be changed over ADT at all.
- **The eight characters in front of a selection text are flags, not
  indentation.** A `D` in the first position means the text comes from the data
  dictionary. Writing eight blanks over them — which is what "pad the text to
  the stored width" would have done — cuts that link without saying so. An
  update therefore keeps the flags the row already has, and the lookup happens
  inside the generated ABAP, against the pool as it stands at the moment of the
  write.

### Writing

- Read, change and write happen **in one snippet**. `INSERT TEXTPOOL` replaces
  the pool whole, so a write built on a pool read in an earlier call would drop
  every text of the categories the call is not about.
- `STATE 'A'` writes the active version outright: this path needs neither a lock
  nor an activation, which is the one way it is simpler than the ADT one.
- The category is replaced by default, as over ADT. The new `merge` changes only
  the elements named and leaves the rest of the category alone.
- `LENGTH` is the declared maximum, not the length of the text: it comes from
  `maxLength` when given, otherwise from the text. A text longer than that
  maximum **widens the length instead of being cut**, and the answer says so in
  `notes` — losing the tail of a text silently is the worse of the two.
- An empty text removes its row rather than writing an empty one, because a
  program without a list header has no `T` row at all.
- A `transport` is honoured by registering the object in the request — see
  below; `INSERT TEXTPOOL` itself registers nothing, and a text that is in no
  request simply stays in this system.

### Where the fallback is decided, and where it is refused

- On a write the 404 arrives at the **lock** of the text elements resource,
  before anything is written, so the decision is taken around the whole ADT
  attempt rather than inside the write.
- Running ABAP is a write whatever it is used for — reading the pool creates,
  activates, runs and deletes a class — so the read-only fence stands **inside
  the fallback branch**. A read-only server refuses the ABAP way and says why,
  while the ADT read, which changes nothing, keeps working. `getTextElements`
  stays out of the mutating list for exactly that reason.
- A function group keeps its texts in `SAPL<group>` and a class in its class
  pool (`<NAME>` padded to thirty with `=` plus `CP`); the fallback resolves the
  program accordingly.
- `language` accepts either form — the one-character SAP key (`R`) or the
  two-character ISO code (`RU`, converted by the system, because the mapping is
  not "take the first letter": Chinese is `ZH` and `1`). Without it, the
  language of the session.

### What the live run found

`|{ lv_prefix }| && text` looks like the obvious way to put the eight flag
characters in front of a selection text, and it is wrong: a string template
converts the C field and **drops its trailing blanks**. The bug showed itself
twice on the same day, from both ends.

- **A new selection text lost its first eight characters.** With no existing
  row the flags are eight blanks, the template turned them into nothing, and
  the bare text went in at offset 0 - so the read, cutting eight characters off
  as it must, handed back `"ck in the plant"` for a text that read
  `"Stock check in the plant"`. Writing it a second time made it worse: the corrupted
  row's first eight characters were now letters, and they were carried over as
  flags.
- **An existing text with a dictionary flag came back as the last two letters
  of itself.** The `D` landed straight against the text - `DText` instead of
  `D       Text` - and the read cut into the text.

So `setTextElements` could edit an existing unflagged text and nothing else.
The flags now go in by offset, which keeps every blank:

```abap
ls_new-entry(8) = lv_prefix.
ls_new-entry+8 = `text`.
```

A test holds the string template out of that spot. Nothing else in the
generated ABAP interpolates a character field whose blanks matter - the row
printing drops only the trailing blanks of a text, which are padding.

### registerInTransport, because INSERT TEXTPOOL registers nothing

A pool write goes straight into the database, so the change stayed in the
system it was made on — and the first version of this only said so in a note.
A live task hit exactly that: the request held the *includes* of a program, the
text pool belongs to the main program, and the selection text would not have
travelled.

The new tool registers an object in a request over
`TR_APPEND_TO_COMM_OBJS_KEYS`. What it holds:

- **It wants the task, not the request.** A request number is accepted by the
  parameter and achieves nothing, so a request is resolved to the caller's own
  open task in it. Somebody else's task is refused with the request to pass
  instead, and two open tasks of one user are refused rather than guessed
  between.
- **`sy-subrc = 0` is not proof.** `RS_CORR_INSERT` — the obvious alternative,
  and unusable from an ADT class anyway: it answers `CANCELLED` whatever it is
  passed — answers plausibly and registers nothing, and this module leaves
  `SCTS_CTO_CUST_SYNC/003` in `sy-msg*` after a call that *worked*. So the row
  is read back out of `E071`, and only then reported as registered.
- **The 67 exceptions come back as a sentence.** The ones a caller actually
  hits are spelled out; the rest keep their name and get what their prefix
  earns, because inventing a diagnosis for an exception nobody has seen would
  read as knowledge this does not have. `OB_LOCKED_BY_OTHER` additionally
  reports which open request does hold the object — the thing the exception
  does not say.
- `simulate` asks whether the entry would be accepted, writing nothing.

`setTextElements` uses it on the pool path: with a `transport` the object is
registered and the step reported; without one, an object that is in no open
request at all is named as such — unless it is local, where the warning would
be noise on every throwaway program. The object registered is the
**transportable** one, not the pool program: a function group travels as
`FUGR <group>`, never as `SAPL<group>`.

### The program title

`title` writes the `R` row, which ADT serves in no category and cannot write at
all — so a call carrying one goes the pool way whole rather than writing the
elements over ADT and dropping the title on the floor. `getTextElements`
answers with it alongside the categories on the pool path. An empty string
removes it; the length follows the same rule as an element.

### What the live runs found

- **A class pool is all equals signs.** `ZCL_FOO=======================CP` was
  refused by the name pattern, which is to say every class on the system was.
  Function groups were right first time (`SAPL<group>`, read live).
- **Against ADT itself**, on the system where the endpoint does exist: the same
  program answers with the same five headings in the same order, empties
  included. Two deliberate differences remain — the fallback adds `maxLength`
  where ADT omits it, and for a selection text with a dictionary flag ADT
  returns `?...` (it cuts eight characters blindly) where the fallback returns
  the text and `fromDictionary`.
- **A title-only write said it had replaced a category.** It had replaced
  nothing — a call that names no elements merges by definition, or it would
  wipe the texts the caller never mentioned — but the answer repeated the
  `merge` flag it was given rather than the one it used. What the answer says
  is now what happened.
- **The version list says nothing about a pool write, and that is SAP's own
  doing.** A write sets the change stamp on the pool itself (`REPOTEXT`: user,
  date, time) and creates no entry in version management (`VRSD`) — but neither
  does saving in SE38. Versions are snapshots taken when a **request is
  released**, which is where every numbered row in that list comes from; each
  one carries a released request, while an open one has no row yet.

  The blank date, time and author on the *active* line are not a trace of how
  the pool was written either. That line is built by `extract_info`, which
  clears the three fields and then fills them through the definition in
  `VERSOBJ`: for `REPS` it names `TRDIR` with `UDAT` and `UNAM` and the line
  gets a date; for `REPT` the `INFOSUBOBJ`, `FIELD_DATE`, `FIELD_TIME` and
  `FIELD_AUTH` columns are **empty in every row**, and
  `SVRS_EXTRACT_INFO_FROM_OBJECT` has a special case for `CUAD`, `CLSD`, `CPUB`
  and others but none for a text pool. So that line is blank for every text
  pool on the system, whoever changed it and however. Nothing here can fill it,
  and nothing should try.

### Tests

`src/lib/textPool.ts` holds every decision above as pure functions, so the
generated ABAP is tested without a system: 31 new tests there and 8 around the
fallback in the handler. 848 tests in 50 suites, green.

One trap is held by a test of its own: `out->write` is a method call and resets
`sy-subrc`, so the subrc of a pool statement is taken on the very next line.
A snippet that printed first once reported a clean run of a call that had
failed.

## [1.0.0] — one server for everybody

The server now speaks two transports. **stdio** is unchanged: one process per
user, started by the MCP client, credentials from the environment. **http**
(`MCP_TRANSPORT=http`) makes one process serve everybody, with each caller
sending their own SAP credentials as HTTP Basic on every request.

### Sessions, and why they are pooled

The credentials name a **pooled SAP session**, reused across requests. A
session per request - the obvious translation, and the one this replaces -
leaves a session behind on the backend for every call ever made, and makes a
lock taken by one request unusable by the next, because the handle dies with
the session that took it.

- Sessions are keyed by user, closed on idle limits, on `logout`, by an
  operator, or on shutdown. Closing releases the locks first, deliberately,
  and names them in the log.
- **Both** sessions a user costs are logged off: the stateful one and the
  stateless clone the reads travel on. Missing the clone would leave half the
  sessions behind.
- Two idle limits: 15 minutes with no locks, 28 minutes with them. The locked
  one is measured from the last use of the *stateful* session - reads keep the
  clone alive while the session holding the locks quietly expires - and stays
  inside the backend timeout so the locks come off deliberately rather than by
  expiry. The server warns at startup if it does not.
- That last use is observed on the client rather than inferred from which
  tool was called. The first attempt listed the tools known to use the
  stateful session, and the list was quietly wrong: `healthcheck`, `atcCheck`
  and `inactiveObjects` read through it too, so their calls kept the SAP
  session alive while the pool believed it idle - and would have closed it,
  locks and all, under somebody still working.
- The pool never pings SAP to keep a session warm: a keep-alive would turn a
  forgotten lock into a permanent one.
- Writes on one session are serialised; reads are not, and go to the clone.

### One caller cannot see another

Locks, the source cache and the per-caller counters resolve per session
(`AsyncLocalStorage`). `unlockAll` releases only its own caller's locks, and a
cached read is never handed to another user - two people do not have the same
authorisations. Over stdio the behaviour is exactly as before.

### The endpoint

`POST /mcp` with HTTP Basic; `401` with `WWW-Authenticate` when it is missing,
`413` above the body limit, `503` with `Retry-After` when the pool is full -
naming who holds it - or when too many calls are already running. `/health`,
`/ready`, `/metrics`, and `GET`/`DELETE /sessions` behind `SAP_ADMIN_TOKEN`.

Neither probe reports on SAP: it is a dependency every replica shares, and
failing on it would empty the service of endpoints without helping. The state
of the backend is a passive signal on `/metrics`, built from real traffic - no
probe, no technical user.

### Operational

- Graceful shutdown on SIGTERM and SIGINT, and on an uncaught error: stop
  taking work, let what is in flight finish, then log every session off.
- Every log line written while serving a request carries the request id, the
  caller and the tool.
- Deploy **one replica**: the pool lives in the memory of one process, so a
  lock taken through one pod and a write routed to another would not meet.
- Every session logs the id SAP knows it by. The `SAP_SESSIONID` cookie is 32
  bytes: the first half authenticates and is never printed, the second half is
  SECURITY_CONTEXT-LINK, the handle SM05 lists. Printing only the second half
  gives an exact join against SAP's own session list - `SELECT * FROM
  security_context WHERE link = '<what the log printed>'` - and leaks nothing
  that can be replayed. It is what tells a session this server still holds
  apart from one abandoned by a process that died without logging off.

## [0.9.1] — the project goes by one name

No behaviour change: no tool was added, removed or altered, and the 679 tests in
43 suites are untouched and green.

### Renamed to `mcp-abap-adt-api`

The repository dropped the doubled word, so the package now matches it. Changed
in `package.json` (`name`, `mcpName`, `bin`), `package-lock.json`, the server
name reported in the MCP handshake (`src/index.ts`) and the README — clone, the
directory it makes, and the client configuration example.

Two consequences worth knowing before upgrading: the executable installed by
`bin` is now `mcp-abap-adt-api`, and a client that keys its server entry by name
will see a new one. An existing entry keeps working — it points at
`dist/index.js` by path — but the key in the configuration example changed with
it. Repository links redirect from the old name, so an old clone URL still
resolves.

## [0.9.0] — what a live run found on the surfaces nobody had run

Tools stay at **177**, tests 643 → **679** in 43 suites. Read-only smoke run:
146 → **152** checks, plus two when `SMOKE_ATC_OBJECT` names a class and three
when `SMOKE_TRACE_ID` names a readable trace.

No new tools this time. ATC, the traces, the debugger and the abapGit tools had
never been exercised against a live system; running them found five calls that
fail on any real system, four answers that spend a caller's context on nothing,
and several facts about the backend worth writing down. Recording a trace to
read took four attempts, and each failure is written down below - the tools now
say in their own descriptions what the backend will not serve.

### The trace list is parsed here now

- **`tracesList` worked on no system at all.** The library decodes the trace
  feed through a codec that declares the atom title mandatory, and SAP only
  writes a title for a trace that was given a description — a live system held
  ten traces and one title. The backend answered correctly every time; the
  decoding threw the answer away. The feed is parsed in `lib/traceFeed` now,
  where a trace without a title is a trace without a title.
- The answer is also **capped at 50 runs** (`limit`) and drops the four atom
  links each run carries (`includeLinks` brings them back). The links are half
  the size of the answer and lead to SAP GUI.
- **`tracesCreateConfiguration` takes what it is given.** The backend accepts
  `parametersId` only as the full URI `tracesSetParameters` answered with, and
  `expires` only as an ISO-8601 timestamp with milliseconds; anything else is a
  flat 400 that names neither field. Both are normalised before the call, and
  an unreadable date is refused by name rather than by the backend.

### And the statements of one, which no codec could read either

- **`tracesStatements` failed the same way `tracesList` did.** Its codec
  declares `callingProgram` mandatory; a statement that is an entry point has
  no caller and carries none - two of 8051 in an ordinary trace, enough to lose
  the other 8049. Parsed here now, in `lib/traceRead`, with the caller
  optional.
- **`tracesHitList` and `tracesStatements` are capped.** The same trace
  answered 1.5 MB of hit list and 7.5 MB of statements: the first was thrown
  away whole by the response guard, which could only say it was too big. Both
  take `limit` (default 100) and `heaviestFirst`, and report `total`,
  `returned` and the order they used, so what was dropped is named rather than
  guessed at.

### The debugger no longer dumps on its own default

- **`debuggerListeners` failed when called with just its required arguments.**
  The library defaults the conflict check to on, and the backend raises a short
  dump for that check when there is no listener to conflict with — which is
  every system where nobody happens to be debugging. The check is off unless
  `checkConflict` asks for it.
- It also answered a bare `{"status":"success"}` whether or not a listener was
  found. It now says which: `listener: "none"` with the way to start one, or
  `listener: "conflict"` with what the backend described.

### Two user lists that answered with the whole system

- **`atcUsers` and `systemUsers`** returned every user the system knows — some
  450 entries and 14 kB of names on a live read, for a question about one
  person. Both take `filter` (case-insensitive, over id and name) and `limit`
  (default 50), and report `total`, `matched` and `returned` so nothing is
  silently dropped.

### A finding you can act on

- **`atcCheck` now reports `findingUri`.** Its answer carried the
  documentation link but not the finding's own URI, which is what
  `atcContactUri` and the exemption tools take — so nothing it produced could
  be fed to them.

### What the run established about the backend, not the code

- **A trace has to be recorded for the way it is going to be read.**
  `tracesStatements` refuses an aggregated trace outright - the backend says so
  in a subtype nobody surfaces, `invalidRequestForAggregatedTraces` - so a
  trace meant to be read statement by statement has to be created with
  `aggregate: false`. Beyond that, `tracesHitList`, `tracesDbAccess` and
  `tracesStatements` answer "wrong input data" or "Data is invalid" for any
  trace that is expired, still being written (`Active`), or over its size limit
  (`Size violation`), in every id encoding - and the entry of such a trace
  still advertises a hit list it will not serve. `tracesList` reports
  `expiration` and `state` for exactly this reason.
- **Tracing an ADT call is expensive.** A single `runSnippet` under
  `processType: ANY` filled 60 MB, and the same run recorded statement by
  statement overran 400 MB: the trace catches the whole ADT framework around
  the snippet, not just the snippet.
- **The abapGit tools need a plugin that need not be there.** On a system
  without it, `/sap/bc/adt/abapgit/repos` answers a plain 404 — as does
  `/sap/bc/adt/atc/items`, which `atcContactUri` and `atcChangeContact` are
  built on. Nothing to fix; worth knowing before assuming a tool is broken.

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

- **112 of 171** tools carried one-line stubs ("Runs a class.", "Lock an
  object", "Deletes a trace."). The description is the only thing a model
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

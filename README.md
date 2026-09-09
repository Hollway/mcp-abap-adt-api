DISCLAIMER: This server is still in experimental status! Use it with caution!

# ABAP-ADT-API MCP-Server

## Description

The MCP-Server `mcp-abap-abap-adt-api` is a Model Context Protocol (MCP) server designed to facilitate seamless communication between ABAP systems and MCP clients. It is a wrapper for [abap-adt-api](https://github.com/marcellourbani/abap-adt-api/) and provides a suite of tools and resources for managing ABAP objects, handling transport requests, performing code analysis, and more, enhancing the efficiency and effectiveness of ABAP development workflows.

The server is published on npm as [`mcp-abap-abap-adt-api`](https://www.npmjs.com/package/mcp-abap-abap-adt-api) and listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.mario-andreschak/mcp-abap-abap-adt-api`, so most MCP clients can install it with a single command (or a single click — see [FLUJO](#integrating-with-flujo-recommended) below).

> **Related project:** For higher-level, read-oriented ABAP tools (`GetProgram`, `GetClass`, `GetTable`, …) see the separate [`mcp-abap-adt`](https://github.com/mario-andreschak/mcp-abap-adt) server. **This** server (`mcp-abap-abap-adt-api`) exposes the lower-level ADT API (lock/unlock, edit source, transports, activation, syntax checks, DDIC access, …) for full read/write development workflows.

## Features

- **Objects**: read, write and create ABAP objects, including `patchObjectSource` for changing part of an object instead of re-uploading all of it, `editObject` for the whole lock/patch/unlock/activate sequence in one call, `createAndWrite` for create + write + activate, and `createInclude` for report includes.
- **Dictionary**: `createDataElement` and `createDomain` create a DDIC object and give it its definition in one call, and `get`/`setDataElementProperties` and `get`/`setDomainProperties` read and change one. `createObject` alone leaves a DDIC object with no type, which cannot be activated.
- **Reading source**: `sourceOutline` lists the blocks of a program or class with their line numbers, and `findInSource` searches a source - and the includes of a report - for text or a regular expression. ADT itself can only locate a class method.
- **Activation**: `activateSafe` activates and then verifies, because activation can report success without having activated anything.
- **Tests**: `runTests` activates the object first and reports which test methods ran, which passed, and every failure with its ABAP Unit message - a bare test run against an inactive object answers with an empty list that reads like success.
- **Locks**: `listLocks` and `unlockAll` make the locks this server holds visible, and they are released when it shuts down.
- **Transports**: filterable transport lists, `transportDetails` for the objects and tasks of one request, plus creation, release and ownership tools.
- **Code analysis**: syntax check (reusing the source last read or written), code completion, references, ATC - `atcCheck` runs the checks over an object or a package and reports the findings, `atcDocumentation` gives the rule text - traces and the debugger. `whereUsedMethod` and `typeHierarchy` take a method or class name and work the cursor position out themselves.
- **Enhancements and texts**: `objectEnhancements` shows the enhancement implementations injected into a source, which the source itself does not reveal; `get`/`setTextElements` reach the text symbols and selection texts that live outside it.
- **Whole packages**: `packageTree` walks a package and its sub-packages and resolves where each object's source lives, `readSources` reads many objects in one call, and `searchInPackage` searches every source in a package. `nodeContents` answers one level and hands most objects a SAPGUI bridge URI that serves no content.
- **Messages (SE91)**: `getMessages`, `setMessages` and `createMessageClass` read and write the messages a `MESSAGE` statement raises. They come inside the message class document, which `objectStructure` reads and then discards, so until now a report could be written raising messages that did not exist.
- **Diagnosable errors**: SAP's own exception type, T100 key and localized message are passed through instead of an axios status line.
- **Session recovery**: the ADT session is re-established automatically, and read-only calls are retried once.
- **Guardrails**: a read-only mode, tool profiles, per-tool read-only/destructive annotations and a cap on oversized answers.

## Prerequisites

- **An SAP ABAP System** reachable via ADT (ABAP Development Tools). You'll need the system URL, a username and password, and the client number. Ensure the `/sap/bc/adt` service is active in transaction `SICF` (your basis administrator can help).
- **Node.js and npm** — download the LTS version from [nodejs.org](https://nodejs.org/). Verify with `node -v` and `npm -v`.

## Installation

There are three ways to use this server, from easiest to most manual:

### Integrating with FLUJO (recommended)

[FLUJO](https://github.com/mario-andreschak/FLUJO) is the easiest way to use this server — no cloning, building, or hand-editing JSON config:

1. In FLUJO, navigate to **MCP**.
2. Click **Add Server**.
3. On the **Marketplace** tab, search for **`mcp-abap-abap-adt-api`** and select it.
4. FLUJO fetches the npm package automatically and opens the **Local Server** tab. Enter your SAP **URL**, **User**, **Password** (and optionally client/language), then click **Save**.

That's it — FLUJO downloads and runs the npm package for you and keeps your SAP credentials with the installed server.

#### Streamable HTTP transport (via FLUJO)

`mcp-abap-abap-adt-api` runs over **stdio**. If you need to reach it over **streamable HTTP** — for example from another app on your machine or a client that only speaks HTTP — let FLUJO re-host it: install the server in FLUJO as above, then toggle **"Expose to external apps"** on the server. FLUJO's built-in mcp-proxy then serves it over HTTP at `http://localhost:4200/mcp-proxy/mcp-abap-abap-adt-api`, and any HTTP-capable MCP client can connect with a config like:

```json
{
  "mcpServers": {
    "mcp-abap-abap-adt-api": {
      "type": "http",
      "url": "http://localhost:4200/mcp-proxy/mcp-abap-abap-adt-api"
    }
  }
}
```

FLUJO keeps your SAP credentials with the installed server, so the HTTP config itself carries none.

### Quick start with npx (any MCP client)

The server is published on npm, so you don't need to clone or build anything — most MCP clients can launch it directly via `npx`. Add it to your MCP client configuration (e.g. Cline, Claude Desktop, Claude Code):

```json
{
  "mcpServers": {
    "mcp-abap-abap-adt-api": {
      "command": "npx",
      "args": ["-y", "mcp-abap-abap-adt-api"],
      "env": {
        "SAP_URL": "https://your-sap-server.com:44300",
        "SAP_USER": "YOUR_SAP_USERNAME",
        "SAP_PASSWORD": "YOUR_SAP_PASSWORD",
        "SAP_CLIENT": "100",
        "SAP_LANGUAGE": "EN"
      }
    }
  }
}
```

If your SAP system uses a self-signed certificate, add `"NODE_TLS_REJECT_UNAUTHORIZED": "0"` to the `env` block (development only).

### Environment variables

| Variable | Meaning |
| --- | --- |
| `SAP_URL`, `SAP_USER`, `SAP_PASSWORD` | Connection; required. The user variable is `SAP_USER` - not `SAP_USERNAME`. |
| `SAP_CLIENT`, `SAP_LANGUAGE` | Logon client and language. |
| `SAP_READONLY` | `1` hides every tool that changes the system and refuses it if called anyway. Use it for a system that must only be read. |
| `SAP_READONLY_ALLOW` | Groups or tool names let through the read-only fence, e.g. `debugger` for a system that must not be developed on but does need debugging. Exclusion wins over an allowance, and these tools keep `readOnlyHint: false`. |
| `SAP_TOOLS_EXCLUDE` | Groups or tool names to hide, comma or space separated, e.g. `debugger,traces,atc,git`. Groups: `auth, transport, object, class, codeAnalysis, lock, source, deletion, activation, registration, node, discovery, unitTest, prettyPrinter, git, ddic, serviceBinding, query, feed, debugger, rename, atc, traces, refactor, revision, health`. |
| `SAP_MAX_RESPONSE_CHARS` | Cap on a single answer (default 200000). Over it, the answer is replaced by an envelope with the size and a preview. |
| `LOG_LEVEL` | `error`, `warn` (default), `info` or `debug`. All logging goes to stderr. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0` accepts a self-signed certificate (development only). |

Connection settings can also come from a `.env` file next to the server, but that is only a fallback: when several instances run against different systems, a typo in one client entry would silently connect to whatever `.env` points at. The server prints its target system and where the settings came from on startup, and `healthcheck` reports both.

> **Windows tip:** if `npx` isn't found, set `"command": "npx.cmd"`, or use the full path to `node` with the absolute path to `dist/index.js` from a source install (see below).

### Build from source

1. **Clone the Repository**

   ```cmd
   git clone https://github.com/mario-andreschak/mcp-abap-abap-adt-api.git
   cd mcp-abap-abap-adt-api
   ```

2. **Install Dependencies**

   ```cmd
   npm install
   ```

3. **Configure Environment Variables**

   An `.env.example` file is provided in the root directory as a template for the required environment variables. To set up your environment:

   a. Copy the `.env.example` file and rename it to `.env`:
      ```bash
      cp .env.example .env
      ```

   b. Open the `.env` file and replace the placeholder values with your actual SAP connection details:

      ```env
      SAP_URL=https://your-sap-server.com:44300
      SAP_USER=YOUR_SAP_USERNAME
      SAP_PASSWORD=YOUR_SAP_PASSWORD
      SAP_CLIENT=YOUR_SAP_CLIENT
      SAP_LANGUAGE=YOUR_SAP_LANGUAGE
      ```

   Note: The SAP_CLIENT and SAP_LANGUAGE variables are optional but recommended.

   If you're using self-signed certificates, you can also set:

   ```env
   NODE_TLS_REJECT_UNAUTHORIZED="0"
   ```

   IMPORTANT: Never commit your `.env` file to version control. It's already included in `.gitignore` to prevent accidental commits.

4. **Build the Project**

   ```cmd
   npm run build
   ```

5. **Run the Server**

   ```cmd
   npm run start
   ```

   When integrating a source build into an MCP client, point `command` at `node` with an absolute path to the build output:

   ```json
   {
     "mcpServers": {
       "mcp-abap-abap-adt-api": {
         "command": "node",
         "args": ["PATH_TO_YOUR/mcp-abap-abap-adt-api/dist/index.js"],
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

## Custom Instruction

Use this instruction to explain the server to your model:

```
## mcp-abap-abap-adt-api Server

Tools for working on an SAP system through ADT: reading and changing ABAP
objects, activating them, running tests, and handling transports.

**Finding things**

* `searchObject` resolves a name to an object URI, e.g.
  /sap/bc/adt/oo/classes/zcl_invoice. `objectStructure` describes an object,
  `nodeContents` lists a package, `usageReferences` finds callers.
* `getObjectSource` takes the URI plus /source/main. It serves the INACTIVE
  version by default, so reading your own edit back proves nothing about what
  the system runs - pass version="active" for that. Use startLine/maxLines
  to page through a large object instead of pulling all of it.
* `sourceOutline` is the table of contents of a source: every REPORT, CLASS,
  METHOD, FORM, MODULE, FUNCTION, INCLUDE and event block with its line.
  `findInSource` searches for text or a regular expression and answers with
  line numbers; searchIncludes follows a report's INCLUDE statements. Use
  these to find a FORM or a MODULE - `fragmentMappings` only knows class
  fragments (CLAS/OM), and a type it does not know is answered with 400.

**Changing an object**

`editObject` does the whole sequence below in one call - lock, patch, unlock,
activate, verify - and reports each step. Nothing is rolled back if a step
fails; the source stays in the inactive version, which is not what the system
executes. The steps by hand:

1. `lock` the object URI (without /source/main). Keep the lockHandle; the
   server also remembers it, and `listLocks` shows what is held.
2. `patchObjectSource` with the source URI and the edits: a line range
   ({startLine, endLine, replacement}), exact text ({anchor, replacement}) or
   an insertion ({insertAfterLine, insertion}). It reads the current source,
   applies the edits and returns a diff. Pass dryRun first if unsure.
   `setObjectSource` still exists, but it replaces the whole object.
3. `unLock` **before activating**: activating while holding the lock fails
   with "user X is already processing Y". This differs from the ADT editor.
4. `activateSafe` with the object name. It activates every inactive part -
   the class, its changed method fragments, its sections, its test include -
   and then checks that nothing is left inactive. Do not trust
   `activateByName`: it has answered success:true without activating.
5. Verify with `getObjectSource` version="active", or `inactiveObjects`
   returning an empty list.

**Creating an object**

`createAndWrite` creates the object and writes its source in one call, then
activates it: validate the name, create, lock, write, unlock, activate. It
knows where the source of a CLAS/OC, INTF/OI, PROG/P, PROG/I, FUGR/F, FUGR/FF
or FUGR/I lives; anything else is `createObject` plus `setObjectSource`. A
package other than $TMP needs a transport request - ask the user which one.

Objects are created in the logon language. That matters: the underlying
library defaults to EN and makes it the master language, and SAP then answers
a read in any other language with an empty description.

**The dictionary**

`createDataElement` and `createDomain` create and define in one call. The type
of a data element comes either from a domain or from a built-in ABAP type, not
both, and the four field labels are cut to the lengths SAP allows (10/20/40/55)
with the answer saying which were cut. `setDataElementProperties` and
`setDomainProperties` change an existing one: the backend PUT replaces the
whole definition, so anything not passed is kept as the system has it. They
take the lock themselves and give it back, and `activate` finishes the job -
demanding a separate `lock` call made a one-field change a three-call sequence.

Not every release serves these over ADT. On a classic ERP system data elements
work while domains answer 404 for every path including validation - the tools
say so instead of looking like a wrong name, and the domain has to be
maintained in SE11. On S/4 both work, and the whole cycle - create with fixed
values, patch the description, patch the values, build a data element on the
domain - was verified there.

**Working on a package**

`packageTree` walks a package and its sub-packages breadth-first and answers
with every object, its type, the package it sits in and the URL that serves
its source. That last part is the point: `nodeContents` answers one level and
gives most objects a SAPGUI bridge URI
(/sap/bc/adt/vit/wb/object_type/tabldt/object_name/ZFOO) which serves
properties and no content. A limit reached leaves the upper levels complete
and names the packages it did not open. An unknown package is told apart from
an empty one - both answer with an empty node list, so existence is checked
separately.

`readSources` reads many objects in one call, by name and type or by URL, each
reported on its own so one unreadable object does not lose the rest.
`searchInPackage` searches every source in a package for text or a regular
expression - one call instead of a listing plus a read and a search per
object. It reads what it walks, so narrow a large package with objectTypes and
maxObjects.

**Messages**

`getMessages` reads the messages of a message class: number, text, whether the
message is self-explanatory and whether it has a long text. They live inside
the class document and nowhere else - `objectStructure` on the same class asks
the very endpoint that carries them and keeps only the metadata. Standard
classes are big (class 00 holds 875 messages in one 478 KB document), so
narrow the answer with numbers, fromNumber/toNumber or search.
`getMessageLongtext` reads the cause and procedure of one message; the text is
stored per language with no fallback.

`setMessages` adds or changes messages, `createMessageClass` creates the class
and fills it in one call. Only the messages passed are touched - the backend
upserts by number - and a field left out keeps its current value. The class
description is read first and carried over, because the write replaces the
class header. Text is capped at 73 characters, what T100 holds, and the answer
says what was cut. No activation is involved: the message is in T100 as soon
as the call returns.

Two things the backend does not allow, and neither is worked around here: a
message cannot be removed (a PUT or DELETE on the per-message resource is
refused whatever lock handle it is given), and a long text cannot be written
(that resource has no PUT). Both need SE91.

**Tests**

`runTests` is the one to use: it activates the object first, because no test
runs against an inactive one, and then reports how many methods ran, how many
passed, and each failure with its class, method and ABAP Unit message.

`unitTestRun` returning an empty result does NOT mean the tests passed - it
means none ran. The answer explains why: the object is inactive, or the test
include does not compile. Fix that and run it again.

**ATC**

`atcCheck` is the one to use: it takes the check variant from the system
customizing, opens a worklist, starts the run and reads the findings back -
each with its priority (1 is the worst), the check that raised it, the message
and the source line it points at. Narrow a large answer with minPriority and
maxFindings, and read the rule behind a finding with `atcDocumentation` and the
documentationUri the report carries.

The steps by hand are a trap worth knowing about. `createAtcRun` wants a
WORKLIST ID in the parameter the library calls `variant`; given a variant name
it answers 500 with nothing to go on. The id comes from `atcCheckVariant`,
which - despite its name - opens a worklist rather than describing a variant.
A package is checked through its SAPGUI bridge URI, because
/sap/bc/adt/packages/ZFOO is refused with "No URI-Mapping defined for URI".

**Transports**

`userTransports` lists a user's requests, filterable by status (D
modifiable, R released), owner, number and description. `transportDetails`
answers what is inside one request - its tasks and every object recorded in
it - and resolves a task number to the request holding it. `transportInfo` on
an object URI shows which request would take a change. Ask the user which
request to use rather than creating one.

Pass the number of the request, not of a developer task: a task number is
refused by a write with "not a change request".

**Errors**

Failures carry SAP's own diagnosis: adtType (the ADT exception), t100 (the
message key), localizedMessage, status, and diagnostic - "sap" for a real
rejection, "transport" for an HTTP failure with no answer from SAP. A dead
session is recovered automatically for read-only calls, which then come back
marked sessionRecovered; a call that writes is never repeated for you,
because its lock handle died with the session - re-lock and retry.

**Notes**

* SAP is decoupled from the local file system. Reading source returns it as a
  tool result only; local copies are for your own reference.
* Writes land in the inactive version, so a botched write never touches what
  is running until it is activated.
```

## Efficient Database Access

SAP systems contain vast amounts of data.  It's crucial to write ABAP code that accesses the database efficiently to minimize performance impact and network traffic.  Avoid selecting entire tables or using broad `WHERE` clauses when you only need specific data.

*   **Use `WHERE` clauses:** Always use `WHERE` clauses in your `SELECT` statements to filter the data retrieved from the database.  Select only the specific rows you need.
*   **`UP TO 1 ROWS`:** If you only need a single record, use the `SELECT SINGLE` statement, if you can guarantee that you can provide ALL the key fields for the `SELECT SINGLE` statement. Otherwise, use the `SELECT` statement with the `UP TO 1 ROWS` addition. This tells the database to stop searching after finding the first matching record, improving performance. Example:

    ```abap
    SELECT vgbel FROM vbrp WHERE vbeln = @me->lv_vbeln INTO @DATA(lv_vgbel) UP TO 1 ROWS.
      EXIT. " Exit any loop after this.
    ENDSELECT.
    ```
## Checking Table and Structure Definitions

When working with ABAP objects, you may encounter errors related to unknown field names or incorrect table usage. Use the following tools to inspect DDIC (Data Dictionary) objects:

*   **`getStructureSource`:** The definition of a table or structure as DDL text, plus the parsed field list with types and key flags. This is the one that shows the fields; both TABL/DT and TABL/DS come from the same endpoint.
*   **`objectStructure`:** Retrieves the structure/metadata of an ABAP object (including DDIC tables and structures) from its object URI. Use `searchObject` first to resolve the object name to a URI. For a table it answers metadata only - no fields.
*   **`ddicElement`:** Retrieves details of a DDIC element (e.g. a data element or domain).
*   **`ddicRepositoryAccess`:** Reads DDIC repository information for a given path.
*   **`tableContents`:** Retrieves the *contents* (rows) of a table, not its definition. Use `runQuery` for ad-hoc `SELECT`s.

> **Note:** Earlier versions of this README listed `GetTable`, `GetStructure`, and `GetTypeInfo`. Those tools are **not** part of this server — they belong to the separate [`mcp-abap-adt`](https://github.com/mario-andreschak/mcp-abap-adt) project. This server (`mcp-abap-abap-adt-api`) exposes the lower-level ADT API tools listed above instead.

## Troubleshooting

*   **`npx` can't find the package / client won't start it:** ensure Node.js is installed and on your PATH (`node -v`, `npm -v`). On Windows try `"command": "npx.cmd"`, or use a source build with an absolute path to `node dist/index.js`.
*   **SAP connection errors:** verify your credentials (`SAP_URL`, `SAP_USER`, `SAP_PASSWORD`, `SAP_CLIENT`), confirm the system is reachable, that your user has ADT authorizations, and that `/sap/bc/adt` is active in `SICF`.
*   **TLS / self-signed certificate errors:** for development only, set `NODE_TLS_REJECT_UNAUTHORIZED=0` (env var or in the client `env` block).
*   **Every call suddenly fails with status 400:** the ADT session died. The server detects that shape (an HTTP failure with no `exc:exception` body), re-authenticates and retries read-only calls, marking the answer `sessionRecovered`. A call that writes is not repeated: re-lock the object and try again. `healthcheck` says whether the session is alive.
*   **A change seems to have no effect:** it is probably still inactive. `getObjectSource` serves the inactive version by default - read it with `version="active"`, and check `inactiveObjects` is empty after activating. Prefer `activateSafe`.
*   **`logout` and then nothing works:** the underlying client cannot log in again after `logout`; restart the server process. Use `dropSession` to release a session instead.
*   **An answer comes back as `{"status":"truncated"}`:** it exceeded `SAP_MAX_RESPONSE_CHARS`. Narrow the request (`startLine`/`maxLines`, `rowNumber`, the `userTransports` filters) or raise the limit.
*   **A tool is missing from the list:** check `SAP_READONLY` and `SAP_TOOLS_EXCLUDE` - `healthcheck` reports the active profile.

## Development

```bash
npm install
npm run build      # compile src/ to dist/
npm test           # unit tests (no SAP system needed)
npm run smoke      # end-to-end checks against a real system, read-only
```

`npm run smoke` takes the same environment variables as the server and never
locks, writes or activates anything:

```bash
SAP_URL=... SAP_USER=... SAP_PASSWORD=... SMOKE_CLASS=CL_SALV_TABLE npm run smoke
```

### The changelog

One working session, one version. Each session of work on this server adds a
new version section at the top of `CHANGELOG.md` with its date, its commit
range, how the tool and test counts moved, and what it changed - so the history
shows what each round brought rather than only where things ended up.

## Contributing

Contributions are welcome! Please follow these steps to contribute:

1. **Fork the Repository**
2. **Create a New Branch**

   ```cmd
   git checkout -b feature/your-feature-name
   ```

3. **Commit Your Changes**

   ```cmd
   git commit -m "Add some feature"
   ```

4. **Push to the Branch**

   ```cmd
   git push origin feature/your-feature-name
   ```

5. **Open a Pull Request**

## License

This project is licensed under the [MIT License](LICENSE).

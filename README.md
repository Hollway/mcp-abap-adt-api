DISCLAIMER: This server is still in experimental status! Use it with caution!

# ABAP-ADT-API MCP-Server

## Description

The MCP-Server `mcp-abap-abap-adt-api` is a Model Context Protocol (MCP) server designed to facilitate seamless communication between ABAP systems and MCP clients. It is a wrapper for [abap-adt-api](https://github.com/marcellourbani/abap-adt-api/) and provides a suite of tools and resources for managing ABAP objects, handling transport requests, performing code analysis, and more, enhancing the efficiency and effectiveness of ABAP development workflows.

The server is published on npm as [`mcp-abap-abap-adt-api`](https://www.npmjs.com/package/mcp-abap-abap-adt-api) and listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.mario-andreschak/mcp-abap-abap-adt-api`, so most MCP clients can install it with a single command (or a single click — see [FLUJO](#integrating-with-flujo-recommended) below).

> **Related project:** For higher-level, read-oriented ABAP tools (`GetProgram`, `GetClass`, `GetTable`, …) see the separate [`mcp-abap-adt`](https://github.com/mario-andreschak/mcp-abap-adt) server. **This** server (`mcp-abap-abap-adt-api`) exposes the lower-level ADT API (lock/unlock, edit source, transports, activation, syntax checks, DDIC access, …) for full read/write development workflows.

## Features

- **Objects**: read, write and create ABAP objects, including `patchObjectSource` for changing part of an object instead of re-uploading all of it, and `createInclude` for report includes.
- **Activation**: `activateSafe` activates and then verifies, because activation can report success without having activated anything.
- **Locks**: `listLocks` and `unlockAll` make the locks this server holds visible, and they are released when it shuts down.
- **Transports**: filterable transport lists, plus creation, release and ownership tools.
- **Code analysis**: syntax check (reusing the source last read or written), code completion, references, ATC, traces and the debugger.
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

**Changing an object**

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

**Tests**

`unitTestRun` returning an empty result does NOT mean the tests passed - it
means none ran. The answer explains why: the object is inactive, or the test
include does not compile. Fix that and run it again.

**Transports**

`userTransports` lists a user's requests, filterable by status (D
modifiable, R released), owner, number and description. `transportInfo` on an
object URI shows which request would take a change. Ask the user which
request to use rather than creating one.

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

*   **`objectStructure`:** Retrieves the structure/metadata of an ABAP object (including DDIC tables and structures) from its object URI. Use `searchObject` first to resolve the object name to a URI.
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

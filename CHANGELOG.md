# Changelog

## [0.1.0] - Initial Commit
- Initial project setup.

## [0.1.1] - Better unified response structure
- Improved and unified the response structure.

## Unreleased - hardening

Reliability

- **ADT errors keep SAP's diagnosis.** Every handler used to repack exceptions
  into an axios message ("Request failed with status code 400"), and anything
  that was not an `McpError` became "Internal server error". Failures now carry
  `status`, `adtType`, `t100`, `localizedMessage` and `diagnostic` (`sap` for a
  real rejection, `transport` for an HTTP failure with no answer from SAP).
- **The ADT session recovers itself.** abap-adt-api skips its re-login retry
  while the client is stateful, which this server always is, so a dead session
  meant every later call failed until `login` was called by hand. The server now
  detects that shape, re-authenticates and retries read-only calls (marking the
  answer `sessionRecovered`). Calls that write are never replayed: the session is
  restored, and the caller is told the lock handle is void.
- **`healthcheck` actually checks.** It calls the backend and reports the target
  system, session state, tool profile, metrics and latency, instead of a
  constant "healthy".
- **`login`, `logout` and `dropSession` return valid results.** `login` used to
  emit no text at all, so clients rejected the response schema although the
  re-authentication had succeeded. `logout` now warns that the client cannot log
  in again afterwards.

New tools

- **`patchObjectSource`** changes part of an object: the server reads the current
  source, applies line-range, anchor or insertion edits and returns a unified
  diff, so a small change no longer costs a full re-upload. `dryRun` previews it.
- **`activateSafe`** activates and then verifies that nothing is left inactive.
- **`listLocks` / `unlockAll`** expose the locks this process holds; they are
  also released on shutdown and dropped after a re-login.
- **`createInclude`** creates a report include (`PROG/I`), which `createObject`
  cannot: the library omits the reference to the main program.

Usability

- `getObjectSource` takes a `version` (`active`/`inactive`/`workingArea`); the
  active version was previously unreachable through the tool.
- `unitTestRun` explains an empty result instead of leaving it to be misread as
  "all tests passed".
- `userTransports` returns a flat list with filters on status, owner, number and
  description; `raw` brings back the full payload.
- `runQuery` and `tableContents` take an `offset`.
- Object and array parameters are declared as such and parsed - `unitTestRun`
  flags, the class to evaluate, references, proposals, configurations and
  breakpoints were all declared as strings and handed to the library unparsed.

Operations

- `SAP_READONLY` refuses every mutating tool; `SAP_TOOLS_EXCLUDE` hides tool
  groups; tools carry `readOnlyHint` and `destructiveHint`.
- Answers larger than `SAP_MAX_RESPONSE_CHARS` are replaced by an envelope with
  the size and a preview.
- `LOG_LEVEL` (default `warn`) replaces a per-request info line; metrics moved
  into `healthcheck`; the dead rate limiter is gone.
- The server prints its target system on startup and warns when the settings
  came from the `.env` fallback rather than the client.
- Unit tests (45) and a read-only end-to-end smoke script (`npm run smoke`);
  `npm test` previously found no tests at all.

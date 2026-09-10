import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError, describeAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import { session_types } from "abap-adt-api";
import type { ObjectSourceOptions, ObjectVersion } from "abap-adt-api";
import { sourceCache, sourceCacheKey } from '../lib/sourceCache';
import { lockRegistry } from '../lib/lockRegistry';
import { resolveEdits, applyEdits, buildDiff, newlineOf, PatchError } from '../lib/sourcePatch';
import { activateAndVerify } from '../lib/activation';
import { releaseLock } from '../lib/lockCycle';
import type { SourceEdit } from '../lib/sourcePatch';

const VERSIONS: ObjectVersion[] = ['active', 'inactive', 'workingArea'];

export class ObjectSourceHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'getObjectSource',
        description: 'Retrieves source code for ABAP objects. ADT serves the INACTIVE version by default, so reading your own edit back proves nothing about what runs - pass version="active" to see the live code. For large objects, use startLine/maxLines to page through the source instead of retrieving it all at once.',
        inputSchema: {
          type: 'object',
          properties: {
            objectSourceUrl: { type: 'string' },
            version: {
              type: 'string',
              description: 'Which version to read: "active" (what the system executes), "inactive" (the working version, ADT default) or "workingArea". Omit for the ADT default.'
            },
            options: {
              type: 'string',
              description: 'Deprecated. JSON object of raw abap-adt-api source options, e.g. {"version":"active"}; prefer the version parameter.'
            },
            startLine: {
              type: 'number',
              description: '1-based line number to start from (default 1). Use with maxLines to page through large sources.'
            },
            maxLines: {
              type: 'number',
              description: 'Maximum number of lines to return from startLine. Omit to return the rest of the source.'
            }
          },
          required: ['objectSourceUrl']
        }
      },
      {
        name: 'patchObjectSource',
        description: 'Change part of an ABAP object without re-uploading it. Reads the current source, applies the edits, writes the result and returns a unified diff of what changed. Use it instead of setObjectSource for a small change to a large object: setObjectSource replaces the whole object, so it costs the entire source and risks disturbing lines you never meant to touch. Pass dryRun to see the diff without writing.',
        inputSchema: {
          type: 'object',
          properties: {
            objectSourceUrl: {
              type: 'string',
              description: 'Source URL, e.g. /sap/bc/adt/oo/classes/zcl_app/source/main'
            },
            edits: {
              type: 'array',
              description: 'Edits to apply. Every line number refers to the source as it is now, and edits must not overlap. Each edit is one of: {startLine, endLine?, replacement} to replace a line range ("" deletes it), {anchor, replacement, occurrence?} to replace exact text, {insertAfterLine, insertion} to insert (0 = at the top).',
              items: {
                type: 'object',
                properties: {
                  startLine: { type: 'number' },
                  endLine: { type: 'number' },
                  replacement: { type: 'string' },
                  anchor: { type: 'string' },
                  occurrence: { type: 'number' },
                  insertAfterLine: { type: 'number' },
                  insertion: { type: 'string' }
                }
              }
            },
            lockHandle: {
              type: 'string',
              description: 'Lock handle. Omit it and the handle recorded by lock for this object is used (see listLocks).'
            },
            transport: {
              type: 'string',
              description: 'Transport request for the change.'
            },
            dryRun: {
              type: 'boolean',
              description: 'Compute and return the diff without writing anything.'
            }
          },
          required: ['objectSourceUrl', 'edits']
        }
      },
      {
        name: 'editObject',
        description: 'The whole edit in one call: lock, patch, unlock, activate and verify. This is the sequence a change to an ABAP object needs, and each step has a way to go wrong on its own - the lock must be released BEFORE activating, or activation fails with "user is already processing", and an activation is only believable once the inactive list comes back empty. Nothing is rolled back if a step fails: the source stays written to the inactive version, which is not what the system executes, and the answer says exactly how far it got. Pass dryRun to see the diff without locking anything.',
        inputSchema: {
          type: 'object',
          properties: {
            objectSourceUrl: {
              type: 'string',
              description: 'Source URL, e.g. /sap/bc/adt/oo/classes/zcl_app/source/main'
            },
            edits: {
              type: 'array',
              description: 'Edits to apply, exactly as patchObjectSource takes them: {startLine, endLine?, replacement}, {anchor, replacement, occurrence?} or {insertAfterLine, insertion}.',
              items: {
                type: 'object',
                properties: {
                  startLine: { type: 'number' },
                  endLine: { type: 'number' },
                  replacement: { type: 'string' },
                  anchor: { type: 'string' },
                  occurrence: { type: 'number' },
                  insertAfterLine: { type: 'number' },
                  insertion: { type: 'string' }
                }
              }
            },
            transport: {
              type: 'string',
              description: 'Transport request. Pass the number of the REQUEST, not of a task inside it - a task number is refused with "not a change request".'
            },
            parentUri: {
              type: 'string',
              description: 'Package URI (/sap/bc/adt/packages/<package>), used when the inactive list leaves adtcore:parentUri empty.'
            },
            activate: {
              type: 'boolean',
              description: 'Activate after writing (default true). Set false to leave the change in the inactive version.'
            },
            accessMode: {
              type: 'string',
              description: 'Access mode for the lock.'
            },
            dryRun: {
              type: 'boolean',
              description: 'Compute the diff and return it without locking, writing or activating.'
            }
          },
          required: ['objectSourceUrl', 'edits']
        }
      },
      {
        name: 'setObjectSource',
        description: 'Replace the whole source of an ABAP object. For a small change prefer patchObjectSource, which reads, edits and writes without sending the entire object.',
        inputSchema: {
          type: 'object',
          properties: {
            objectSourceUrl: { type: 'string' },
            source: { type: 'string' },
            lockHandle: { type: 'string' },
            transport: { type: 'string' }
          },
          required: ['objectSourceUrl', 'source', 'lockHandle']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'getObjectSource':
        return this.handleGetObjectSource(args);
      case 'setObjectSource':
        return this.handleSetObjectSource(args);
      case 'patchObjectSource':
        return this.handlePatchObjectSource(args);
      case 'editObject':
        return this.handleEditObject(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown object source tool: ${toolName}`);
    }
  }

  /**
   * Build the source options abap-adt-api expects.
   *
   * The tool used to declare `options` as a plain string while the library
   * takes an object, so the version could not be selected at all and callers
   * had to append ?version=active to the URL by hand. `version` is now a
   * first-class parameter; the old string is still accepted, as JSON or as a
   * bare "version=active" fragment.
   */
  private sourceOptions(args: any): ObjectSourceOptions {
    const options: ObjectSourceOptions = {};
    const legacy = args?.options;
    if (typeof legacy === 'string' && legacy.trim().length > 0) {
      try {
        const parsed = JSON.parse(legacy);
        if (parsed && typeof parsed === 'object') Object.assign(options, parsed);
      } catch {
        const match = legacy.match(/version=(active|inactive|workingArea)/);
        if (match) options.version = match[1] as ObjectVersion;
      }
    } else if (legacy && typeof legacy === 'object') {
      Object.assign(options, legacy);
    }
    const version = args?.version;
    if (typeof version === 'string' && version.length > 0) {
      if (!VERSIONS.includes(version as ObjectVersion)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `version must be one of ${VERSIONS.join(', ')}`
        );
      }
      options.version = version as ObjectVersion;
    }
    return options;
  }

  async handleGetObjectSource(args: any): Promise<any> {

    const startTime = performance.now();
    try {
      const options = this.sourceOptions(args);
      const fullSource = await this.readClient.getObjectSource(args.objectSourceUrl, options);
      // Remember the source so a later syntaxCheckCode on the same URL can reuse
      // it without the caller re-sending it (issue #2). Only the working version
      // is cached under the plain URL: a syntax check is about the code being
      // edited, so an explicitly requested "active" read must not shadow it.
      sourceCache.set(sourceCacheKey(args.objectSourceUrl, options.version), fullSource);
      this.trackRequest(startTime, true);

      const lines = fullSource.split('\n');
      const totalLines = lines.length;

      // Optional pagination for large sources (issue #4). When neither
      // parameter is provided, behaviour is unchanged: the whole source is returned.
      const hasPaging = args.startLine !== undefined || args.maxLines !== undefined;
      const startLine = Math.max(1, Number(args.startLine) || 1);
      const startIndex = startLine - 1;
      const endIndex = args.maxLines !== undefined
        ? startIndex + Math.max(0, Number(args.maxLines))
        : totalLines;
      const source = hasPaging ? lines.slice(startIndex, endIndex).join('\n') : fullSource;
      const returnedLines = hasPaging ? Math.min(endIndex, totalLines) - startIndex : totalLines;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              source,
              totalLines,
              version: options.version || 'default',
              startLine: hasPaging ? startLine : 1,
              returnedLines: Math.max(0, returnedLines),
              hasMore: hasPaging ? endIndex < totalLines : false
            })
          }
        ]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to get object source');
    }
  }

  /**
   * The object URL behind a source URL: /oo/classes/zcl_x/source/main -> the
   * class itself, which is what lock works on and what the registry keys on.
   *
   * A class include (test classes, local definitions, macros) has its own
   * source URL, but the lock still belongs to the class - so that part comes
   * off too.
   */
  private objectUrlOf(sourceUrl: string): string {
    return sourceUrl
      .split('#')[0]
      .replace(/\/source\/main$/, '')
      .replace(/\/source$/, '')
      .replace(/^(\/sap\/bc\/adt\/oo\/(?:classes|interfaces)\/[^/]+)\/includes\/[^/]+$/, '$1');
  }

  /**
   * Read, edit, write - the partial write ADT does not offer.
   *
   * setObjectSource takes the complete source, so changing sixteen lines of a
   * two-thousand-line class means re-sending all of it and trusting that
   * nothing else drifted. Here the current source never leaves the server: the
   * caller sends only the edits and gets back a diff of what actually changed.
   */
  async handlePatchObjectSource(args: any): Promise<any> {
    return this.answer(await this.patchSource(args));
  }

  /**
   * The patch itself, as a payload rather than a tool answer, so editObject
   * can run it as one step of a longer chain.
   */
  private async patchSource(args: any): Promise<Record<string, unknown>> {
    const edits = this.parseObjectArg<SourceEdit[]>(args?.edits, 'edits');
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'edits must be a non-empty array.');
    }

    const objectUrl = this.objectUrlOf(args.objectSourceUrl);
    const held = lockRegistry.forUrl(objectUrl);
    const lockHandle = args?.lockHandle || held?.lockHandle;
    const dryRun = args?.dryRun === true;
    if (!lockHandle && !dryRun) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No lockHandle given and none recorded for ${objectUrl}. Call lock first, or pass dryRun to preview the diff.`
      );
    }

    const startTime = performance.now();
    try {
      const current = await this.adtclient.getObjectSource(args.objectSourceUrl);

      let resolved;
      try {
        resolved = resolveEdits(current, edits);
      } catch (patchError: any) {
        // A bad edit is the caller's mistake, not a backend failure, and
        // nothing has been written at this point.
        throw new McpError(
          ErrorCode.InvalidParams,
          `${patchError instanceof PatchError ? patchError.message : patchError?.message}`
        );
      }

      const patched = applyEdits(current, resolved);
      const diff = buildDiff(current, resolved);
      const nl = newlineOf(current);
      const linesBefore = current.split(nl).length;
      const linesAfter = patched.split(nl).length;

      if (patched === current) {
        this.trackRequest(startTime, true);
        return {
          status: 'success',
          written: false,
          note: 'The edits produce exactly the current source; nothing was written.',
          linesBefore,
          linesAfter
        };
      }

      if (dryRun) {
        this.trackRequest(startTime, true);
        return {
          status: 'success',
          written: false,
          dryRun: true,
          edits: resolved.length,
          linesBefore,
          linesAfter,
          diff
        };
      }

      // dropSession/logout reset the client to stateless; writing needs stateful
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.setObjectSource(
        args.objectSourceUrl,
        patched,
        lockHandle,
        args.transport
      );
      sourceCache.set(args.objectSourceUrl, patched);
      this.trackRequest(startTime, true);

      return {
        status: 'success',
        written: true,
        edits: resolved.length,
        linesBefore,
        linesAfter,
        lockHandleFrom: args?.lockHandle ? 'argument' : 'lockRegistry',
        diff,
        hint: 'Written to the inactive version. Activate with activateSafe, then verify with getObjectSource version="active".'
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to patch object source');
    }
  }

  /**
   * Lock, patch, unlock, activate - the sequence, run once.
   *
   * Done by hand it is four calls whose order matters and whose failures do
   * not announce themselves: the lock has to be released before activation
   * (ADT refuses to activate an object its own session holds, unlike the GUI
   * editor), and activation has to be verified against the inactive list.
   *
   * Nothing is rolled back. A failed activation leaves the new source in the
   * inactive version, which the system does not execute, so the state after a
   * failure is "the edit is saved but not live" - the same place a developer
   * ends up in ADT, and the fix is to correct the source and activate again.
   * What this does clean up is the lock it took itself: a lock left behind is
   * invisible and blocks the next attempt.
   */
  async handleEditObject(args: any): Promise<any> {
    const objectUrl = this.objectUrlOf(args.objectSourceUrl);
    const steps: Record<string, unknown>[] = [];

    if (args?.dryRun === true) {
      const patch = await this.patchSource({ ...args, dryRun: true });
      return this.answer({ status: 'success', dryRun: true, objectUrl, patch });
    }

    // A lock this process already holds is reused rather than doubled, and
    // released at the end either way: the activation needs it gone.
    const held = lockRegistry.get(objectUrl);
    let lockHandle = held?.lockHandle;
    if (!lockHandle) {
      const startTime = performance.now();
      try {
        this.adtclient.stateful = session_types.stateful;
        const lockResult = await this.adtclient.lock(objectUrl, args?.accessMode);
        lockHandle = lockResult.LOCK_HANDLE;
        lockRegistry.remember(objectUrl, lockHandle, args?.accessMode);
        this.trackRequest(startTime, true);
      } catch (error: any) {
        this.trackRequest(startTime, false);
        throw wrapAdtError(error, 'Failed to lock the object for editing');
      }
    }
    steps.push({ step: 'lock', lockHandle, taken: !held });

    let patch: Record<string, unknown>;
    try {
      patch = await this.patchSource({ ...args, lockHandle });
    } catch (error: any) {
      // Release what we took; the caller gets the patch error, not a lock left
      // on an object nobody is editing any more.
      if (!held) await this.releaseLock(objectUrl, lockHandle);
      throw error;
    }
    steps.push({ step: 'patch', ...patch });

    const unlock = await this.releaseLock(objectUrl, lockHandle);
    steps.push({ step: 'unlock', ...unlock });

    if (args?.activate === false) {
      return this.answer({
        status: 'success',
        objectUrl,
        activated: false,
        steps,
        hint: 'Written to the inactive version and not activated, so the system still runs the old code.'
      });
    }

    if (!unlock.released) {
      // Activating with the lock still held fails with "user is already
      // processing this object" - say that instead of producing it.
      return this.answer({
        status: 'error',
        objectUrl,
        activated: false,
        steps,
        hint: 'The lock could not be released, and activation would fail while it is held. Release it (unlockAll) and activate with activateSafe.'
      });
    }

    const startTime = performance.now();
    try {
      const outcome = await activateAndVerify(this.adtclient, {
        objectUrl,
        parentUri: args?.parentUri
      });
      this.trackRequest(startTime, true);
      steps.push({ step: 'activate', ...outcome });
      return this.answer({
        status: outcome.success ? 'success' : 'error',
        objectUrl,
        activated: outcome.success,
        steps,
        hint: outcome.success
          ? 'Active. Read it back with getObjectSource version="active" if you want the proof in hand.'
          : 'The source is written but not active, so the system still runs the old code. Fix it and activate again - nothing was rolled back.'
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      steps.push({ step: 'activate', error: describeAdtError(error).error });
      return this.answer({
        status: 'error',
        objectUrl,
        activated: false,
        steps,
        hint: 'The source is written but not active. Nothing was rolled back; correct it and run activateSafe.'
      });
    }
  }

  private async releaseLock(
    objectUrl: string,
    lockHandle: string
  ): Promise<{ released: boolean; error?: string }> {
    return releaseLock(
      this.adtclient,
      objectUrl,
      lockHandle,
      (start, ok) => this.trackRequest(start, ok)
    );
  }

  private answer(payload: Record<string, unknown>) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(payload)
      }]
    };
  }

  async handleSetObjectSource(args: any): Promise<any> {
    // As for patchObjectSource: a lock this process already holds is the one
    // to write with, and asking the caller to carry the handle between calls
    // is friction with no upside.
    const objectUrl = this.objectUrlOf(args?.objectSourceUrl || '');
    const held = lockRegistry.forUrl(objectUrl);
    const lockHandle = args?.lockHandle || held?.lockHandle;
    if (!lockHandle) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No lockHandle given and none recorded for ${objectUrl}. Call lock on that URL first.`
      );
    }

    const startTime = performance.now();
    try {
      // dropSession/logout reset the client to stateless; writing source requires a stateful session
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.setObjectSource(
        args.objectSourceUrl,
        args.source,
        lockHandle,
        args.transport
      );
      // Cache the just-written source so a follow-up syntaxCheckCode can reuse it
      // without the caller re-sending it (issue #2).
      sourceCache.set(args.objectSourceUrl, args.source);
      this.trackRequest(startTime, true);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              updated: true
            })
          }
        ]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to set object source');
    }
  }
}

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import { session_types } from "abap-adt-api";
import type { ObjectSourceOptions, ObjectVersion } from "abap-adt-api";
import { sourceCache, sourceCacheKey } from '../lib/sourceCache';
import { lockRegistry } from '../lib/lockRegistry';
import { resolveEdits, applyEdits, buildDiff, newlineOf, PatchError } from '../lib/sourcePatch';
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
              description: 'Source URL, e.g. /sap/bc/adt/oo/classes/zcl_mm/source/main'
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
      const fullSource = await this.adtclient.getObjectSource(args.objectSourceUrl, options);
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
   */
  private objectUrlOf(sourceUrl: string): string {
    return sourceUrl.split('#')[0].replace(/\/source\/main$/, '').replace(/\/source$/, '');
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
    const edits = this.parseObjectArg<SourceEdit[]>(args?.edits, 'edits');
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'edits must be a non-empty array.');
    }

    const objectUrl = this.objectUrlOf(args.objectSourceUrl);
    const held = lockRegistry.get(objectUrl);
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
        return this.answer({
          status: 'success',
          written: false,
          note: 'The edits produce exactly the current source; nothing was written.',
          linesBefore,
          linesAfter
        });
      }

      if (dryRun) {
        this.trackRequest(startTime, true);
        return this.answer({
          status: 'success',
          written: false,
          dryRun: true,
          edits: resolved.length,
          linesBefore,
          linesAfter,
          diff
        });
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

      return this.answer({
        status: 'success',
        written: true,
        edits: resolved.length,
        linesBefore,
        linesAfter,
        lockHandleFrom: args?.lockHandle ? 'argument' : 'lockRegistry',
        diff,
        hint: 'Written to the inactive version. Activate with activateSafe, then verify with getObjectSource version="active".'
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to patch object source');
    }
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
    const startTime = performance.now();
    try {
      // dropSession/logout reset the client to stateless; writing source requires a stateful session
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.setObjectSource(
        args.objectSourceUrl,
        args.source,
        args.lockHandle,
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

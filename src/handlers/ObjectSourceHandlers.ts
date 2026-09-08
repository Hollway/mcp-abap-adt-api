import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import { session_types } from "abap-adt-api";
import type { ObjectSourceOptions, ObjectVersion } from "abap-adt-api";
import { sourceCache, sourceCacheKey } from '../lib/sourceCache';

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
        name: 'setObjectSource',
        description: 'Sets source code for ABAP objects',
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

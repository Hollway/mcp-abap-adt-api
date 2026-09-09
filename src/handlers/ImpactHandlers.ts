import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { objectUrlFor, sourceUrlFor } from '../lib/packageWalk';
import { locateMethod, classSourceUrl, interfaceSourceUrl } from '../lib/symbolPosition';
import { rollUpUsages } from '../lib/impact';
import type { ImpactObject, UsageRow } from '../lib/impact';

/**
 * What depends on an object - the question asked before changing one.
 *
 * usageReferences already answers it, in a form that cannot be read: a flat
 * list that is really a tree of packages, objects and the places inside them.
 * ZCL_MM_RETURN answers with 352 rows, about 178,000 characters, for what is
 * in the end a list of some 40 objects. This rolls that up, and can follow the
 * callers one step further to show what depends on them in turn.
 */

const MAX_BRANCHES = 25;

export class ImpactHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'impactOf',
        description: 'What depends on an object, or on one method of it: the objects that use it, the places inside them, and the package each belongs to. This is usageReferences rolled up into an answer that can be read - that call returns a tree of package, object and member rows, which for a widely used class means hundreds of rows and over a hundred thousand characters for a list of forty objects. Usages in test includes are marked as such, standard SAP objects are left out unless asked for, and depth=2 follows the callers one step further to show what depends on them in turn. A method with no callers looks the same as one reached only dynamically, so an empty answer says so rather than reading as proof.',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: {
              type: 'string',
              description: 'Object name, e.g. ZCL_MM_RETURN. Use with objectType.'
            },
            objectType: {
              type: 'string',
              description: 'ADT type: CLAS/OC, INTF/OI, PROG/P, FUGR/F, TABL/DT, DDLS/DF. Defaults to CLAS/OC.'
            },
            objectUrl: {
              type: 'string',
              description: 'ADT object URL, for a type objectName cannot address.'
            },
            methodName: {
              type: 'string',
              description: 'Narrow it to one method of the class or interface. The position inside the source is worked out here.'
            },
            depth: {
              type: 'number',
              description: '1 (default) for what uses the object; 2 also reports what uses those, with the object each was reached through.'
            },
            onlyCustom: {
              type: 'boolean',
              description: 'Keep only Z*, Y* and /namespace/ objects (default true). The count of standard objects left out is reported.'
            },
            includeTests: {
              type: 'boolean',
              description: 'Include usages that are only in test includes (default true); they are marked testOnly either way.'
            },
            packageName: {
              type: 'string',
              description: 'Only usages in this package.'
            },
            maxObjects: {
              type: 'number',
              description: 'How many objects to list. Default 100.'
            },
            maxPlacesPerObject: {
              type: 'number',
              description: 'How many places to list per object. Default 8; the rest are counted.'
            }
          },
          required: []
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'impactOf':
        return this.handleImpactOf(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown impact tool: ${toolName}`);
    }
  }

  private resolveTarget(args: any): { objectUrl: string; label: string; objectType: string; name: string } {
    const name = String(args?.objectName || '').trim();
    const objectType = String(args?.objectType || 'CLAS/OC').trim().toUpperCase();
    if (name) {
      const url = objectUrlFor(objectType, name);
      if (!url) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `No ADT URL is known for a ${objectType}. Pass objectUrl instead.`
        );
      }
      return { objectUrl: url, label: `${name.toUpperCase()} (${objectType})`, objectType, name };
    }
    const objectUrl = String(args?.objectUrl || '').trim();
    if (!objectUrl) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'What should be checked? Pass objectName (with objectType) or objectUrl.'
      );
    }
    return { objectUrl, label: objectUrl, objectType, name: '' };
  }

  /** The position of a method inside its source, which is what ADT asks for. */
  private async methodPosition(
    args: any,
    objectType: string,
    name: string,
    methodName: string
  ): Promise<{ sourceUrl: string; line: number; column: number; kind: string }> {
    if (!name) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'methodName needs objectName as well: the position of the method is found in the source of the class.'
      );
    }
    const sourceUrl = objectType.startsWith('INTF')
      ? interfaceSourceUrl(name)
      : objectType.startsWith('CLAS')
        ? classSourceUrl(name)
        : sourceUrlFor(objectType, name);
    if (!sourceUrl) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `methodName only applies to a class or an interface; ${objectType} has no methods.`
      );
    }
    const source = await this.readClient.getObjectSource(sourceUrl);
    const at = locateMethod(source, methodName);
    if (!at) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No declaration or implementation of '${methodName}' in ${name.toUpperCase()}. Check the name with classComponents or sourceOutline.`
      );
    }
    return { sourceUrl, line: at.line, column: at.column, kind: at.kind };
  }

  /**
   * Ask for the references. As in whereUsedMethod, which URL carries the
   * position is a backend detail: the source URL matches how ADT itself asks,
   * and the object URL is tried when that comes back empty.
   */
  private async references(url: string, line?: number, column?: number): Promise<UsageRow[]> {
    const rows = await this.readClient.usageReferences(url, line, column);
    return (rows || []) as UsageRow[];
  }

  async handleImpactOf(args: any): Promise<any> {
    const { objectUrl, label, objectType, name } = this.resolveTarget(args);
    const methodName = String(args?.methodName || '').trim();
    const depth = Number(args?.depth) === 2 ? 2 : 1;
    const options = {
      onlyCustom: args?.onlyCustom !== false,
      includeTests: args?.includeTests !== false,
      packageName: args?.packageName,
      maxObjects: args?.maxObjects,
      maxPlacesPerObject: args?.maxPlacesPerObject
    };

    const startTime = performance.now();
    try {
      let rows: UsageRow[];
      let position: { sourceUrl: string; line: number; column: number; kind: string } | undefined;

      if (methodName) {
        position = await this.methodPosition(args, objectType, name, methodName);
        rows = await this.references(position.sourceUrl, position.line, position.column);
        if (rows.length === 0) rows = await this.references(objectUrl, position.line, position.column);
      } else {
        rows = await this.references(objectUrl);
      }

      const direct = rollUpUsages(rows, options);

      // One step further: what uses the objects that use this one. Bounded,
      // because every branch is another round trip.
      let indirect: Array<ImpactObject & { via: string[] }> | undefined;
      let branchesFollowed = 0;
      let branchesSkipped = 0;
      if (depth === 2) {
        const merged = new Map<string, ImpactObject & { via: Set<string> }>();
        const branches = direct.objects.filter(entry => entry.objectUrl);
        for (const branch of branches) {
          if (branchesFollowed >= MAX_BRANCHES) { branchesSkipped++; continue; }
          branchesFollowed++;
          let branchRows: UsageRow[] = [];
          try {
            branchRows = await this.references(branch.objectUrl!);
          } catch {
            // A branch that cannot be read is not worth failing the answer for.
            continue;
          }
          for (const entry of rollUpUsages(branchRows, options).objects) {
            if (entry.name === branch.name && entry.type === branch.type) continue;
            const key = `${entry.type}|${entry.name}`;
            const existing = merged.get(key);
            if (existing) { existing.via.add(branch.name); continue; }
            merged.set(key, { ...entry, via: new Set([branch.name]) });
          }
        }
        // Objects already listed as direct users are not news at the second level.
        const directKeys = new Set(direct.objects.map(entry => `${entry.type}|${entry.name}`));
        indirect = [...merged.entries()]
          .filter(([key]) => !directKeys.has(key))
          .map(([, entry]) => ({ ...entry, via: [...entry.via].sort() }))
          .sort((a, b) => b.places.length - a.places.length || a.name.localeCompare(b.name))
          .slice(0, Math.max(1, Number(options.maxObjects) || 100));
      }

      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            target: {
              object: label,
              ...(methodName ? { method: methodName.toUpperCase() } : {}),
              ...(position ? { resolvedAt: position } : {})
            },
            depth,
            rowsFromBackend: rows.length,
            summary: direct.summary,
            ...(direct.standardObjectsHidden
              ? { standardObjectsHidden: direct.standardObjectsHidden }
              : {}),
            ...(direct.objectsHidden
              ? {
                objectsHidden: direct.objectsHidden,
                note: `Listing ${direct.objects.length} of ${direct.summary.objects} objects; raise maxObjects to see the rest.`
              }
              : {}),
            usedBy: direct.objects,
            ...(indirect
              ? {
                indirect,
                indirectNote: `What uses those, followed through ${branchesFollowed} of ${direct.objects.length} callers${branchesSkipped ? `; ${branchesSkipped} not followed (limit ${MAX_BRANCHES})` : ''}.`
              }
              : {}),
            ...(direct.summary.objects === 0
              ? {
                emptyNote: methodName
                  ? 'Nothing came back. A private method used only inside its own class, or one reached only dynamically (CALL METHOD (name)), looks exactly like this.'
                  : 'Nothing came back. An object reached only dynamically, or only from outside this system, looks exactly like this.'
              }
              : {})
          }, null, 2)
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (error instanceof McpError) throw error;
      throw wrapAdtError(error, `Failed to work out what depends on ${label}`);
    }
  }
}

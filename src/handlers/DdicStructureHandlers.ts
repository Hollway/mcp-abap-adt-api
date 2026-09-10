import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError, describeAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import { takeLock, releaseLock } from '../lib/lockCycle';
import { readValidation } from '../lib/newObjectValidation';
import { activateAndVerify } from '../lib/activation';
import {
  structureUrl,
  structureSourceUrl,
  buildStructureSource,
  parseStructureSource,
  type StructureField
} from '../lib/ddicStructure';

/**
 * Tables and structures.
 *
 * Reading one was not possible in any useful sense: searchObject answers a
 * table with a SAPGUI bridge URI, objectStructure gives its metadata, and
 * neither shows a field. The definition is served as DDL text from
 * ddic/structures - for tables as well as structures - and that text carries
 * the fields, their types and the key flags.
 *
 * Creating a transparent table is not offered, and not because of a policy
 * here: this backend has no ddic/tables collection, so the creation the
 * library would attempt answers "Resource /sap/bc/adt/ddic/tables does not
 * exist". The technical settings a table needs - delivery class, buffering,
 * size category - are not in the source form either, so even a table created
 * some other way could not be finished through ADT. That is SE11 work.
 */
export class DdicStructureHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'getStructureSource',
        description: 'Read the definition of a table or structure as ADT serves it: the DDL text plus the parsed field list with types and key flags. Works for TABL/DT and TABL/DS alike - both come from the same endpoint. This is the way to see a table\'s fields: searchObject answers a table with a SAPGUI bridge URI and objectStructure shows only its metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Table or structure name, e.g. ZAPPSTEP.'
            },
            version: {
              type: 'string',
              description: 'Which version to read: "active" or "inactive". For DDIC the backend may answer with the working version either way, so prove an activation with inactiveObjects, not with this.'
            }
          },
          required: ['name']
        }
      },
      {
        name: 'createStructure',
        description: 'Create a structure (TABL/DS) and give it its fields in one call: validate the name, create, write the definition, syntax check, activate, verify. Fields are passed as data - the DDL is built here, including the opening keyword, which differs between releases and is taken from the object the backend just created. A quantity or currency field needs its unit annotation or the activation refuses it: pass unitField or currencyField and the reference is built and qualified for you. A transparent table (TABL/DT) cannot be created over ADT at all on a classic ERP system - see the note in getStructureSource. Nothing is rolled back: the answer says which step stopped and in what state the object was left.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the new structure, e.g. ZDEV_MCP_STRUC.'
            },
            packageName: {
              type: 'string',
              description: 'Package. $TMP for a local object; anything else needs a transport request.'
            },
            description: {
              type: 'string',
              description: 'Description; becomes @EndUserText.label.'
            },
            fields: {
              type: 'array',
              description: 'The fields, in order: [{name, type, keyField, notNull, annotations}]. type is a data element (WERKS_D) or a built-in type (abap.char(10)).',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Field name, e.g. WERKS.' },
                  type: { type: 'string', description: 'Data element or built-in type.' },
                  keyField: { type: 'boolean', description: 'Part of the key. Key fields are written NOT NULL.' },
                  notNull: { type: 'boolean', description: 'NOT NULL without being a key field.' },
                  unitField: {
                    type: 'string',
                    description: 'For a quantity field (MENGE_D and the like): the field of this same structure holding its unit, e.g. MEINS. Required - a quantity field without one cannot be activated. The reference is qualified with the structure name for you.'
                  },
                  currencyField: {
                    type: 'string',
                    description: 'For an amount field (DMBTR, NETWR): the field of this same structure holding its currency, e.g. WAERS. Same rule as unitField.'
                  },
                  annotations: {
                    type: 'array',
                    description: 'Any further annotations for this field, written above it verbatim.',
                    items: { type: 'string' }
                  }
                },
                required: ['name', 'type']
              }
            },
            enhancementCategory: {
              type: 'string',
              description: 'Enhancement category, default NOT_EXTENSIBLE. Pass e.g. EXTENSIBLE_CHARACTER_NUMERIC.'
            },
            language: {
              type: 'string',
              description: 'Master language. Defaults to the logon language - creating in EN files the description where nobody will look for it.'
            },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task.'
            },
            activate: {
              type: 'boolean',
              description: 'Set false to leave the structure inactive.'
            },
            dryRun: {
              type: 'boolean',
              description: 'Validate the name and show the DDL that would be written, without creating anything.'
            }
          },
          required: ['name', 'packageName', 'description', 'fields']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'getStructureSource':
        return this.handleGetStructureSource(args);
      case 'createStructure':
        return this.handleCreateStructure(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown structure tool: ${toolName}`);
    }
  }

  private answer(payload: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  async handleGetStructureSource(args: any): Promise<any> {
    const name = String(args?.name || '').trim().toUpperCase();
    if (!name) {
      throw new McpError(ErrorCode.InvalidParams, 'Which table or structure? Pass name.');
    }
    const url = structureSourceUrl(name);
    const startTime = performance.now();
    try {
      const response = await this.readClient.httpClient.request(url, {
        method: 'GET',
        ...(args?.version ? { qs: { version: String(args.version) } } : {})
      });
      this.trackRequest(startTime, true);
      const source = String(response.body ?? '');
      const parsed = parseStructureSource(source);
      return this.answer({
        status: 'success',
        name,
        objectUrl: structureUrl(name),
        sourceUrl: url,
        label: parsed.label,
        fieldCount: parsed.fields.length,
        fields: parsed.fields,
        ...(parsed.other.length ? { unparsedLines: parsed.other } : {}),
        source
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      const info = describeAdtError(error);
      throw wrapAdtError(
        error,
        info.status === 404
          ? `No table or structure ${name}. Both types are served from ddic/structures - a name that is neither answers 404`
          : `Failed to read the definition of ${name}`
      );
    }
  }

  async handleCreateStructure(args: any): Promise<any> {
    const name = String(args?.name || '').trim().toUpperCase();
    const packageName = String(args?.packageName || '').trim().toUpperCase();
    if (!name || !packageName || !args?.description) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass name, packageName and description.');
    }
    const fields = this.parseObjectArg<StructureField[]>(args?.fields, 'fields');
    if (!Array.isArray(fields) || !fields.length) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass fields: [{name, type}] - a structure needs at least one.');
    }
    if (!args?.transport && packageName !== '$TMP') {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Creating a structure in ${packageName} needs a transport request (the request itself, not a developer task). Only $TMP goes without one.`
      );
    }

    const url = structureUrl(name);
    const sourceUrl = structureSourceUrl(name);
    const parentPath = `/sap/bc/adt/packages/${encodeURIComponent(packageName.toLowerCase())}`;
    const language = String(args?.language || this.adtclient.language || 'EN').toUpperCase();
    const steps: Record<string, unknown>[] = [];

    // Build it once up front: a bad field list should never reach the backend
    // as a created-but-empty object.
    let preview: string;
    try {
      preview = buildStructureSource({
        name,
        description: String(args.description),
        fields,
        enhancementCategory: args?.enhancementCategory
      });
    } catch (error: any) {
      throw new McpError(ErrorCode.InvalidParams, error?.message || 'The field list could not be turned into DDL.');
    }

    const validateStart = performance.now();
    let validation: any;
    try {
      validation = await this.adtclient.validateNewObject({
        objtype: 'TABL/DS' as any,
        objname: name,
        packagename: packageName,
        description: String(args.description)
      });
      this.trackRequest(validateStart, true);
    } catch (error: any) {
      this.trackRequest(validateStart, false);
      throw wrapAdtError(error, `Failed to validate the new structure ${name}. Nothing was created`);
    }
    const verdict = readValidation(validation);
    steps.push({
      step: 'validate',
      ...validation,
      ...(verdict.silent ? { note: 'The backend answered without a verdict. Taken as no objection.' } : {})
    });
    if (verdict.objection) {
      return this.answer({
        status: 'error',
        created: false,
        name,
        objectUrl: url,
        steps,
        hint: `The system refused the name: ${verdict.objection} Nothing was created.`
      });
    }

    if (args?.dryRun === true) {
      return this.answer({
        status: 'success',
        dryRun: true,
        created: false,
        name,
        objectUrl: url,
        packageName,
        steps,
        source: preview,
        note: 'The name is free. This is the DDL that would be written - the opening keyword is taken from the created object, so it may differ from this preview on another release.'
      });
    }

    const createStart = performance.now();
    try {
      await this.adtclient.createObject({
        objtype: 'TABL/DS' as any,
        name,
        parentName: packageName,
        description: String(args.description),
        parentPath,
        responsible: args?.responsible,
        transport: args?.transport,
        language,
        masterLanguage: language
      });
      this.trackRequest(createStart, true);
    } catch (error: any) {
      this.trackRequest(createStart, false);
      throw wrapAdtError(error, `Failed to create the structure ${name}`);
    }
    steps.push({ step: 'create', objectUrl: url, packageName, language });

    // The created object carries a one-field stub whose opening keyword is the
    // one this release accepts: `define type` here, `define structure` on
    // newer ones. Reusing it is the difference between a write that lands and
    // "Can't save due to errors in source".
    let stub = '';
    const stubStart = performance.now();
    try {
      const response = await this.adtclient.httpClient.request(sourceUrl, { method: 'GET' });
      stub = String(response.body ?? '');
      this.trackRequest(stubStart, true);
    } catch (error: any) {
      this.trackRequest(stubStart, false);
      steps.push({ step: 'readStub', error: describeAdtError(error).error, note: 'Falling back to "define type".' });
    }
    const source = buildStructureSource({
      name,
      description: String(args.description),
      fields,
      stub,
      enhancementCategory: args?.enhancementCategory
    });

    let lockHandle: string;
    try {
      const lock = await takeLock(this.adtclient, url, undefined, (start, ok) => this.trackRequest(start, ok));
      lockHandle = lock.lockHandle;
    } catch (error: any) {
      steps.push({ step: 'lock', error: describeAdtError(error).error });
      return this.answer({
        status: 'error',
        created: true,
        written: false,
        name,
        objectUrl: url,
        sourceUrl,
        steps,
        source,
        hint: 'The structure exists with its placeholder field and could not be locked. Lock it and write the source below with setObjectSource, or delete it with deleteObject.'
      });
    }
    steps.push({ step: 'lock', lockHandle });

    const writeStart = performance.now();
    try {
      await this.adtclient.setObjectSource(sourceUrl, source, lockHandle, args?.transport);
      this.trackRequest(writeStart, true);
      steps.push({ step: 'write', lines: source.split('\n').length });
    } catch (error: any) {
      this.trackRequest(writeStart, false);
      steps.push({ step: 'write', error: describeAdtError(error).error });
      steps.push({ step: 'unlock', ...(await this.release(url, lockHandle)) });
      return this.answer({
        status: 'error',
        created: true,
        written: false,
        name,
        objectUrl: url,
        sourceUrl,
        steps,
        source,
        hint: 'The structure exists with its placeholder field; the definition was refused. The backend checks DDL on save, so the message in the write step is the reason.'
      });
    }

    // A DDIC error here is far clearer than the same error from activation:
    // "Annotation with reference to unit code for field MENGE is missing"
    // against "укажите ссылочную таблицу И ссылочное поле".
    let syntax: any[] = [];
    const checkStart = performance.now();
    try {
      syntax = await this.adtclient.syntaxCheck(sourceUrl, sourceUrl, source) as any[];
      this.trackRequest(checkStart, true);
      if (syntax?.length) steps.push({ step: 'syntaxCheck', messages: syntax });
    } catch (error: any) {
      this.trackRequest(checkStart, false);
      steps.push({ step: 'syntaxCheck', error: describeAdtError(error).error });
    }

    const unlock = await this.release(url, lockHandle);
    steps.push({ step: 'unlock', ...unlock });

    const errors = (syntax || []).filter(m => String(m?.severity || '').toUpperCase() === 'E');
    if (args?.activate === false || errors.length || !unlock.released) {
      return this.answer({
        status: errors.length || !unlock.released ? 'error' : 'success',
        created: true,
        written: true,
        activated: false,
        name,
        objectUrl: url,
        sourceUrl,
        steps,
        source,
        hint: errors.length
          ? 'Written but not activated: the definition does not check out, and activation would fail with a worse message. Correct it with setObjectSource and run activateSafe.'
          : !unlock.released
            ? 'The lock could not be released, and activation fails while it is held. Release it (unlockAll) and run activateSafe.'
            : 'Written to the inactive version and not activated, so nothing can use it yet.'
      });
    }

    const activateStart = performance.now();
    try {
      const outcome = await activateAndVerify(this.adtclient, {
        objectUrl: url,
        objectName: name,
        parentUri: parentPath
      });
      this.trackRequest(activateStart, true);
      steps.push({ step: 'activate', ...outcome });
      return this.answer({
        status: outcome.success ? 'success' : 'error',
        created: true,
        written: true,
        activated: outcome.success,
        name,
        objectUrl: url,
        sourceUrl,
        fieldCount: fields.length,
        steps,
        source,
        hint: outcome.success
          ? 'Active and usable. Read it back with getStructureSource.'
          : 'Written but not active, so nothing can use it yet. Nothing was rolled back; correct it and run activateSafe. Note that reading the source with version="active" is not proof for DDIC - the backend may answer with the working version either way.'
      });
    } catch (error: any) {
      this.trackRequest(activateStart, false);
      steps.push({ step: 'activate', error: describeAdtError(error).error });
      return this.answer({
        status: 'error',
        created: true,
        written: true,
        activated: false,
        name,
        objectUrl: url,
        sourceUrl,
        steps,
        source,
        hint: 'Written but not active. Nothing was rolled back; correct it and run activateSafe.'
      });
    }
  }

  private async release(objectUrl: string, lockHandle: string) {
    return releaseLock(this.adtclient, objectUrl, lockHandle, (start, ok) => this.trackRequest(start, ok));
  }
}

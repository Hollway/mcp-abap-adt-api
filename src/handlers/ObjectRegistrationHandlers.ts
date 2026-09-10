import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import { session_types } from 'abap-adt-api';
import { activateAndVerify } from '../lib/activation';
import { releaseLock, takeLock } from '../lib/lockCycle';
import { readValidation } from '../lib/newObjectValidation';
import { describeAdtError } from '../lib/adtError';
import { sourceCache } from '../lib/sourceCache';

/**
 * Where the source of a freshly created object lives.
 *
 * Only the types whose source URL follows from the name are here: a type this
 * map does not cover is refused with the two-step way out, which is better
 * than guessing a URL and writing the source of a class into nowhere.
 */
const SOURCE_URLS: Record<string, (name: string, parentName: string) => string> = {
  'CLAS/OC': name => `/sap/bc/adt/oo/classes/${name}/source/main`,
  'INTF/OI': name => `/sap/bc/adt/oo/interfaces/${name}/source/main`,
  'PROG/P': name => `/sap/bc/adt/programs/programs/${name}/source/main`,
  'PROG/I': name => `/sap/bc/adt/programs/includes/${name}/source/main`,
  'FUGR/F': name => `/sap/bc/adt/functions/groups/${name}/source/main`,
  'FUGR/FF': (name, parentName) =>
    `/sap/bc/adt/functions/groups/${parentName}/fmodules/${name}/source/main`,
  'FUGR/I': (name, parentName) =>
    `/sap/bc/adt/functions/groups/${parentName}/includes/${name}/source/main`,
  'DDLS/DF': name => `/sap/bc/adt/ddic/ddl/sources/${name}/source/main`,
  'TABL/DS': name => `/sap/bc/adt/ddic/structures/${name}/source/main`
};

/**
 * Types the backend cannot create, with the reason worth reading.
 *
 * A transparent table is the one that costs the most time to discover: the
 * type map inside abap-adt-api points at /sap/bc/adt/ddic/tables, a collection
 * a classic ERP system does not have at all.
 */
const UNCREATABLE: Record<string, string> = {
  'TABL/DT': 'A transparent table cannot be created over ADT on this kind of system: there is no ddic/tables collection, so the creation answers "Resource /sap/bc/adt/ddic/tables does not exist". Its technical settings - delivery class, buffering, size category - are not in the source form either, so it could not be finished here anyway. Create it in SE11; createStructure covers TABL/DS, and getStructureSource reads either.',
  'DEVC/K': 'A package cannot be created over ADT on this kind of system: /sap/bc/adt/packages is not served at all - only /sap/bc/adt/packages/settings is - so the creation, the name validation and even reading an existing package all answer 404. Create it in SE80 or SE21. nodeContents lists what is in a package, and changePackagePreview shows what moving an object into one would mean.'
};

const encodedName = (name: string): string => {
  const lower = name.trim().toLowerCase();
  return lower.includes('/') ? encodeURIComponent(lower) : lower;
};

export class ObjectRegistrationHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'objectRegistrationInfo',
        description: 'The workbench registration of an object: which transport layer and package it belongs to, and whether it can be changed here. This is what says an object is foreign or read-only before a lock fails on it.',
        inputSchema: {
          type: 'object',
          properties: {
            objectUrl: { type: 'string' }
          },
          required: ['objectUrl']
        }
      },
      {
        name: 'validateNewObject',
        description: 'Ask the system whether a new object may be created under this name, in this package, with this description - the check ADT runs before a creation dialog is accepted. It answers with the reason a name is refused (already taken, reserved, wrong namespace). Careful with the answer: some collections reply 200 with an empty body, which the library reads as failure, so a free name can look refused; createObject and createAndWrite handle that themselves.',
        inputSchema: {
          type: 'object',
          properties: {
            options: {
              type: 'object',
              description: 'Validation options: {objtype, objname, packagename, description} for an object, or the group/package variants. A JSON string is accepted too.'
            }
          },
          required: ['options']
        }
      },
      {
        name: 'createObject',
        description: 'Create a new ABAP object. Report includes (PROG/I) are the one type this cannot create - it refuses them and points at createInclude.',
        inputSchema: {
          type: 'object',
          properties: {
            objtype: { type: 'string' },
            name: { type: 'string' },
            parentName: { type: 'string' },
            description: { type: 'string' },
            parentPath: { type: 'string' },
            responsible: { type: 'string' },
            transport: { type: 'string' }
          },
          required: ['objtype', 'name', 'parentName', 'description', 'parentPath']
        }
      },
      {
        name: 'createInclude',
        description: 'Create a report include (PROG/I). Use this instead of createObject for includes: abap-adt-api builds the creation body without the reference to the main program, so the backend rejects it (400/500) whatever parameters are passed. This posts the include document together with its context reference.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Include name, e.g. ZR_APP_FOO_F01.'
            },
            description: {
              type: 'string',
              description: 'Short description.'
            },
            packageName: {
              type: 'string',
              description: 'Development package, e.g. ZAPP_BASE.'
            },
            mainProgram: {
              type: 'string',
              description: 'Main program the include belongs to, e.g. ZR_APP_FOO. This is the reference createObject fails to send.'
            },
            transport: {
              type: 'string',
              description: 'Transport request.'
            },
            responsible: {
              type: 'string',
              description: 'Responsible user; defaults to the logon user.'
            },
            masterLanguage: {
              type: 'string',
              description: 'Master language; defaults to the logon language, or EN.'
            }
          },
          required: ['name', 'description', 'packageName', 'mainProgram']
        }
      },
      {
        name: 'createAndWrite',
        description: 'Create an object and put its source in it, in one call: validate the name, create, lock, write the source, unlock, activate with verification. Creating and writing are separate calls in ADT, and an object created without source is an empty shell that fails activation - this keeps the two halves together. Report includes (PROG/I) are created the way createInclude does it, so they work here too; pass mainProgram. Nothing is rolled back on failure: the answer says which step stopped it.',
        inputSchema: {
          type: 'object',
          properties: {
            objtype: {
              type: 'string',
              description: 'ADT type: CLAS/OC, INTF/OI, PROG/P, PROG/I, FUGR/F, FUGR/FF or FUGR/I.'
            },
            name: {
              type: 'string',
              description: 'Object name, e.g. ZCL_APP_FOO.'
            },
            description: {
              type: 'string',
              description: 'Short description.'
            },
            packageName: {
              type: 'string',
              description: 'Development package. $TMP needs no transport.'
            },
            source: {
              type: 'string',
              description: 'The complete source of the object. For a class this is the whole CLASS ... ENDCLASS pair, definition and implementation.'
            },
            mainProgram: {
              type: 'string',
              description: 'For PROG/I: the program the include belongs to. Required for an include, ignored otherwise.'
            },
            functionGroup: {
              type: 'string',
              description: 'For FUGR/FF and FUGR/I: the function group holding the object.'
            },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task. Not needed in $TMP.'
            },
            responsible: {
              type: 'string',
              description: 'Responsible user; defaults to the logon user.'
            },
            language: {
              type: 'string',
              description: 'Language of the description, and the master language of the object. Defaults to the logon language - the underlying library would use EN, which files the texts under a language the developer may never read.'
            },
            activate: {
              type: 'boolean',
              description: 'Activate at the end (default true).'
            },
            dryRun: {
              type: 'boolean',
              description: 'Validate the name and report the URLs that would be used, creating nothing.'
            }
          },
          required: ['objtype', 'name', 'description', 'packageName', 'source']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'createAndWrite':
        return this.handleCreateAndWrite(args);
      case 'objectRegistrationInfo':
        return this.handleObjectRegistrationInfo(args);
      case 'validateNewObject':
        return this.handleValidateNewObject(args);
      case 'createObject':
        return this.handleCreateObject(args);
      case 'createInclude':
        return this.handleCreateInclude(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown object registration tool: ${toolName}`);
    }
  }

  private xmlAttr(value: string): string {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Create a program include.
   *
   * abap-adt-api routes PROG/I through its generic createBodySimple, which
   * emits only a packageRef - the include document needs a context reference
   * to its main program as well, so the backend answers 400 or 500 no matter
   * which parentPath is passed (confirmed on separate days, with brand-new
   * names, which rules out a name collision). The document is built here
   * instead and posted through the library's own HTTP client, so cookies, CSRF
   * token and session handling stay exactly as for every other call.
   */
  async handleCreateInclude(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const name = String(args.name || '').toUpperCase();
      const mainProgram = String(args.mainProgram || '').toUpperCase();
      const responsible = String(args.responsible || this.adtclient.username || '').toUpperCase();
      const language = (args.masterLanguage || this.adtclient.language || 'EN').toUpperCase();

      const body = `<?xml version="1.0" encoding="UTF-8"?>
<include:abapInclude xmlns:include="http://www.sap.com/adt/programs/includes"
    xmlns:adtcore="http://www.sap.com/adt/core"
    adtcore:description="${this.xmlAttr(args.description)}"
    adtcore:name="${this.xmlAttr(name)}" adtcore:type="PROG/I"
    adtcore:language="${this.xmlAttr(language)}" adtcore:masterLanguage="${this.xmlAttr(language)}"
    adtcore:responsible="${this.xmlAttr(responsible)}">
  <adtcore:packageRef adtcore:name="${this.xmlAttr(String(args.packageName).toUpperCase())}"/>
  <include:contextRef adtcore:name="${this.xmlAttr(mainProgram)}" adtcore:type="PROG/P"
    adtcore:uri="/sap/bc/adt/programs/programs/${encodeURIComponent(mainProgram.toLowerCase())}"/>
</include:abapInclude>`;

      const qs: Record<string, string> = {};
      if (args.transport) qs.corrNr = args.transport;

      await this.adtclient.httpClient.request('/sap/bc/adt/programs/includes', {
        body,
        headers: { 'Content-Type': 'application/*' },
        method: 'POST',
        qs
      });
      this.trackRequest(startTime, true);

      const url = `/sap/bc/adt/programs/includes/${encodeURIComponent(name.toLowerCase())}`;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            name,
            mainProgram,
            objectUrl: url,
            sourceUrl: `${url}/source/main`,
            hint: 'Created empty. Write its body with setObjectSource on the sourceUrl (the include needs a lock), and add the INCLUDE statement to the main program.'
          })
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to create include');
    }
  }

  private answer(payload: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  /**
   * Create an object and write its source, as one operation.
   *
   * Separately these are easy to get half-right: an object created and never
   * written is an empty shell that fails activation, and the failure surfaces
   * later as somebody else's problem. The order here is the one ADT requires -
   * create, lock, write, unlock, activate - and the lock is released before
   * the activation, which refuses to run while the session holds it.
   *
   * Nothing is rolled back. A created object with no source is reported as
   * such, with the way to finish or remove it, because deleting a caller's
   * half-finished work unasked is worse than telling them about it.
   */
  async handleCreateAndWrite(args: any): Promise<any> {
    const objtype = String(args?.objtype || '').trim().toUpperCase();
    const name = String(args?.name || '').trim().toUpperCase();
    const packageName = String(args?.packageName || '').trim().toUpperCase();
    const source = args?.source;

    const buildSourceUrl = SOURCE_URLS[objtype];
    if (UNCREATABLE[objtype]) {
      throw new McpError(ErrorCode.InvalidParams, UNCREATABLE[objtype]);
    }
    if (!buildSourceUrl) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `createAndWrite does not know where the source of a ${objtype || '(missing objtype)'} lives. ` +
        `It handles ${Object.keys(SOURCE_URLS).join(', ')}. For anything else, use createObject and then setObjectSource with the source URL from objectStructure.`
      );
    }
    if (!name || !packageName || !args?.description) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass name, description and packageName.');
    }
    if (typeof source !== 'string' || source.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass source - the complete source of the object.');
    }
    if (!args?.transport && packageName !== '$TMP') {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Creating ${name} in ${packageName} needs a transport request (the request itself, not a developer task). Only $TMP goes without one.`
      );
    }

    const parentName = objtype === 'PROG/I'
      ? String(args?.mainProgram || '').trim().toUpperCase()
      : objtype.startsWith('FUGR/F') && objtype !== 'FUGR/F'
        ? String(args?.functionGroup || '').trim().toUpperCase()
        : objtype === 'FUGR/I'
          ? String(args?.functionGroup || '').trim().toUpperCase()
          : packageName;
    if (!parentName) {
      throw new McpError(
        ErrorCode.InvalidParams,
        objtype === 'PROG/I'
          ? 'A report include needs mainProgram - the program it belongs to.'
          : 'This type needs functionGroup - the group the object belongs to.'
      );
    }

    const sourceUrl = buildSourceUrl(encodedName(name), encodedName(parentName));
    const objectUrl = sourceUrl.replace(/\/source\/main$/, '');
    const parentPath = `/sap/bc/adt/packages/${encodeURIComponent(packageName.toLowerCase())}`;
    // abap-adt-api defaults the creation document to EN and makes that the
    // master language; SAP files the object's texts under it. The logon
    // language is what the developer will actually read.
    const language = String(args?.language || this.adtclient.language || 'EN').toUpperCase();
    const steps: Record<string, unknown>[] = [];

    const validateStart = performance.now();
    let validation: any;
    try {
      // Deliberately the stateful client: this read belongs to the write
      // sequence, and every call of that sequence stays in the session that
      // will hold the lock.
      validation = await this.adtclient.validateNewObject(
        objtype === 'FUGR/FF' || objtype === 'FUGR/I'
          ? { objtype: objtype as any, objname: name, fugrname: parentName, description: String(args.description) }
          : { objtype: objtype as any, objname: name, packagename: packageName, description: String(args.description) }
      );
      this.trackRequest(validateStart, true);
    } catch (error: any) {
      this.trackRequest(validateStart, false);
      throw wrapAdtError(error, `Failed to validate the new object ${name}`);
    }
    // An answer that carries no verdict at all is not a refusal - see
    // lib/newObjectValidation for the endpoint that answers like that.
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
        objectUrl,
        name,
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
        objtype,
        objectUrl,
        sourceUrl,
        packageName,
        steps,
        note: 'The name is free. Nothing was created; drop dryRun to run the sequence.'
      });
    }

    const createStart = performance.now();
    try {
      if (objtype === 'PROG/I') {
        // createObject cannot make an include - the document it builds carries
        // no reference to the main program. createInclude posts the right one.
        await this.handleCreateInclude({
          name,
          description: args.description,
          packageName,
          mainProgram: parentName,
          transport: args?.transport,
          responsible: args?.responsible,
          masterLanguage: language
        });
      } else {
        await this.adtclient.createObject({
          objtype: objtype as any,
          name,
          parentName,
          description: String(args.description),
          parentPath,
          responsible: args?.responsible,
          transport: args?.transport,
          language,
          masterLanguage: language
        });
      }
      this.trackRequest(createStart, true);
    } catch (error: any) {
      this.trackRequest(createStart, false);
      throw wrapAdtError(error, `Failed to create ${name}`);
    }
    steps.push({ step: 'create', objectUrl, sourceUrl, packageName, language });

    let lockHandle: string;
    try {
      const lock = await takeLock(
        this.adtclient,
        objectUrl,
        undefined,
        (start, ok) => this.trackRequest(start, ok)
      );
      lockHandle = lock.lockHandle;
    } catch (error: any) {
      steps.push({ step: 'lock', error: describeAdtError(error).error });
      return this.answer({
        status: 'error',
        created: true,
        written: false,
        objectUrl,
        sourceUrl,
        name,
        steps,
        hint: 'The object exists but is empty, and it could not be locked. Lock it and write the source with setObjectSource, or remove it with deleteObject.'
      });
    }
    steps.push({ step: 'lock', lockHandle });

    const writeStart = performance.now();
    try {
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.setObjectSource(sourceUrl, source, lockHandle, args?.transport);
      sourceCache.set(sourceUrl, source);
      this.trackRequest(writeStart, true);
      steps.push({ step: 'write', characters: source.length });
    } catch (error: any) {
      this.trackRequest(writeStart, false);
      steps.push({ step: 'write', error: describeAdtError(error).error });
      const released = await releaseLock(
        this.adtclient,
        objectUrl,
        lockHandle,
        (start, ok) => this.trackRequest(start, ok)
      );
      steps.push({ step: 'unlock', ...released });
      return this.answer({
        status: 'error',
        created: true,
        written: false,
        objectUrl,
        sourceUrl,
        name,
        steps,
        hint: 'The object exists but is empty. Correct the source and write it with setObjectSource, or remove the object with deleteObject.'
      });
    }

    const unlock = await releaseLock(
      this.adtclient,
      objectUrl,
      lockHandle,
      (start, ok) => this.trackRequest(start, ok)
    );
    steps.push({ step: 'unlock', ...unlock });

    if (args?.activate === false) {
      return this.answer({
        status: 'success',
        created: true,
        written: true,
        activated: false,
        objectUrl,
        sourceUrl,
        name,
        steps,
        hint: 'Written to the inactive version and not activated, so nothing runs it yet.'
      });
    }
    if (!unlock.released) {
      return this.answer({
        status: 'error',
        created: true,
        written: true,
        activated: false,
        objectUrl,
        sourceUrl,
        name,
        steps,
        hint: 'The lock could not be released, and activation fails while it is held. Release it (unlockAll) and run activateSafe.'
      });
    }

    const activateStart = performance.now();
    try {
      const outcome = await activateAndVerify(this.adtclient, {
        objectUrl,
        objectName: name,
        parentUri: objtype === 'PROG/I' || objtype === 'PROG/P' ? parentPath : undefined
      });
      this.trackRequest(activateStart, true);
      steps.push({ step: 'activate', ...outcome });
      return this.answer({
        status: outcome.success ? 'success' : 'error',
        created: true,
        written: true,
        activated: outcome.success,
        objectUrl,
        sourceUrl,
        name,
        steps,
        hint: outcome.success
          ? 'Active. Read it back with getObjectSource version="active" for the proof.'
          : 'Written but not active, so the system does not run it. The activation messages are in the activate step; correct the source and run activateSafe.'
      });
    } catch (error: any) {
      this.trackRequest(activateStart, false);
      steps.push({ step: 'activate', error: describeAdtError(error).error });
      return this.answer({
        status: 'error',
        created: true,
        written: true,
        activated: false,
        objectUrl,
        sourceUrl,
        name,
        steps,
        hint: 'Written but not active. Nothing was rolled back; run activateSafe once the source is right.'
      });
    }
  }

  async handleObjectRegistrationInfo(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const info = await this.readClient.objectRegistrationInfo(args.objectUrl);
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            info
          })
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to get registration info');
    }
  }

  async handleValidateNewObject(args: any): Promise<any> {
    const startTime = performance.now();
    try {
      const result = await this.readClient.validateNewObject(this.parseObjectArg(args.options, 'options'));
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            result
          })
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to validate new object');
    }
  }

  async handleCreateObject(args: any): Promise<any> {    
    const startTime = performance.now();
    try {
      // PROG/I never succeeds here: the library builds the creation document
      // without the reference to the main program, so the backend answers 400
      // or 500 whatever is passed. Failing on the spot with the way out beats
      // a backend error that reads like a wrong package or a name collision.
      // Types this backend cannot create at all, refused with the reason
      // rather than with the 404 the collection answers.
      const requested = String(args?.objtype || '').trim().toUpperCase();
      if (UNCREATABLE[requested]) {
        throw new McpError(ErrorCode.InvalidParams, UNCREATABLE[requested]);
      }
      if (requested === 'PROG/I') {
        throw new McpError(
          ErrorCode.InvalidParams,
          'createObject cannot create a report include (PROG/I): the creation document it builds carries no reference to the main program, ' +
          'so the backend rejects it. Use createInclude instead - {name, description, packageName, mainProgram, transport}, ' +
          `where mainProgram is the program the include belongs to${args?.parentName ? ` (probably ${String(args.parentName).toUpperCase()})` : ''}.`
        );
      }

      const result = await this.adtclient.createObject(
        args.objtype,
        args.name,
        args.parentName,
        args.description,
        args.parentPath,
        args.responsible,
        args.transport
      );
      this.trackRequest(startTime, true);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            result
          })
        }]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (error instanceof McpError) {
        throw error;
      }
      throw wrapAdtError(error, 'Failed to create object');
    }
  }
}

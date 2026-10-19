import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { DdifHandlerBase } from './DdifHandlerBase';
import { wrapAdtError } from '../lib/adtError';
import { activationVerdict, directorySql, failedStep, packageExistsSql, packageName as checkedPackage } from '../lib/ddifWrite';
import { domainDdifSnippet, domainHeaderSql } from '../lib/domainDdif';
import {
  domainChangeSnippet,
  domainDirectorySql,
  domainPreviewToken,
  domainStateFromTables,
  domainTextsSql,
  domainVersionsSql,
  fixValueRows,
  fixValueTextsSql,
  fixValuesFingerprint,
  fixValuesSql,
  headerValue,
  languageOfIsoSql,
  planDomainChange,
  textLanguages
} from '../lib/domainChange';
import type { DomainTables, DomainVersion, FixValueRow } from '../lib/domainChange';
import { ddicObjectName } from '../lib/ddifWrite';
import type { ToolDefinition } from '../types/tools';
import { session_types } from 'abap-adt-api';
import type { ObjectVersion } from 'abap-adt-api';
import { lockRegistry } from '../lib/lockRegistry';
import { activateAndVerify } from '../lib/activation';
import { releaseLock, takeLock } from '../lib/lockCycle';
import { readValidation } from '../lib/newObjectValidation';
import { describeAdtError, hintOn404 } from '../lib/adtError';
import {
  dataElementUrl,
  domainUrl,
  ddicNameOf,
  mergeDataElement,
  mergeDomain,
  typeChoiceError,
  LABEL_LIMITS
} from '../lib/ddicProperties';
import type {
  DataElementPatch,
  DataElementState,
  DomainPatch,
  DomainState
} from '../lib/ddicProperties';

const VERSIONS: ObjectVersion[] = ['active', 'inactive', 'workingArea'];

/**
 * Not every release serves domains over REST.
 *
 * On the ERP system these tools were written against, every domain path -
 * /sap/bc/adt/ddic/domains/<name> and even its validation resource - answers
 * 404, and a search for a domain returns only a SAPGUI URI. Data elements are
 * served normally on the same system, which makes a bare 404 on a domain look
 * like a typo in the name.
 */
const domainEndpointHint = (error: unknown): string | undefined =>
  hintOn404(error, 'This release does not serve DDIC domains over ADT: /sap/bc/adt/ddic/domains answers 404 for every name, ' +
    'including its validation resource, and a domain search returns only a SAPGUI URI. ' +
    'Data elements are served normally on the same system. createDomain, getDomainProperties and setDomainProperties ' +
    'go through the dictionary tables and DDIF_DOMA_* there instead.');

const DDIF_REASON = 'This release serves no /sap/bc/adt/ddic/domains (404)';

const stampOf = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value ?? '').trim();

/**
 * The contents of DDIC domains and data elements.
 *
 * createObject can make either of them, but only as an empty shell: what makes
 * a domain a domain - its type, length, output format, fixed values - and what
 * makes a data element usable - a domain or a built-in type, plus the four
 * field labels - lives in a separate PUT that nothing here used to expose. The
 * result was an object that could be created through this server but never
 * finished or activated.
 *
 * The PUT carries the complete definition, so a change is sent as a patch
 * merged onto what the system currently holds (see lib/ddicProperties).
 */
export class DdicPropertyHandlers extends DdifHandlerBase {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'getDomainProperties',
        description: 'Read the definition of a DDIC domain: data type, length, decimals, output format, value table and fixed values. Takes the domain name; the object URL is accepted as well. On a release that serves no /sap/bc/adt/ddic/domains (404) the same fields are read from DD01L/DD01T/DD07L/DD07T and TADIR, "via" says so, languages are the one-character SAP keys, and textLanguages lists every language the domain has texts in.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Domain name, e.g. ZAPP_STATUS.'
            },
            domainUrl: {
              type: 'string',
              description: 'Object URL instead of the name, e.g. /sap/bc/adt/ddic/domains/zapp_status.'
            },
            version: {
              type: 'string',
              description: 'Which version to read: "active", "inactive" or "workingArea". Omit for the ADT default. Read from the tables, "inactive" and "workingArea" are both the version being edited.',
              enum: [...VERSIONS]
            },
            language: {
              type: 'string',
              description: 'Read from the tables only: the language of the texts, SAP key (R) or ISO code (RU). Defaults to the master language of the domain.'
            }
          }
        }
      },
      {
        name: 'setDomainProperties',
        description: 'Change the definition of an existing DDIC domain. The backend PUT replaces the whole definition, so anything not passed here is kept as the system currently has it - read, merge, write happens on this side. The lock is taken and released here unless you pass a handle or this server already holds one; outside $TMP a transport request is needed. Writes the inactive version - pass activate to finish the job, or run activateSafe afterwards. ' +
          'On a release that serves no /sap/bc/adt/ddic/domains (404) the change goes the way SE11 makes it, in two calls: the first only previews (each changed field from/to, the fixed values now and after, a previewToken), the second with that previewToken writes - RS_CORR_INSERT into the request (a task is lifted to its request), DDIF_DOMA_GET, the change on top of what was read, DDIF_DOMA_PUT, DDIF_DOMA_ACTIVATE, and if the activation fails the old definition is written back. There activation is the default; a fixed value that exists keeps its place and, given without text, its text, new values go after the last, and the values are numbered 1..n again with their translations moved along (DDIF_DOMA_PUT does that). A domain with an inactive version is refused. The result is read back from DD01L/DD07L/DD07T and the request.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Domain name.' },
            domainUrl: { type: 'string', description: 'Object URL instead of the name.' },
            description: { type: 'string', description: 'Short description.' },
            datatype: { type: 'string', description: 'DDIC data type, e.g. CHAR, NUMC, DEC, DATS.' },
            length: { type: 'number', description: 'Field length.' },
            decimals: { type: 'number', description: 'Decimal places.' },
            outputLength: { type: 'number', description: 'Output length; defaults to the field length.' },
            style: { type: 'string', description: 'Output style.' },
            conversionExit: { type: 'string', description: 'Conversion exit, e.g. ALPHA.' },
            signExists: { type: 'boolean', description: 'Value can be negative.' },
            lowercase: { type: 'boolean', description: 'Lower case allowed.' },
            ampmFormat: { type: 'boolean', description: 'AM/PM time format.' },
            valueTable: { type: 'string', description: 'Value table for the check.' },
            fixValues: {
              type: 'array',
              description: 'Fixed values, replacing the current list: [{low, high, text}]. Pass [] to clear them.',
              items: {
                type: 'object',
                properties: {
                  low: { type: 'string' },
                  high: { type: 'string' },
                  text: { type: 'string' }
                },
                required: ['low']
              }
            },
            properties: {
              type: 'object',
              description: 'Escape hatch: the complete DomainProperties document, sent as it is with no merge.'
            },
            metaData: {
              type: 'object',
              description: 'Escape hatch: the complete DomainMetaData document, sent as it is with no merge.'
            },
            lockHandle: {
              type: 'string',
              description: 'Lock handle. Omit it: the one this server holds for the object is used, and with none held the lock is taken and released here.'
            },
            activate: {
              type: 'boolean',
              description: 'Activate after the write (default false over ADT, true on the DDIF path). Over ADT only possible when this tool took the lock itself - activation is refused while a session holds one.'
            },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task (on the DDIF path a task is lifted to its request).'
            },
            language: {
              type: 'string',
              description: 'DDIF path only: the language the description and fixed value texts are read and written in, SAP key (R) or ISO code (RU). Defaults to the master language of the domain.'
            },
            previewToken: {
              type: 'string',
              description: 'DDIF path only: the token from the preview call. Without it nothing is written; with it, exactly the previewed change is, and only if the domain did not change in between.'
            }
          }
        }
      },
      {
        name: 'getDataElementProperties',
        description: 'Read the definition of a DDIC data element: its domain or built-in type, the four field labels, search help and parameter id. Takes the data element name; the object URL is accepted as well.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Data element name, e.g. ZAPP_STATUS.'
            },
            dataElementUrl: {
              type: 'string',
              description: 'Object URL instead of the name, e.g. /sap/bc/adt/ddic/dataelements/zapp_status.'
            },
            version: {
              type: 'string',
              description: 'Which version to read: "active", "inactive" or "workingArea". Omit for the ADT default.',
              enum: [...VERSIONS]
            }
          }
        }
      },
      {
        name: 'setDataElementProperties',
        description: 'Change the definition of an existing DDIC data element. The backend PUT replaces the whole definition, so anything not passed is kept as the system has it. The type is either a domain or a built-in ABAP type, not both. The lock is taken and released here unless you pass a handle or this server already holds one; outside $TMP a transport request is needed. Writes the inactive version - pass activate to finish the job, or run activateSafe afterwards.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Data element name.' },
            dataElementUrl: { type: 'string', description: 'Object URL instead of the name.' },
            description: { type: 'string', description: 'Short description.' },
            domain: {
              type: 'string',
              description: 'Domain the element takes its type from, e.g. ZAPP_STATUS. Alternative to dataType.'
            },
            dataType: {
              type: 'string',
              description: 'Built-in ABAP type for an element without a domain, e.g. CHAR, NUMC, DEC. Alternative to domain.'
            },
            length: { type: 'number', description: 'Length, for a built-in type.' },
            decimals: { type: 'number', description: 'Decimal places, for a built-in type.' },
            label: {
              type: 'string',
              description: `Fills all four field labels at once. Each is cut to the length SAP allows (${LABEL_LIMITS.short}/${LABEL_LIMITS.medium}/${LABEL_LIMITS.long}/${LABEL_LIMITS.heading}) and the answer says which were cut.`
            },
            shortLabel: { type: 'string', description: `Short label, up to ${LABEL_LIMITS.short} characters.` },
            mediumLabel: { type: 'string', description: `Medium label, up to ${LABEL_LIMITS.medium} characters.` },
            longLabel: { type: 'string', description: `Long label, up to ${LABEL_LIMITS.long} characters.` },
            headingLabel: { type: 'string', description: `Heading, up to ${LABEL_LIMITS.heading} characters.` },
            searchHelp: { type: 'string', description: 'Search help name.' },
            searchHelpParameter: { type: 'string', description: 'Search help parameter.' },
            setGetParameter: { type: 'string', description: 'SET/GET parameter id.' },
            defaultComponentName: { type: 'string', description: 'Default component name.' },
            deactivateInputHistory: { type: 'boolean', description: 'Switch off the input history.' },
            changeDocument: { type: 'boolean', description: 'Log changes in change documents.' },
            leftToRightDirection: { type: 'boolean', description: 'Left-to-right direction.' },
            deactivateBIDIFiltering: { type: 'boolean', description: 'Switch off BIDI filtering.' },
            properties: {
              type: 'object',
              description: 'Escape hatch: the complete DataElementProperties document, sent as it is with no merge.'
            },
            metaData: {
              type: 'object',
              description: 'Escape hatch: the complete DataElementMetaData document, sent as it is with no merge.'
            },
            lockHandle: {
              type: 'string',
              description: 'Lock handle. Omit it: the one this server holds for the object is used, and with none held the lock is taken and released here.'
            },
            activate: {
              type: 'boolean',
              description: 'Activate after the write (default false). Only possible when this tool took the lock itself - activation is refused while a session holds one.'
            },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task.'
            }
          }
        }
      },
      {
        name: 'createDomain',
        description: 'Create a DDIC domain and give it its definition, in one call: validate the name, create the object, lock it, write the type and output format (and value table or fixed values), unlock, activate. createObject alone leaves a domain with no definition, which cannot be activated. Nothing is rolled back if a step fails - the answer reports each step, and a domain that was created but not written is still there to correct or delete. On a release that serves no /sap/bc/adt/ddic/domains (404) the same arguments are written the way SE11 writes them - RS_CORR_INSERT, DDIF_DOMA_PUT, DDIF_DOMA_ACTIVATE in a throwaway class - and the answer says so in "via"; the name, package and request are checked first, and DD01L, TADIR and the request entry are read back as the proof. A task number is lifted to its request there.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Domain name, e.g. ZAPP_STATUS.' },
            description: { type: 'string', description: 'Short description.' },
            packageName: { type: 'string', description: 'Development package. $TMP needs no transport.' },
            datatype: { type: 'string', description: 'DDIC data type, e.g. CHAR, NUMC, DEC, DATS.' },
            length: { type: 'number', description: 'Field length.' },
            decimals: { type: 'number', description: 'Decimal places (default 0).' },
            outputLength: { type: 'number', description: 'Output length; defaults to the field length.' },
            conversionExit: { type: 'string', description: 'Conversion exit, e.g. ALPHA.' },
            signExists: { type: 'boolean', description: 'Value can be negative.' },
            lowercase: { type: 'boolean', description: 'Lower case allowed.' },
            ampmFormat: { type: 'boolean', description: 'AM/PM time format.' },
            style: { type: 'string', description: 'Output style.' },
            valueTable: { type: 'string', description: 'Value table for the check.' },
            fixValues: {
              type: 'array',
              description: 'Fixed values: [{low, high, text}].',
              items: {
                type: 'object',
                properties: {
                  low: { type: 'string' },
                  high: { type: 'string' },
                  text: { type: 'string' }
                },
                required: ['low']
              }
            },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task. Not needed in $TMP.'
            },
            responsible: { type: 'string', description: 'Responsible user; defaults to the logon user.' },
            language: {
              type: 'string',
              description: 'Language the texts are stored in, and the master language of the object. Defaults to the logon language - not EN, which is what the underlying library would use and which makes the texts invisible to a developer logged on in another language.'
            },
            activate: { type: 'boolean', description: 'Activate at the end (default true).' },
            dryRun: { type: 'boolean', description: 'Validate the name and show the document that would be written, creating nothing.' }
          },
          required: ['name', 'description', 'packageName', 'datatype', 'length']
        }
      },
      {
        name: 'createDataElement',
        description: 'Create a DDIC data element and give it its definition, in one call: validate, create, lock, write the type and the four field labels, unlock, activate. The type is either a domain or a built-in ABAP type, not both. createObject alone leaves an element with no type, which cannot be activated. Nothing is rolled back if a step fails - the answer reports each step.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Data element name, e.g. ZAPP_STATUS.' },
            description: { type: 'string', description: 'Short description.' },
            packageName: { type: 'string', description: 'Development package. $TMP needs no transport.' },
            domain: { type: 'string', description: 'Domain the element takes its type from. Alternative to dataType.' },
            dataType: { type: 'string', description: 'Built-in ABAP type, e.g. CHAR, NUMC, DEC. Alternative to domain.' },
            length: { type: 'number', description: 'Length, for a built-in type.' },
            decimals: { type: 'number', description: 'Decimal places, for a built-in type.' },
            label: {
              type: 'string',
              description: 'Fills all four field labels at once, each cut to the length SAP allows (10/20/40/55); the answer says which were cut.'
            },
            shortLabel: { type: 'string', description: 'Short label, up to 10 characters.' },
            mediumLabel: { type: 'string', description: 'Medium label, up to 20 characters.' },
            longLabel: { type: 'string', description: 'Long label, up to 40 characters.' },
            headingLabel: { type: 'string', description: 'Heading, up to 55 characters.' },
            searchHelp: { type: 'string', description: 'Search help name.' },
            searchHelpParameter: { type: 'string', description: 'Search help parameter.' },
            setGetParameter: { type: 'string', description: 'SET/GET parameter id.' },
            changeDocument: { type: 'boolean', description: 'Log changes in change documents.' },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task. Not needed in $TMP.'
            },
            responsible: { type: 'string', description: 'Responsible user; defaults to the logon user.' },
            language: {
              type: 'string',
              description: 'Language the labels are stored in, and the master language of the object. Defaults to the logon language - not EN, which is what the underlying library would use and which makes the labels invisible to a developer logged on in another language.'
            },
            activate: { type: 'boolean', description: 'Activate at the end (default true).' },
            dryRun: { type: 'boolean', description: 'Validate the name and show what would be written, creating nothing.' }
          },
          required: ['name', 'description', 'packageName']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'createDomain':
        return this.handleCreateDomain(args);
      case 'createDataElement':
        return this.handleCreateDataElement(args);
      case 'getDomainProperties':
        return this.handleGetDomainProperties(args);
      case 'setDomainProperties':
        return this.handleSetDomainProperties(args);
      case 'getDataElementProperties':
        return this.handleGetDataElementProperties(args);
      case 'setDataElementProperties':
        return this.handleSetDataElementProperties(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown DDIC property tool: ${toolName}`);
    }
  }

  /** The object URL, from whichever of name or URL the caller passed. */
  protected urlOf(args: any, urlKey: string, build: (name: string) => string, what: string): string {
    const given = args?.[urlKey];
    if (typeof given === 'string' && given.trim()) return given.trim();
    const name = args?.name;
    if (typeof name === 'string' && name.trim()) return build(name);
    throw new McpError(
      ErrorCode.InvalidParams,
      `Which ${what}? Pass name, or ${urlKey}.`
    );
  }

  /**
   * The lock to write with.
   *
   * A handle the caller passed, or one this process already holds, is used as
   * it stands and left alone - it belongs to whoever took it. With neither,
   * the lock is taken here and released again after the write: demanding a
   * separate lock call made a one-field change a three-call sequence, and the
   * message about the missing handle pointed at createDomain, which is no help
   * at all when the object already exists.
   */
  protected async lockFor(
    objectUrl: string,
    args: any
  ): Promise<{ lockHandle: string; from: string; taken: boolean }> {
    if (typeof args?.lockHandle === 'string' && args.lockHandle.trim()) {
      return { lockHandle: args.lockHandle.trim(), from: 'argument', taken: false };
    }
    const held = lockRegistry.forUrl(objectUrl);
    if (held) return { lockHandle: held.lockHandle, from: 'lockRegistry', taken: false };

    const lock = await takeLock(
      this.adtclient,
      objectUrl,
      undefined,
      (start, ok) => this.trackRequest(start, ok)
    );
    return { lockHandle: lock.lockHandle, from: 'takenHere', taken: lock.taken };
  }

  /**
   * Finish a properties write: give back a lock this tool took, and activate
   * when asked. Activation only makes sense once the lock is off - the backend
   * refuses it while the session still holds one.
   */
  protected async finishWrite(spec: {
    objectUrl: string;
    lockHandle: string;
    taken: boolean;
    activate: boolean;
    name: string;
  }): Promise<Record<string, unknown>> {
    const steps: Record<string, unknown>[] = [];
    let released = !spec.taken;
    if (spec.taken) {
      const unlock = await releaseLock(
        this.adtclient,
        spec.objectUrl,
        spec.lockHandle,
        (start, ok) => this.trackRequest(start, ok)
      );
      released = unlock.released;
      steps.push({ step: 'unlock', ...unlock });
    }

    if (!spec.activate) {
      return {
        activated: false,
        ...(steps.length ? { steps } : {}),
        hint: spec.taken
          ? 'Written to the inactive version and the lock is back off. Activate with activateSafe, then read it back with version="active".'
          : 'Written to the inactive version. The lock is the one you hold, so release it before activating with activateSafe.'
      };
    }
    if (!released) {
      return {
        activated: false,
        steps,
        hint: 'Written, but the lock would not come off and activation fails while it is held. Release it (unlockAll) and run activateSafe.'
      };
    }

    const startTime = performance.now();
    try {
      const outcome = await activateAndVerify(this.adtclient, {
        objectUrl: spec.objectUrl,
        objectName: spec.name
      });
      this.trackRequest(startTime, true);
      steps.push({ step: 'activate', ...outcome });
      return {
        activated: outcome.success,
        steps,
        hint: outcome.success
          ? 'Active. Read it back with version="active" for the proof.'
          : 'Written but not active, so nothing uses the change yet. Correct it and run activateSafe.'
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      steps.push({ step: 'activate', error: describeAdtError(error).error });
      return {
        activated: false,
        steps,
        hint: 'Written but not active. Nothing was rolled back; run activateSafe.'
      };
    }
  }

  async handleGetDomainProperties(args: any): Promise<any> {
    const startTime = performance.now();
    const url = this.urlOf(args, 'domainUrl', domainUrl, 'domain');
    try {
      const result = await this.readClient.getDomainProperties(url, args?.version);
      this.trackRequest(startTime, true);
      return this.answer({
        status: 'success',
        domainUrl: url,
        version: args?.version || 'default',
        ...result
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      // No domain endpoint on this release: the tables hold the same.
      if (domainEndpointHint(error)) return this.domainPropertiesFromTables(url, args);
      throw wrapAdtError(error, `Failed to read the properties of domain ${ddicNameOf(url)}`);
    }
  }

  async handleGetDataElementProperties(args: any): Promise<any> {
    const startTime = performance.now();
    const url = this.urlOf(args, 'dataElementUrl', dataElementUrl, 'data element');
    try {
      const result = await this.readClient.getDataElementProperties(url, args?.version);
      this.trackRequest(startTime, true);
      return this.answer({
        status: 'success',
        dataElementUrl: url,
        version: args?.version || 'default',
        typeKind: result.properties.typeName ? 'domain' : 'predefinedAbapType',
        ...result
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, `Failed to read the properties of data element ${ddicNameOf(url)}`);
    }
  }

  async handleSetDomainProperties(args: any): Promise<any> {
    const url = this.urlOf(args, 'domainUrl', domainUrl, 'domain');
    let lock: { lockHandle: string; from: string; taken: boolean };
    try {
      lock = await this.lockFor(url, args);
    } catch (error) {
      // No domain endpoint on this release: the change goes the way SE11
      // makes it - see lib/domainChange.
      if (domainEndpointHint(error)) return this.setDomainThroughDdif(url, args);
      throw error;
    }
    const { lockHandle, from, taken } = lock;
    // Read what the system holds while the lock is ours: the patch is applied
    // to that, and reading it before the lock would patch a different moment.
    const state = await this.domainDocument(url, args);

    const startTime = performance.now();
    try {
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.setDomainProperties(
        url,
        state.properties,
        state.metaData,
        lockHandle,
        args?.transport
      );
      this.trackRequest(startTime, true);
      const finish = await this.finishWrite({
        objectUrl: url,
        lockHandle,
        taken,
        activate: args?.activate === true,
        name: ddicNameOf(url)
      });
      return this.answer({
        status: finish.activated === false && args?.activate === true ? 'error' : 'success',
        written: true,
        domainUrl: url,
        lockHandleFrom: from,
        ...state,
        ...finish
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (taken) {
        await releaseLock(this.adtclient, url, lockHandle, (start, ok) => this.trackRequest(start, ok));
      }
      const missing = domainEndpointHint(error);
      throw wrapAdtError(
        error,
        missing
          ? `Failed to write the properties of domain ${ddicNameOf(url)}. ${missing}`
          : `Failed to write the properties of domain ${ddicNameOf(url)}`
      );
    }
  }

  async handleSetDataElementProperties(args: any): Promise<any> {
    const url = this.urlOf(args, 'dataElementUrl', dataElementUrl, 'data element');
    const { lockHandle, from, taken } = await this.lockFor(url, args);
    const { state, truncated } = await this.dataElementDocument(url, args);

    const startTime = performance.now();
    try {
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.setDataElementProperties(
        url,
        state.properties,
        state.metaData,
        lockHandle,
        args?.transport
      );
      this.trackRequest(startTime, true);
      const finish = await this.finishWrite({
        objectUrl: url,
        lockHandle,
        taken,
        activate: args?.activate === true,
        name: ddicNameOf(url)
      });
      return this.answer({
        status: finish.activated === false && args?.activate === true ? 'error' : 'success',
        written: true,
        dataElementUrl: url,
        lockHandleFrom: from,
        typeKind: state.properties.typeName ? 'domain' : 'predefinedAbapType',
        ...state,
        ...(truncated.length ? { truncatedLabels: truncated } : {}),
        ...finish
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (taken) {
        await releaseLock(this.adtclient, url, lockHandle, (start, ok) => this.trackRequest(start, ok));
      }
      throw wrapAdtError(error, `Failed to write the properties of data element ${ddicNameOf(url)}`);
    }
  }

  /**
   * The domain document to send: the caller's raw one, or the current
   * definition with the patch merged onto it.
   */
  protected async domainDocument(url: string, args: any): Promise<DomainState> {
    if (args?.properties && args?.metaData) {
      return {
        properties: this.parseObjectArg(args.properties, 'properties'),
        metaData: this.parseObjectArg(args.metaData, 'metaData')
      };
    }
    const startTime = performance.now();
    try {
      // The stateful client on purpose: the definition being merged onto
      // has to be the one the locking session sees.
      const current = await this.adtclient.getDomainProperties(url);
      this.trackRequest(startTime, true);
      return mergeDomain(current, this.domainPatch(args));
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(
        error,
        `Failed to read domain ${ddicNameOf(url)} before writing it. The PUT carries the whole definition, so the current one is needed to merge onto`
      );
    }
  }

  /** Same for a data element, plus the labels that had to be cut to fit. */
  protected async dataElementDocument(
    url: string,
    args: any
  ): Promise<{ state: DataElementState; truncated: any[] }> {
    if (args?.properties && args?.metaData) {
      return {
        state: {
          properties: this.parseObjectArg(args.properties, 'properties'),
          metaData: this.parseObjectArg(args.metaData, 'metaData')
        },
        truncated: []
      };
    }
    const patch = this.dataElementPatch(args);
    const conflict = typeChoiceError(patch);
    if (conflict) throw new McpError(ErrorCode.InvalidParams, conflict);

    const startTime = performance.now();
    try {
      // The stateful client on purpose, as for a domain.
      const current = await this.adtclient.getDataElementProperties(url);
      this.trackRequest(startTime, true);
      return mergeDataElement(current, patch);
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(
        error,
        `Failed to read data element ${ddicNameOf(url)} before writing it. The PUT carries the whole definition, so the current one is needed to merge onto`
      );
    }
  }

  protected domainPatch(args: any): DomainPatch {
    return {
      description: args?.description,
      datatype: args?.datatype,
      length: args?.length,
      decimals: args?.decimals,
      outputLength: args?.outputLength,
      style: args?.style,
      conversionExit: args?.conversionExit,
      signExists: args?.signExists,
      lowercase: args?.lowercase,
      ampmFormat: args?.ampmFormat,
      valueTable: args?.valueTable,
      fixValues: args?.fixValues === undefined
        ? undefined
        : this.parseObjectArg(args.fixValues, 'fixValues')
    };
  }

  /**
   * Create a domain, then define it.
   *
   * Two calls that only make sense together: an object created and never
   * written is a DDIC entry with no type, which cannot be activated and shows
   * up as an error the next time anything touches the package. Whether a
   * caller can be expected to remember the second half is exactly the kind of
   * thing a composite tool should take off their hands.
   */
  async handleCreateDomain(args: any): Promise<any> {
    return this.createDdicObject({
      args,
      objtype: 'DOMA/DD',
      what: 'domain',
      url: domainUrl(String(args?.name || '')),
      document: async url => {
        const state = await this.domainDocument(url, args);
        return { payload: state, extra: {} };
      },
      write: async (url, payload, lockHandle) => {
        await this.adtclient.setDomainProperties(
          url,
          (payload as DomainState).properties,
          (payload as DomainState).metaData,
          lockHandle,
          args?.transport
        );
      }
    });
  }

  /** Create a data element, then define it. Same reasoning as createDomain. */
  async handleCreateDataElement(args: any): Promise<any> {
    const conflict = typeChoiceError(this.dataElementPatch(args));
    if (conflict) throw new McpError(ErrorCode.InvalidParams, conflict);
    if (args?.domain === undefined && args?.dataType === undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'A data element needs a type: pass domain, or dataType with length (and decimals). Without one it cannot be activated.'
      );
    }

    return this.createDdicObject({
      args,
      objtype: 'DTEL/DE',
      what: 'data element',
      url: dataElementUrl(String(args?.name || '')),
      document: async url => {
        const { state, truncated } = await this.dataElementDocument(url, args);
        return {
          payload: state,
          extra: {
            typeKind: state.properties.typeName ? 'domain' : 'predefinedAbapType',
            ...(truncated.length ? { truncatedLabels: truncated } : {})
          }
        };
      },
      write: async (url, payload, lockHandle) => {
        await this.adtclient.setDataElementProperties(
          url,
          (payload as DataElementState).properties,
          (payload as DataElementState).metaData,
          lockHandle,
          args?.transport
        );
      }
    });
  }

  /**
   * validate, create, lock, read, write, unlock, activate.
   *
   * The order is not negotiable: the definition can only be written once the
   * object exists and is locked, the metadata in the document has to be the
   * system's own (master language and system, responsible, package - guessing
   * them produces an object that activates but reads wrong), and activation
   * needs the lock gone. Each step is reported, and nothing is rolled back: a
   * half-created object is visible in the answer and can be corrected or
   * deleted, which beats silently undoing work the caller may want to keep.
   */
  private async createDdicObject(spec: {
    args: any;
    objtype: string;
    what: string;
    url: string;
    document: (url: string) => Promise<{ payload: unknown; extra: Record<string, unknown> }>;
    write: (url: string, payload: unknown, lockHandle: string) => Promise<void>;
  }): Promise<any> {
    const { args, objtype, what, url } = spec;
    const name = String(args?.name || '').trim().toUpperCase();
    const packageName = String(args?.packageName || '').trim().toUpperCase();
    if (!name || !packageName || !args?.description) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass name, description and packageName.');
    }
    if (!args?.transport && packageName !== '$TMP') {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Creating a ${what} in ${packageName} needs a transport request (the request itself, not a developer task). Only $TMP goes without one.`
      );
    }

    const parentPath = `/sap/bc/adt/packages/${encodeURIComponent(packageName.toLowerCase())}`;
    // The language matters more than it looks. abap-adt-api defaults the
    // creation document to EN and makes that the master language, and SAP then
    // stores every text of the object under that language - so a developer
    // logged on in another one reads the object back with empty description
    // and empty labels, which is exactly how this looked when it was first
    // tried live. The logon language is the sane default.
    const language = String(args?.language || this.adtclient.language || 'EN').toUpperCase();
    const steps: Record<string, unknown>[] = [];

    // Validation is cheap and its message is far better than the backend's
    // answer to a creation that cannot work: a name already taken, a namespace
    // that is not allowed, a package that does not exist.
    const validateStart = performance.now();
    let validation: any;
    try {
      // Part of the write sequence, so it stays on the stateful client -
      // the same session that takes the lock a moment later.
      validation = await this.adtclient.validateNewObject({
        objtype: objtype as any,
        objname: name,
        packagename: packageName,
        description: String(args.description)
      });
      this.trackRequest(validateStart, true);
    } catch (error: any) {
      this.trackRequest(validateStart, false);
      const missing = what === 'domain' ? domainEndpointHint(error) : undefined;
      // No domain endpoint on this release: the domain is written the way SE11
      // writes it, through DDIF_DOMA_PUT - see lib/domainDdif.
      if (missing) return this.createDomainThroughDdif(args, name, packageName);
      throw wrapAdtError(
        error,
        missing
          ? `Failed to validate the new ${what} ${name}. ${missing} Nothing was created`
          : `Failed to validate the new ${what} ${name}`
      );
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
        objectUrl: url,
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
        objectUrl: url,
        name,
        packageName,
        language,
        steps,
        note: `The name is free and the package accepts it. The definition itself can only be built from the created object's metadata, so a dry run stops here.`
      });
    }

    const createStart = performance.now();
    try {
      await this.adtclient.createObject({
        objtype: objtype as any,
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
      throw wrapAdtError(error, `Failed to create the ${what} ${name}`);
    }
    steps.push({ step: 'create', objectUrl: url, packageName });

    let lockHandle: string;
    try {
      const lock = await takeLock(
        this.adtclient,
        url,
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
        objectUrl: url,
        name,
        steps,
        hint: `The ${what} exists but has no definition yet, and it could not be locked. Lock it and finish with set${what === 'domain' ? 'Domain' : 'DataElement'}Properties, or delete it with deleteObject.`
      });
    }
    steps.push({ step: 'lock', lockHandle });

    let extra: Record<string, unknown> = {};
    const writeStart = performance.now();
    try {
      const { payload, extra: documentExtra } = await spec.document(url);
      extra = documentExtra;
      // The metadata just read back carries the language ADT answered in,
      // which is not necessarily the one the object was created with. Writing
      // the texts under anything but the object's master language files them
      // where nobody will look for them.
      const meta = (payload as { metaData: Record<string, unknown> }).metaData;
      meta.language = language;
      meta.masterLanguage = language;
      await spec.write(url, payload, lockHandle);
      this.trackRequest(writeStart, true);
      steps.push({ step: 'write', ...(payload as Record<string, unknown>) });
    } catch (error: any) {
      this.trackRequest(writeStart, false);
      steps.push({ step: 'write', error: describeAdtError(error).error });
      const released = await this.releaseLock(url, lockHandle);
      steps.push({ step: 'unlock', ...released });
      return this.answer({
        status: 'error',
        created: true,
        written: false,
        objectUrl: url,
        name,
        steps,
        ...extra,
        hint: `The ${what} exists but its definition was not written, so it cannot be activated. Correct the arguments and use the set-properties tool, or delete it with deleteObject.`
      });
    }

    const unlock = await this.releaseLock(url, lockHandle);
    steps.push({ step: 'unlock', ...unlock });

    if (args?.activate === false) {
      return this.answer({
        status: 'success',
        created: true,
        written: true,
        activated: false,
        objectUrl: url,
        name,
        steps,
        ...extra,
        hint: 'Written to the inactive version and not activated, so nothing can use it yet.'
      });
    }
    if (!unlock.released) {
      return this.answer({
        status: 'error',
        created: true,
        written: true,
        activated: false,
        objectUrl: url,
        name,
        steps,
        ...extra,
        hint: 'The lock could not be released, and activation fails while it is held. Release it (unlockAll) and run activateSafe.'
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
        objectUrl: url,
        name,
        steps,
        ...extra,
        hint: outcome.success
          ? `Active. Read it back with get${what === 'domain' ? 'Domain' : 'DataElement'}Properties and version="active" for the proof.`
          : 'Written but not active, so nothing can use it yet. Nothing was rolled back; correct it and run activateSafe.'
      });
    } catch (error: any) {
      this.trackRequest(activateStart, false);
      steps.push({ step: 'activate', error: describeAdtError(error).error });
      return this.answer({
        status: 'error',
        created: true,
        written: true,
        activated: false,
        objectUrl: url,
        name,
        steps,
        ...extra,
        hint: 'Written but not active. Nothing was rolled back; correct it and run activateSafe.'
      });
    }
  }

  /**
   * createDomain on a release with no domain endpoint.
   *
   * The same arguments, written through RS_CORR_INSERT, DDIF_DOMA_PUT and
   * DDIF_DOMA_ACTIVATE in a throwaway class. Checked before anything is
   * generated: the name is free in DD01L and TADIR, the package exists, the
   * transport number is a modifiable workbench request (a task is lifted to
   * its request). Checked afterwards from the tables, not from the snippet:
   * the active row in DD01L, the directory entry, the request entry.
   */
  private async createDomainThroughDdif(
    args: any,
    name: string,
    givenPackage: string
  ): Promise<any> {
    const via = 'ddif';
    let packageName: string;
    try {
      packageName = checkedPackage(givenPackage);
    } catch (error) {
      return this.refuse(error);
    }

    const [existing] = await this.rows(domainHeaderSql(name), 5);
    const [directory] = await this.rows(directorySql('DOMA', name), 1);
    if (existing || directory) {
      return this.answer({
        status: 'error',
        via,
        created: false,
        name,
        ...(directory ? { packageOfExisting: String(directory.DEVCLASS ?? '').trim() } : {}),
        hint: `${name} already exists${directory ? ` in package ${String(directory.DEVCLASS ?? '').trim()}` : ''}. Nothing was written.`
      });
    }
    if (!packageName.startsWith('$')) {
      const [known] = await this.rows(packageExistsSql(packageName), 1);
      if (!known) {
        throw new McpError(ErrorCode.InvalidParams, `There is no package ${packageName} on this system.`);
      }
    }
    const { request, fromTask } = await this.requestFor(packageName, args?.transport);

    let snippet;
    try {
      snippet = domainDdifSnippet({
        ...this.domainPatch(args),
        description: args?.description,
        name,
        packageName,
        request,
        language: args?.language,
        activate: args?.activate !== false
      });
    } catch (error) {
      return this.refuse(error);
    }

    const common = {
      via,
      name,
      packageName,
      ...(request ? { request } : {}),
      ...(fromTask ? { requestFromTask: fromTask } : {}),
      reason: 'This release serves no /sap/bc/adt/ddic/domains (404), so the domain went through DDIF_DOMA_PUT.'
    };
    if (args?.dryRun === true) {
      return this.answer({
        status: 'success',
        dryRun: true,
        created: false,
        ...common,
        code: snippet.code,
        note: 'The name is free and nothing was written. Without dryRun this ABAP runs in a throwaway class.'
      });
    }

    const run = await this.runDdif(snippet.code, snippet.exceptions);
    if (!run.ran) {
      return this.answer({
        status: 'error',
        created: false,
        ...common,
        ...run.snippet,
        hint: 'The throwaway class did not get as far as running, so nothing was written. The steps above say where it stopped.'
      });
    }

    const failed = failedStep(run.print);
    const registered = run.print.steps.some(step => step.step === 'transport' && step.ok);
    const written = run.print.steps.some(step => step.step === 'put' && step.ok);
    const activation = run.print.steps.find(step => step.step === 'activate');

    const versions = (await this.rows(domainHeaderSql(name), 5))
      .map(row => String(row.AS4LOCAL ?? '').trim());
    const [entry] = await this.rows(directorySql('DOMA', name), 1);
    const recorded = request ? await this.recordedIn('DOMA', name, request) : undefined;
    const active = versions.includes('A');

    const proof = {
      dd01lVersions: versions,
      directoryPackage: entry ? String(entry.DEVCLASS ?? '').trim() : null,
      ...(run.print.info.task ? { task: run.print.info.task } : {}),
      ...(recorded ? { requestEntry: recorded } : {})
    };

    let hint: string;
    if (failed?.step === 'transport') {
      hint = `RS_CORR_INSERT refused the domain (${failed.exception || `subrc ${failed.subrc}`}${failed.message ? `: ${failed.message}` : ''}), so nothing was written.`;
    } else if (failed?.step === 'put') {
      hint = `The domain is registered (TADIR, request) but DDIF_DOMA_PUT refused the definition (${failed.exception || `subrc ${failed.subrc}`}${failed.message ? `: ${failed.message}` : ''}). Correct the arguments; the directory entry stays until it is deleted in SE11.`;
    } else if (failed?.step === 'activate') {
      hint = `${activationVerdict(failed.rc)} Check it in SE11 (Utilities > Activation log).`;
    } else if (args?.activate === false) {
      hint = 'Written to the inactive version and not activated, as asked.';
    } else if (!active) {
      hint = 'The snippet reported success but DD01L holds no active version - check the domain in SE11.';
    } else if (recorded && !recorded.recorded) {
      hint = `Active, but no entry for R3TR DOMA ${name} was found in ${request} or its tasks - check the request before releasing it.`;
    } else {
      hint = `Active${request ? ` and recorded in ${run.print.info.task ? `task ${run.print.info.task} of ` : ''}${request}` : ' as a local object'}. Written through DDIF_DOMA_PUT because this release serves no domain endpoint; getDomainProperties reads it back from the tables.`;
    }

    return this.answer({
      status: failed || (args?.activate !== false && !active) ? 'error' : 'success',
      created: registered,
      written,
      activated: active && args?.activate !== false && activation?.ok === true,
      ...common,
      steps: run.print.steps,
      ...proof,
      hint
    });
  }

  /**
   * The language the texts are read and written in: the one given (a SAP key
   * as it is, an ISO code through T002), or the master language of the domain.
   */
  private async textLanguage(given: unknown, master: string): Promise<string> {
    const value = String(given ?? '').trim().toUpperCase();
    if (!value) return master || 'E';
    if (value.length === 1) return value;
    let sql: string;
    try {
      sql = languageOfIsoSql(value);
    } catch (error) {
      return this.refuse(error);
    }
    const [row] = await this.rows(sql, 1);
    const key = String(row?.SPRAS ?? '').trim();
    if (!key) throw new McpError(ErrorCode.InvalidParams, `There is no language with the ISO code ${value} on this system.`);
    return key;
  }

  /** One version of a domain, from the tables; tables is missing when DD01L has no such version. */
  private async domainTables(name: string, version: DomainVersion): Promise<{ versions: string[]; tables?: DomainTables }> {
    const headers = await this.rows(domainVersionsSql(name), 5);
    const versions = headers.map(row => String(row.AS4LOCAL ?? '').trim());
    const header = headers.find(row => String(row.AS4LOCAL ?? '').trim() === version);
    if (!header) return { versions };
    const [directory] = await this.rows(domainDirectorySql(name), 1);
    return {
      versions,
      tables: {
        header,
        directory,
        texts: await this.rows(domainTextsSql(name, version), 200),
        values: await this.rows(fixValuesSql(name, version), 10000),
        valueTexts: await this.rows(fixValueTextsSql(name, version), 50000)
      }
    };
  }

  /** getDomainProperties on a release with no domain endpoint. */
  private async domainPropertiesFromTables(url: string, args: any): Promise<any> {
    let name: string;
    try {
      name = ddicObjectName(ddicNameOf(url), 'domain');
    } catch (error) {
      return this.refuse(error);
    }
    const version: DomainVersion = args?.version === 'inactive' || args?.version === 'workingArea' ? 'N' : 'A';
    const { versions, tables } = await this.domainTables(name, version);
    if (!tables) {
      return this.answer({
        status: 'error',
        via: 'tables',
        domainUrl: url,
        name,
        dd01lVersions: versions,
        hint: versions.length
          ? `${name} has no ${version === 'A' ? 'active' : 'inactive'} version; DD01L holds ${versions.join('/')}.`
          : `There is no domain ${name} on this system.`
      });
    }
    const language = await this.textLanguage(args?.language, String(tables.directory?.MASTERLANG ?? '').trim());
    const { state } = domainStateFromTables(tables, language);
    state.metaData.name = name;
    return this.answer({
      status: 'success',
      domainUrl: url,
      version: args?.version || 'default',
      via: 'tables',
      reason: `${DDIF_REASON}, so the definition was read from DD01L/DD01T/DD07L/DD07T and TADIR.`,
      ...state,
      textLanguages: textLanguages(tables),
      dd01lVersions: versions,
      ...(version === 'A' && versions.includes('N')
        ? { note: 'There is also an inactive version - somebody is in the middle of changing the domain. Pass version "inactive" to read it.' }
        : {})
    });
  }

  /**
   * setDomainProperties on a release with no domain endpoint: preview, then
   * the write with the preview's token. See lib/domainChange.
   */
  private async setDomainThroughDdif(url: string, args: any): Promise<any> {
    const via = 'ddif';
    let name: string;
    try {
      name = ddicObjectName(ddicNameOf(url), 'domain');
    } catch (error) {
      return this.refuse(error);
    }
    if (args?.properties || args?.metaData) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'properties and metaData are ADT documents, and this release serves no domain endpoint. Pass the fields to change instead (description, datatype, length, fixValues, ...).'
      );
    }
    const refusal = (hint: string, extra: Record<string, unknown> = {}) =>
      this.answer({ status: 'error', via, written: false, name, ...extra, hint });

    const { versions, tables } = await this.domainTables(name, 'A');
    if (!tables) {
      return refusal(versions.length
        ? `${name} has no active version (DD01L holds ${versions.join('/')}). Finish it in SE11 first.`
        : `There is no domain ${name} on this system.`);
    }
    if (versions.some(version => version !== 'A')) {
      return refusal(`${name} has an inactive version: somebody is in the middle of changing it. Activate or discard that in SE11 first - a write here would overwrite it.`);
    }
    const packageName = String(tables.directory?.DEVCLASS ?? '').trim();
    if (!packageName) return refusal(`${name} has no directory entry (TADIR), so there is no package to record the change for. Check it in SE11.`);
    const master = String(tables.directory?.MASTERLANG ?? '').trim();
    const language = await this.textLanguage(args?.language, master);

    const fixValues = fixValueRows(tables.values, tables.valueTexts);
    const description = tables.texts.find(row => String(row.DDLANGUAGE ?? '').trim() === language);
    const current = { header: tables.header, description: String(description?.DDTEXT ?? '').trim(), fixValues };
    let plan;
    try {
      plan = planDomainChange(current, this.domainPatch(args), language);
    } catch (error) {
      return this.refuse(error);
    }
    const common = {
      via,
      reason: `${DDIF_REASON}, so the change goes through DDIF_DOMA_PUT.`,
      name,
      packageName,
      textLanguage: language,
      ...(master && master !== language ? { masterLanguage: master } : {})
    };
    if (!plan.changed) {
      return this.answer({ status: 'success', written: false, ...common, hint: 'Nothing to change: the domain already holds this.' });
    }

    const view = (values: { position: number; low: string; high: string; text: string; origin?: string; retexted?: boolean }[]) =>
      values.map(value => ({
        position: value.position,
        low: value.low,
        ...(value.high ? { high: value.high } : {}),
        text: value.text,
        ...(value.origin === 'added' ? { added: true } : {}),
        ...(value.retexted ? { retexted: true } : {})
      }));
    const currentValues = fixValues.map(value => ({ ...value, text: value.texts[language] ?? '' }));
    const otherLanguages = textLanguages(tables).filter(key => key !== language);
    const change = {
      header: plan.header,
      ...(plan.fixValues ? { fixValues: { current: view(currentValues), planned: view(plan.fixValues) } } : {}),
      added: plan.added,
      removed: plan.removed,
      retexted: plan.retexted
    };
    const token = domainPreviewToken(
      name,
      language,
      `${stampOf(tables.header.AS4DATE)}|${stampOf(tables.header.AS4TIME)}`,
      current,
      plan
    );
    const activate = args?.activate !== false;

    if (!args?.previewToken) {
      const notes = [
        plan.added.length && otherLanguages.length
          ? `The new values get a text in ${language} only; the domain also has texts in ${otherLanguages.join(', ')}, which they will lack until translated.`
          : '',
        plan.removed.length ? `Removing ${plan.removed.join(', ')}: data that holds these values stays as it is and fails the fixed value check from then on.` : ''
      ].filter(Boolean);
      return this.answer({
        status: 'success',
        preview: true,
        written: false,
        ...common,
        ...change,
        activate,
        ...(otherLanguages.length ? { otherTextLanguages: otherLanguages } : {}),
        ...(notes.length ? { notes } : {}),
        previewToken: token,
        hint: `Nothing written. Call again with this previewToken${packageName.startsWith('$') ? '' : ' and the transport request'} to write exactly this change.`
      });
    }
    if (String(args.previewToken).trim() !== token) {
      return refusal('The previewToken does not match: the domain changed since the preview, or this is not the change that was previewed. Nothing was written - preview again.');
    }

    const { request, fromTask } = await this.requestFor(packageName, args?.transport, `The domain ${name} in ${packageName}`);
    let snippet;
    try {
      snippet = domainChangeSnippet({
        name,
        packageName,
        request,
        language,
        expected: fixValuesFingerprint(fixValues),
        plan,
        activate
      });
    } catch (error) {
      return this.refuse(error);
    }
    const run = await this.runDdif(snippet.code, snippet.exceptions);
    const where = {
      ...common,
      ...(request ? { request } : {}),
      ...(fromTask ? { requestFromTask: fromTask } : {}),
      ...change
    };
    if (!run.ran) {
      return this.answer({
        status: 'error',
        written: false,
        ...where,
        ...run.snippet,
        hint: 'The throwaway class did not get as far as running, so the domain was not touched. The steps above say where it stopped.'
      });
    }

    const step = (stepName: string) => run.print.steps.find(candidate => candidate.step === stepName);
    const failed = failedStep(run.print);
    const after = await this.domainTables(name, 'A');
    const valuesAfter = after.tables ? fixValueRows(after.tables.values, after.tables.valueTexts) : [];
    const descriptionAfter = after.tables?.texts.find(row => String(row.DDLANGUAGE ?? '').trim() === language);
    const disagreements = [
      ...this.domainDisagreements(plan, after.versions, valuesAfter, fixValues, language, activate),
      // The activation corrects what it does not accept and says rc 4 - a
      // DEC of length 2 with 5 decimals came out with 2 - so every field the
      // change touched is read back.
      ...(after.tables && activate
        ? Object.entries(plan.header)
          .map(([field, { to }]) => [field, to, headerValue(field, after.tables!.header, String(descriptionAfter?.DDTEXT ?? '').trim())])
          .filter(([, to, now]) => to !== now)
          .map(([field, to, now]) => `${field} is '${now}', not '${to}'`)
        : [])
    ];
    const recorded = request ? await this.recordedIn('DOMA', name, request) : undefined;
    const rolledBack = step('rollback_put') !== undefined;
    const rollbackOk = rolledBack && step('rollback_put')?.ok === true && step('rollback_activate')?.ok === true;
    const reasonOf = (failure: { exception?: string; subrc: number; message?: string }) =>
      `${failure.exception || `subrc ${failure.subrc}`}${failure.message ? `: ${failure.message}` : ''}`;

    let hint: string;
    if (failed?.step === 'transport') {
      hint = `RS_CORR_INSERT refused the domain (${reasonOf(failed)}) - it may be locked in somebody else's request. The domain was not touched.`;
    } else if (failed?.step === 'get') {
      hint = `DDIF_DOMA_GET could not read the domain (${reasonOf(failed)}). Nothing was written.`;
    } else if (failed?.step === 'compare') {
      hint = `The domain changed between the preview and the write (${failed.message}). Nothing was written - preview again.`;
    } else if (failed?.step === 'put') {
      hint = `DDIF_DOMA_PUT refused the new definition (${reasonOf(failed)}). The active domain is unchanged.`;
    } else if (rolledBack) {
      const reason = step('activate');
      hint = rollbackOk
        ? `The activation failed (rc ${reason?.rc}${reason?.message ? `: ${reason.message}` : ''}), so the definition read before was written back and activated: the domain is as it was. The activation log in SE11 says why.`
        : `The activation failed AND putting the old definition back did not finish cleanly. Check ${name} in SE11 now (DD01L shows ${after.versions.join('/') || 'nothing'}).`;
    } else if (disagreements.length) {
      hint = `Written, but the read-back disagrees: ${disagreements.join('; ')}. Check the domain in SE11.`;
    } else if (!activate) {
      hint = 'Written to the inactive version and not activated, as asked. Activate it in SE11 - until then this tool refuses the domain, because of that inactive version.';
    } else if (recorded && !recorded.recorded) {
      hint = `Changed and active, but no entry for R3TR DOMA ${name} was found in ${request} or its tasks - check the request before releasing it.`;
    } else {
      hint = `Changed and active${request ? `; recorded in ${recorded?.in?.join(', ') || request}` : ' (a local object, no request)'}.`;
    }

    const clean = !failed && !rolledBack && disagreements.length === 0;
    return this.answer({
      status: clean ? 'success' : 'error',
      written: clean,
      ...(rolledBack ? { rolledBack: rollbackOk } : {}),
      ...where,
      ...(run.print.info.task ? { task: run.print.info.task } : {}),
      steps: run.print.steps,
      dd01lVersions: after.versions,
      ...(after.tables ? { fixValuesAfter: view(valuesAfter.map(value => ({ ...value, text: value.texts[language] ?? '' }))) } : {}),
      ...(recorded ? { requestEntry: recorded } : {}),
      hint
    });
  }

  /**
   * Where the tables after the write differ from the plan: the versions, the
   * values in their order and their texts - including the texts in other
   * languages of the values that were kept, which the write must not lose.
   * Values are matched by low and high, not by position: DDIF_DOMA_PUT
   * numbers them 1..n again and takes their texts along.
   */
  private domainDisagreements(
    plan: ReturnType<typeof planDomainChange>,
    versions: string[],
    after: FixValueRow[],
    before: FixValueRow[],
    language: string,
    activate: boolean
  ): string[] {
    const found: string[] = [];
    const expectedVersions = activate ? 'A' : 'A,N';
    if ([...versions].sort().join() !== expectedVersions) found.push(`DD01L versions ${versions.join('/') || 'none'}`);
    if (!activate) return found;

    const expected = plan.fixValues ?? before.map(value => ({ ...value, text: value.texts[language] ?? '' }));
    const key = (value: { low: string; high: string }) => `${value.low}..${value.high}`;
    const shape = (values: { low: string; high: string }[]) => values.map(key).join(', ');
    if (shape(after) !== shape(expected)) found.push(`fixed values are ${shape(after) || 'none'}`);

    const byValue = new Map(after.map(value => [key(value), value]));
    for (const value of expected) {
      const now = byValue.get(key(value));
      if (now && (now.texts[language] ?? '') !== value.text) found.push(`text of ${value.low} is '${now.texts[language] ?? ''}'`);
    }
    const lost: string[] = [];
    for (const value of before) {
      const now = byValue.get(key(value));
      if (!now) continue;
      for (const other of Object.keys(value.texts)) {
        if (other !== language && value.texts[other] && !now.texts[other]) lost.push(`${value.low} (${other})`);
      }
    }
    if (lost.length) found.push(`texts lost in other languages: ${lost.join(', ')}`);
    return found;
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

  protected dataElementPatch(args: any): DataElementPatch {
    return {
      description: args?.description,
      domain: args?.domain,
      dataType: args?.dataType,
      length: args?.length,
      decimals: args?.decimals,
      label: args?.label,
      shortLabel: args?.shortLabel,
      mediumLabel: args?.mediumLabel,
      longLabel: args?.longLabel,
      headingLabel: args?.headingLabel,
      searchHelp: args?.searchHelp,
      searchHelpParameter: args?.searchHelpParameter,
      setGetParameter: args?.setGetParameter,
      defaultComponentName: args?.defaultComponentName,
      deactivateInputHistory: args?.deactivateInputHistory,
      changeDocument: args?.changeDocument,
      leftToRightDirection: args?.leftToRightDirection,
      deactivateBIDIFiltering: args?.deactivateBIDIFiltering
    };
  }
}

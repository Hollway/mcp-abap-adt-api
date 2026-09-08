import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import { session_types } from 'abap-adt-api';
import type { ObjectVersion } from 'abap-adt-api';
import { lockRegistry } from '../lib/lockRegistry';
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
export class DdicPropertyHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'getDomainProperties',
        description: 'Read the definition of a DDIC domain: data type, length, decimals, output format, value table and fixed values. Takes the domain name; the object URL is accepted as well.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Domain name, e.g. ZMM_STATUS.'
            },
            domainUrl: {
              type: 'string',
              description: 'Object URL instead of the name, e.g. /sap/bc/adt/ddic/domains/zmm_status.'
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
        name: 'setDomainProperties',
        description: 'Change the definition of an existing DDIC domain. The backend PUT replaces the whole definition, so anything not passed here is kept as the system currently has it - read, merge, write happens on this side. Needs a lock (taken with lock, or already recorded by this server) and, outside $TMP, a transport request. Writes the inactive version: activate with activateSafe afterwards.',
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
              description: 'Lock handle; omit to use the one this server recorded for the object.'
            },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task.'
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
              description: 'Data element name, e.g. ZMM_STATUS.'
            },
            dataElementUrl: {
              type: 'string',
              description: 'Object URL instead of the name, e.g. /sap/bc/adt/ddic/dataelements/zmm_status.'
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
        description: 'Change the definition of an existing DDIC data element. The backend PUT replaces the whole definition, so anything not passed is kept as the system has it. The type is either a domain or a built-in ABAP type, not both. Needs a lock and, outside $TMP, a transport request; writes the inactive version, so activate with activateSafe afterwards.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Data element name.' },
            dataElementUrl: { type: 'string', description: 'Object URL instead of the name.' },
            description: { type: 'string', description: 'Short description.' },
            domain: {
              type: 'string',
              description: 'Domain the element takes its type from, e.g. ZMM_STATUS. Alternative to dataType.'
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
              description: 'Lock handle; omit to use the one this server recorded for the object.'
            },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task.'
            }
          }
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
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

  protected answer(payload: Record<string, unknown>) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(payload)
      }]
    };
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
   * The lock handle to write with: the caller's, or the one this server took
   * for the object earlier. A missing lock is worth saying plainly - the
   * backend answer to a PUT without one reads like a permission problem.
   */
  protected lockHandleFor(objectUrl: string, args: any): { lockHandle: string; from: string } {
    if (typeof args?.lockHandle === 'string' && args.lockHandle.trim()) {
      return { lockHandle: args.lockHandle.trim(), from: 'argument' };
    }
    const held = lockRegistry.get(objectUrl);
    if (held) return { lockHandle: held.lockHandle, from: 'lockRegistry' };
    throw new McpError(
      ErrorCode.InvalidParams,
      `No lockHandle given and none recorded for ${objectUrl}. Call lock on that URL first, or use createDomain / createDataElement, which take the lock themselves.`
    );
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
    const { lockHandle, from } = this.lockHandleFor(url, args);
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
      return this.answer({
        status: 'success',
        written: true,
        domainUrl: url,
        lockHandleFrom: from,
        ...state,
        hint: 'Written to the inactive version. Activate with activateSafe, then read it back with version="active".'
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, `Failed to write the properties of domain ${ddicNameOf(url)}`);
    }
  }

  async handleSetDataElementProperties(args: any): Promise<any> {
    const url = this.urlOf(args, 'dataElementUrl', dataElementUrl, 'data element');
    const { lockHandle, from } = this.lockHandleFor(url, args);
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
      return this.answer({
        status: 'success',
        written: true,
        dataElementUrl: url,
        lockHandleFrom: from,
        typeKind: state.properties.typeName ? 'domain' : 'predefinedAbapType',
        ...state,
        ...(truncated.length ? { truncatedLabels: truncated } : {}),
        hint: 'Written to the inactive version. Activate with activateSafe, then read it back with version="active".'
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
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
      const current = await this.readClient.getDomainProperties(url);
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
      const current = await this.readClient.getDataElementProperties(url);
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

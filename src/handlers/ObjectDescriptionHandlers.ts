import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError, describeAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import { takeLock, releaseLock } from '../lib/lockCycle';
import { activateAndVerify, selectInactive } from '../lib/activation';
import {
  descriptionTarget,
  checkedDescription,
  parseDescriptionDocument,
  withDescription,
  DescriptionError,
  MAX_DESCRIPTION,
  type DescriptionTarget,
  type DescriptionDocument
} from '../lib/objectDescription';
import { planComponentTexts, shortTextOf, AbapDocError, MAX_SHORT_TEXT } from '../lib/abapDocText';
import { ClassEditError } from '../lib/classEdit';
import { ObjectSourceHandlers } from './ObjectSourceHandlers';
import type { ADTClient } from 'abap-adt-api';

const CONTENT_TYPES: Record<DescriptionTarget['type'], string> = {
  CLAS: 'application/vnd.sap.adt.oo.classes.v2+xml',
  INTF: 'application/vnd.sap.adt.oo.interfaces.v2+xml'
};

interface ReadDocument {
  xml: string;
  contentType: string;
  parsed: DescriptionDocument;
}

/**
 * The description of a class or an interface, written the way Eclipse writes
 * it: the metadata document read, its description replaced, PUT back under a
 * lock and activated. See lib/objectDescription for what the backend does with
 * it and why the document is never built from scratch.
 */
export class ObjectDescriptionHandlers extends BaseHandler {
  private readonly editor: ObjectSourceHandlers;

  constructor(client: ADTClient) {
    super(client);
    this.editor = new ObjectSourceHandlers(client);
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'setObjectDescription',
        description: `Change the description of a class or an interface - the text SE24 shows under Properties and SE80 shows in the package tree. It is metadata, not source, so editObject cannot reach it. The metadata document is read, only its description is replaced, and it is written back under a lock with the transport, the way Eclipse does it, and the class builder saves it. The write leaves the object inactive, so it is activated afterwards - and because an activation takes every inactive part of the object along, an object that already has inactive changes is refused unless activate is false. At most ${MAX_DESCRIPTION} characters. The text is written in the logon language. Outside $TMP a transport request is required. With component, the short text of a method, attribute, constant or event is changed instead - and with parameters, those of its parameters. These have no metadata resource: they are written as an ABAP Doc line ("! <p class="shorttext synchronized">) above the declaration, which the backend copies into SEOCOMPOTX/SEOSUBCOTX on save; an ABAP Doc block already there is kept and only its short text lines change. Removing such a line later does not clear the text from the tables.`,
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Class or interface name, e.g. ZCL_APP or ZIF_APP.'
            },
            description: {
              type: 'string',
              description: `The new description, at most ${MAX_DESCRIPTION} characters - of the object, or of the component when one is named.`
            },
            component: {
              type: 'string',
              description: 'A method, attribute, constant or event of the object whose short text is to change, e.g. GET_TASK. Omit for the description of the object itself.'
            },
            parameters: {
              type: 'object',
              description: `With component: short texts of its parameters by name, e.g. {"iv_id": "Task ID", "rv_ok": "Success flag"}, at most ${MAX_SHORT_TEXT} characters each. description may then be left out.`,
              additionalProperties: { type: 'string' }
            },
            objectType: {
              type: 'string',
              description: 'CLAS or INTF. Only needed when the name does not say it (CL_/CX_ is a class, IF_ an interface).'
            },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task. Required outside $TMP.'
            },
            activate: {
              type: 'boolean',
              description: 'Activate afterwards (default true). With false the object is left inactive and other inactive changes of it are no reason to refuse.'
            },
            dryRun: {
              type: 'boolean',
              description: 'Read the current description and check the new one, without locking or writing.'
            }
          },
          required: ['name']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'setObjectDescription':
        return this.answer(await this.setObjectDescriptionCore(args));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown object description tool: ${toolName}`);
    }
  }

  private checked<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error: any) {
      if (error instanceof DescriptionError) throw new McpError(ErrorCode.InvalidParams, error.message);
      throw error;
    }
  }

  /**
   * Read the metadata document on the stateful client: the read decides what
   * gets written, so it belongs to the session that will hold the lock.
   */
  private async readDocument(target: DescriptionTarget): Promise<ReadDocument> {
    const startTime = performance.now();
    try {
      const response = await this.adtclient.httpClient.request(target.objectUrl, { method: 'GET' });
      this.trackRequest(startTime, true);
      const xml = String(response.body ?? '');
      const contentType = String(response.headers?.['content-type'] ?? '').split(';')[0].trim();
      return {
        xml,
        contentType: contentType || CONTENT_TYPES[target.type],
        parsed: this.checked(() => parseDescriptionDocument(xml))
      };
    } catch (error: any) {
      if (error instanceof McpError) throw error;
      this.trackRequest(startTime, false);
      throw wrapAdtError(
        error,
        describeAdtError(error).status === 404
          ? `${target.name} does not exist as ${target.type === 'CLAS' ? 'a class' : 'an interface'}`
          : `Failed to read the metadata of ${target.name}`
      );
    }
  }

  /** Outside a local package nothing is written without a request. */
  private requireTransport(target: DescriptionTarget, packageName: string, transport: string): void {
    if (packageName && !packageName.startsWith('$') && !transport) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${target.name} is in package ${packageName}, so changing its texts needs a transport request (the request itself, not a developer task).`
      );
    }
  }

  /**
   * The inactive parts of the object, which the activation after the write
   * would take along with it.
   */
  private async inactiveParts(target: DescriptionTarget): Promise<{ name: string; type: string }[]> {
    const inactive = selectInactive(await this.adtclient.inactiveObjects(), target.name, target.objectUrl);
    return inactive.map(e => ({ name: e['adtcore:name'], type: e['adtcore:type'] }));
  }

  private inactiveHint(target: DescriptionTarget): string {
    return `${target.name} already has inactive changes, and activating the new text would activate them too. Nothing was written. Activate or discard them first, or pass activate: false and activate later yourself.`;
  }

  async setObjectDescriptionCore(args: any): Promise<Record<string, unknown>> {
    const target = this.checked(() => descriptionTarget(args?.name ?? args?.className, args?.objectType));
    if (args?.component !== undefined && String(args.component).trim()) {
      return this.componentTextsCore(args, target);
    }
    const description = this.checked(() => checkedDescription(args?.description));
    const activate = args?.activate !== false;
    const transport = args?.transport ? String(args.transport).trim().toUpperCase() : '';
    const logonLanguage = String(this.adtclient.language || '').trim().toUpperCase();

    const before = await this.readDocument(target);
    const { packageName, masterLanguage } = before.parsed;
    const base = {
      name: target.name,
      type: target.adtType,
      objectUrl: target.objectUrl,
      packageName,
      before: before.parsed.description,
      after: description,
      language: logonLanguage || before.parsed.language,
      ...(masterLanguage && logonLanguage && masterLanguage.toUpperCase() !== logonLanguage
        ? { note: `The master language of ${target.name} is ${masterLanguage} and the text is written in the logon language ${logonLanguage}, so SE24 in ${masterLanguage} keeps showing the old one.` }
        : {})
    };

    if (before.parsed.description === description) {
      return {
        status: 'success',
        ...base,
        written: false,
        hint: 'The description is already this text. Nothing was written.'
      };
    }

    this.requireTransport(target, packageName, transport);

    if (activate) {
      const inactive = await this.inactiveParts(target);
      if (inactive.length) {
        return { status: 'error', ...base, written: false, inactive, hint: this.inactiveHint(target) };
      }
    }

    if (args?.dryRun === true) {
      return {
        status: 'success',
        ...base,
        dryRun: true,
        written: false,
        hint: 'Checked and not written. Run again without dryRun to write it.'
      };
    }

    const steps: Record<string, unknown>[] = [];
    let lockHandle: string;
    let takenHere: boolean;
    try {
      const lock = await takeLock(this.adtclient, target.objectUrl, undefined, (start, ok) => this.trackRequest(start, ok));
      lockHandle = lock.lockHandle;
      takenHere = lock.taken;
    } catch (error: any) {
      steps.push({ step: 'lock', error: describeAdtError(error).error });
      return {
        status: 'error',
        ...base,
        written: false,
        steps,
        hint: 'Nothing was written: the object could not be locked. Somebody may be editing it.'
      };
    }
    steps.push({ step: 'lock', reused: !takenHere });

    const writeStart = performance.now();
    try {
      const qs: Record<string, string> = { lockHandle };
      if (transport) qs.corrNr = transport;
      await this.adtclient.httpClient.request(target.objectUrl, {
        method: 'PUT',
        qs,
        headers: { 'Content-Type': before.contentType },
        body: withDescription(before.xml, description)
      });
      this.trackRequest(writeStart, true);
      steps.push({ step: 'write' });
    } catch (error: any) {
      this.trackRequest(writeStart, false);
      steps.push({ step: 'write', error: describeAdtError(error).error });
      if (takenHere) steps.push({ step: 'unlock', ...(await this.release(target.objectUrl, lockHandle)) });
      return {
        status: 'error',
        ...base,
        written: false,
        steps,
        hint: 'The backend refused the write, so the description is unchanged.'
      };
    }

    let released = true;
    if (takenHere) {
      const unlock = await this.release(target.objectUrl, lockHandle);
      released = unlock.released;
      steps.push({ step: 'unlock', ...unlock });
    }

    let activated = false;
    if (activate && released) {
      const startTime = performance.now();
      try {
        const outcome = await activateAndVerify(this.adtclient, {
          objectUrl: target.objectUrl,
          objectName: target.name
        });
        this.trackRequest(startTime, true);
        activated = outcome.success;
        steps.push({ step: 'activate', ...outcome });
      } catch (error: any) {
        this.trackRequest(startTime, false);
        steps.push({ step: 'activate', error: describeAdtError(error).error });
      }
    }

    const after = await this.readDocument(target);
    const landed = after.parsed.description === description;
    const ok = landed && (activated || !activate);
    return {
      status: ok ? 'success' : 'error',
      ...base,
      written: landed,
      activated,
      readBack: after.parsed.description,
      steps,
      hint: !landed
        ? `The backend accepted the write but the description reads back as '${after.parsed.description}'. Check the transport request and SE24.`
        : !activate
          ? 'Written; the object is inactive until it is activated (activateSafe).'
          : !released
            ? 'Written, but the lock would not come off, so it was not activated. Release it (unlockAll) and run activateSafe.'
            : activated
              ? 'Written and active, saved by the class builder with the transport given.'
              : 'Written but the activation did not finish - see the activate step, then run activateSafe.'
    };
  }

  /**
   * The short texts of a component and its parameters, as ABAP Doc in the
   * source - see lib/abapDocText. The edit itself is editObject's: lock,
   * patch, unlock, activate.
   */
  private async componentTextsCore(args: any, target: DescriptionTarget): Promise<Record<string, unknown>> {
    const component = String(args.component).trim().toUpperCase();
    const parameters = args?.parameters === undefined
      ? undefined
      : this.parseObjectArg<Record<string, string>>(args.parameters, 'parameters');
    if (parameters !== undefined && (typeof parameters !== 'object' || Array.isArray(parameters) || parameters === null)) {
      throw new McpError(ErrorCode.InvalidParams, 'parameters is an object of parameter name to short text, e.g. {"iv_id": "Task ID"}.');
    }
    const activate = args?.activate !== false;
    const transport = args?.transport ? String(args.transport).trim().toUpperCase() : '';
    const language = String(this.adtclient.language || 'EN').trim().toLowerCase();
    const sourceUrl = `${target.objectUrl}/source/main`;

    const { parsed } = await this.readDocument(target);
    const source = await this.tracked(`Failed to read the source of ${target.name}`, () =>
      this.readClient.getObjectSource(sourceUrl));
    const plan = this.planned(() => planComponentTexts(String(source), {
      component,
      description: args?.description,
      parameters,
      language
    }));

    const base = {
      name: target.name,
      type: target.adtType,
      component,
      packageName: parsed.packageName,
      declaredAt: plan.declaredAt,
      ...(args?.description !== undefined ? { before: shortTextOf(plan.before) ?? '', after: shortTextOf(plan.after) } : {}),
      abapDoc: plan.after,
      language
    };

    if (!plan.edits.length) {
      return { status: 'success', ...base, written: false, hint: 'The ABAP Doc already carries these texts. Nothing was written.' };
    }
    this.requireTransport(target, parsed.packageName, transport);
    if (activate) {
      const inactive = await this.inactiveParts(target);
      if (inactive.length) {
        return { status: 'error', ...base, written: false, inactive, hint: this.inactiveHint(target) };
      }
    }

    const outcome = await this.editor.editObjectCore({
      objectSourceUrl: sourceUrl,
      edits: plan.edits,
      transport: transport || undefined,
      activate,
      dryRun: args?.dryRun === true
    });
    if (args?.dryRun === true || outcome.status !== 'success' || !activate) {
      return {
        ...outcome,
        ...base,
        written: args?.dryRun !== true && outcome.status === 'success',
        hint: args?.dryRun === true
          ? 'Checked and not written. Run again without dryRun to write it.'
          : outcome.hint
      };
    }

    // The tables are the proof: the source served with its ABAP Doc rebuilt
    // from SEOCOMPOTX/SEOSUBCOTX has to carry the texts asked for.
    const fromTables = await this.tracked(`Failed to read back the short texts of ${target.name}`, () =>
      this.readClient.httpClient.request(`${sourceUrl}?withAbapDocFromShortTexts=true`, {
        method: 'GET',
        qs: { version: 'active' }
      }));
    const check = this.planned(() => planComponentTexts(String(fromTables.body ?? ''), {
      component,
      description: args?.description,
      parameters,
      language
    }));
    const landed = check.edits.length === 0;
    return {
      ...outcome,
      ...base,
      status: landed ? 'success' : 'error',
      written: true,
      readBack: check.before,
      hint: landed
        ? 'Written, active, and the short texts are in the tables.'
        : 'The source carries the new ABAP Doc, but the short texts read back from the tables differ - see readBack. Check the class in SE24.'
    };
  }

  private planned<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error: any) {
      if (error instanceof AbapDocError || error instanceof ClassEditError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }
  }

  private async release(objectUrl: string, lockHandle: string) {
    return releaseLock(this.adtclient, objectUrl, lockHandle, (start, ok) => this.trackRequest(start, ok));
  }
}

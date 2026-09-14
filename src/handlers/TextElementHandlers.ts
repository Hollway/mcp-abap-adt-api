import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { SnippetHandlers } from './SnippetHandlers';
import { TransportHandlers } from './TransportHandlers';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import { session_types, textElementsUrl } from 'abap-adt-api';
import type { ADTClient, TextElement, TextElementCategory } from 'abap-adt-api';
import { lockRegistry } from '../lib/lockRegistry';
import { describeAdtError } from '../lib/adtError';
import { takeLock, releaseLock } from '../lib/lockCycle';
import { activateAndVerify } from '../lib/activation';
import { isReadOnly, readOnlyAllowances } from '../lib/serverConfig';
import {
  TextPoolError,
  elementsFromRows,
  parsePoolPrint,
  poolProgramFor,
  readPoolSnippet,
  titleFromRows,
  titleWrite,
  transportObjectFor,
  writePoolSnippet,
  writesFor,
  type PoolCategory
} from '../lib/textPool';

/**
 * Not every release serves text elements over REST.
 *
 * On the ERP system these tools were written against, /sap/bc/adt/textelements
 * does not exist at all: objectStructure offers text elements only as a SAPGUI
 * link. A bare 404 there reads like a wrong object name, which is the wrong
 * thing to go and check.
 */
const missingEndpointHint = (error: unknown): string | undefined => {
  const info = describeAdtError(error);
  if (info.status !== 404) return undefined;
  return 'This release does not serve text elements over ADT: /sap/bc/adt/textelements is not there at all, ' +
    'and ADT itself offers them only through the SAPGUI bridge (transaction SE38 -> Goto -> Text elements). ' +
    'Nothing is wrong with the object name.';
};

const CATEGORIES: TextElementCategory[] = ['symbols', 'selections', 'headings'];

/**
 * The 404 that means "this release does not serve text elements", carried up
 * from whichever call hit it.
 *
 * On a system without the endpoint the 404 arrives at the lock, before the
 * write is ever attempted, so the decision to go the ABAP way cannot be made
 * inside the write alone.
 */
class EndpointNotServed extends Error {
  constructor(readonly original: unknown, readonly hint: string) {
    super(hint);
  }
}

const asNotServed = (error: unknown): EndpointNotServed | undefined => {
  if (error instanceof EndpointNotServed) return error;
  const hint = missingEndpointHint(error);
  return hint ? new EndpointNotServed(error, hint) : undefined;
};

/**
 * Text symbols, selection texts and list headings.
 *
 * These live outside the source: a report's TEXT-001 and the label of a
 * PARAMETERS field are stored per language and are invisible to
 * getObjectSource, so a program written through this server used to come out
 * with numbered fields and empty selection screens no matter how complete its
 * code was.
 */
export class TextElementHandlers extends BaseHandler {
  private readonly snippets: SnippetHandlers;
  private readonly transports: TransportHandlers;

  constructor(client: ADTClient) {
    super(client);
    // The fallback runs ABAP, and running ABAP is a whole dance of its own:
    // create a class, activate it, run it, delete it again. That handler
    // carries it, so this one borrows it rather than repeating it.
    this.snippets = new SnippetHandlers(client);
    // INSERT TEXTPOOL registers nothing, so the pool write has to put the
    // object into the request itself - and say so when there is no request to
    // put it in.
    this.transports = new TransportHandlers(client);
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'getTextElements',
        description: 'Read the text elements of a program, class or function group: text symbols (TEXT-001), selection texts (the labels of PARAMETERS and SELECT-OPTIONS) or list headings. These are stored per language outside the source, so getObjectSource never shows them. On a release that does not serve /sap/bc/adt/textelements the texts are read with READ TEXTPOOL instead, through a throwaway class - the answer says which way it went in "via".',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: {
              type: 'string',
              description: 'Object name, e.g. ZR_APP_FOO.'
            },
            objectType: {
              type: 'string',
              description: 'ADT type of the object: PROG/P, CLAS/OC, FUGR/F. Defaults to PROG/P.'
            },
            category: {
              type: 'string',
              description: 'Which set to read: "symbols" (default), "selections" or "headings".',
              enum: [...CATEGORIES]
            },
            language: {
              type: 'string',
              description: 'Language of the texts on the READ TEXTPOOL fallback: the one-character SAP key (R) or the two-character ISO code (RU). Defaults to the language of the session.'
            },
            url: {
              type: 'string',
              description: 'Escape hatch: the text elements base URL, e.g. /sap/bc/adt/textelements/programs/zr_app_foo.'
            }
          }
        }
      },
      {
        name: 'setTextElements',
        description: 'Write the text elements of a program, class or function group. The write replaces the whole set for that category, so pass every element you want to keep - read them first with getTextElements, or pass merge to change only the ones you name. On a release that does not serve /sap/bc/adt/textelements the pool is written with INSERT TEXTPOOL instead, through a throwaway class: that way needs neither a lock nor an activation, and INSERT TEXTPOOL registers nothing by itself - so pass transport and the object is put into your own task in that request and the entry verified in E071. Without one, the answer says so when the object is in no open request at all, which is how texts quietly stay behind in the development system. The lock is taken on the text elements resource - not on the object - and released again, unless you pass a handle or this server already holds one; outside $TMP a transport request is needed. Pass activate to finish the job, or run activateSafe afterwards: a text write leaves both the object and its text pool inactive.',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: {
              type: 'string',
              description: 'Object name, e.g. ZR_APP_FOO.'
            },
            objectType: {
              type: 'string',
              description: 'ADT type of the object: PROG/P, CLAS/OC, FUGR/F. Defaults to PROG/P.'
            },
            category: {
              type: 'string',
              description: 'Which set to write: "symbols" (default), "selections" or "headings".',
              enum: [...CATEGORIES]
            },
            elements: {
              type: 'array',
              description: 'The complete set for this category: [{id, text, maxLength, ddicReference}]. For selection texts the id is the field name, e.g. P_WERKS; for text symbols the three-character number, e.g. 001.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  maxLength: { type: 'number' },
                  ddicReference: { type: 'string' }
                },
                required: ['id', 'text']
              }
            },
            objectUrl: {
              type: 'string',
              description: 'Object URL, used for the activation; derived from objectName and objectType when omitted. The lock is not taken on this - it goes on the text elements resource.'
            },
            lockHandle: {
              type: 'string',
              description: 'Lock handle. Omit it: the one this server holds for the object is used, and with none held the lock is taken and released here.'
            },
            activate: {
              type: 'boolean',
              description: 'Activate the object after the write (default false). Only possible when this tool took the lock itself - activation is refused while a session holds one.'
            },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task. The READ TEXTPOOL fallback cannot register a change in one; it says so rather than pretending it did.'
            },
            title: {
              type: 'string',
              description: 'The program title (the R row of the pool). ADT serves it in no category and cannot write it at all, so passing this always goes the INSERT TEXTPOOL way. An empty string removes it.'
            },
            titleMaxLength: {
              type: 'number',
              description: 'Declared length of the title. Defaults to the length of the text; a longer title widens it rather than being cut.'
            },
            merge: {
              type: 'boolean',
              description: 'Change only the elements passed and leave the rest of the category alone (default false: the category is replaced whole). Only the fallback honours this - the ADT endpoint always replaces.'
            },
            language: {
              type: 'string',
              description: 'Language to write on the INSERT TEXTPOOL fallback: the one-character SAP key (R) or the two-character ISO code (RU). Defaults to the language of the session.'
            },
            url: {
              type: 'string',
              description: 'Escape hatch: the text elements base URL.'
            }
          },
          required: []
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'getTextElements':
        return this.handleGetTextElements(args);
      case 'setTextElements':
        return this.handleSetTextElements(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown text element tool: ${toolName}`);
    }
  }

  private answer(payload: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  private category(args: any): TextElementCategory {
    const given = String(args?.category || 'symbols');
    if (!CATEGORIES.includes(given as TextElementCategory)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown category '${given}'. It is one of: ${CATEGORIES.join(', ')}.`
      );
    }
    return given as TextElementCategory;
  }

  /** The text elements base URL, built from the object unless given outright. */
  private textUrl(args: any): { url: string; objectType: string } {
    const objectType = String(args?.objectType || 'PROG/P').toUpperCase();
    if (typeof args?.url === 'string' && args.url.trim()) {
      return { url: args.url.trim(), objectType };
    }
    const name = String(args?.objectName || '').trim();
    if (!name) {
      throw new McpError(ErrorCode.InvalidParams, 'Which object? Pass objectName (and objectType), or url.');
    }
    return { url: textElementsUrl(objectType, name), objectType };
  }

  /**
   * The object URL the lock belongs to. Text elements have their own URL
   * space, but the lock is taken on the object itself, so the two are not
   * interchangeable.
   */
  private objectUrl(args: any, objectType: string): string {
    if (typeof args?.objectUrl === 'string' && args.objectUrl.trim()) return args.objectUrl.trim();
    const name = String(args?.objectName || '').trim().toLowerCase();
    if (!name) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Which object holds the lock? Pass objectName, or objectUrl.'
      );
    }
    const encoded = name.includes('/') ? encodeURIComponent(name) : name;
    if (objectType.startsWith('CLAS')) return `/sap/bc/adt/oo/classes/${encoded}`;
    if (objectType.startsWith('FUGR')) return `/sap/bc/adt/functions/groups/${encoded}`;
    return `/sap/bc/adt/programs/programs/${encoded}`;
  }

  async handleGetTextElements(args: any): Promise<any> {
    const { url, objectType } = this.textUrl(args);
    const category = this.category(args);
    const startTime = performance.now();
    try {
      const result = await this.readClient.getTextElements(url, category);
      this.trackRequest(startTime, true);
      return this.answer({
        status: 'success',
        via: 'adt',
        url,
        category,
        count: (result?.textElements || []).length,
        ...result
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      const notServed = asNotServed(error);
      if (notServed) return this.readThroughTextPool(args, url, objectType, category, notServed);
      throw wrapAdtError(error, `Failed to read the ${category} of ${url}`);
    }
  }

  /**
   * The program whose pool the texts are in, and the name to report.
   *
   * With only a URL given the name comes off its last segment, which is how
   * ADT builds it in the first place.
   */
  private poolProgram(args: any, url: string, objectType: string): { program: string; objectName: string } {
    const given = String(args?.objectName || '').trim();
    const objectName = (given || decodeURIComponent(url.split('/').pop() || '')).toUpperCase();
    if (!objectName) {
      throw new McpError(ErrorCode.InvalidParams, 'Which object? Pass objectName (and objectType).');
    }
    return { program: poolProgramFor(objectType, objectName), objectName };
  }

  /**
   * The ABAP way is a write, whatever it is used for.
   *
   * Reading the pool means creating a class, activating it, running it and
   * deleting it again - four changes to the system to answer a question. A
   * read-only server must refuse that, which is why the fence stands here
   * rather than around getTextElements: the ADT read is harmless and keeps
   * working on the systems that serve it.
   */
  private refuseWhenReadOnly(url: string, category: string, notServed: EndpointNotServed): void {
    if (!isReadOnly() || readOnlyAllowances().has('runSnippet')) return;
    throw wrapAdtError(
      notServed.original,
      `Failed to reach the ${category} of ${url}. ${notServed.hint} The way round it is READ TEXTPOOL in a ` +
      'throwaway class, and creating one changes the system, which this server refuses with SAP_READONLY set. ' +
      'Nothing was sent to SAP.'
    );
  }

  /** Run a generated snippet and hand back what it printed. */
  private async runPoolSnippet(code: string[]): Promise<{ output: string; answer: any }> {
    const result = await this.snippets.handleRunSnippet({ code });
    const answer = JSON.parse(result.content[0].text);
    return { output: String(answer?.output ?? ''), answer };
  }

  /**
   * Reading the text pool with ABAP, for the releases that serve no endpoint.
   */
  private async readThroughTextPool(
    args: any,
    url: string,
    objectType: string,
    category: TextElementCategory,
    notServed: EndpointNotServed
  ): Promise<any> {
    this.refuseWhenReadOnly(url, category, notServed);
    const { program, objectName } = this.poolProgram(args, url, objectType);
    const language = args?.language ? String(args.language).trim() : undefined;

    let code: string[];
    try {
      code = readPoolSnippet(program, language);
    } catch (error: any) {
      if (error instanceof TextPoolError) throw new McpError(ErrorCode.InvalidParams, error.message);
      throw error;
    }

    const { output, answer } = await this.runPoolSnippet(code);
    if (answer?.ran !== true) {
      return this.answer({
        status: 'error',
        via: 'textpool',
        url,
        objectName,
        program,
        category,
        steps: answer?.steps,
        error: answer?.runError?.error,
        hint: `${notServed.hint} Reading the pool with ABAP did not get as far as running: the steps above say where it stopped.`
      });
    }

    const print = parsePoolPrint(output);
    const textElements = elementsFromRows(print.rows, category as PoolCategory);
    const title = titleFromRows(print.rows);
    return this.answer({
      status: 'success',
      via: 'textpool',
      url,
      objectName,
      program,
      category,
      ...(language ? { language } : {}),
      count: textElements.length,
      textElements,
      // The title is in no category, so it rides alongside them rather than
      // inside one - and it exists only here, because ADT never serves it.
      ...(title ? { title: title.text, titleMaxLength: title.maxLength } : {}),
      poolRows: print.rows.length,
      ...(print.subrc && print.subrc !== 0 ? { readSubrc: print.subrc } : {}),
      hint: print.rows.length === 0
        ? `${notServed.hint} The pool of ${program} is empty in this language, so there is nothing to show.`
        : `Read with READ TEXTPOOL, not over ADT: this release serves no text elements endpoint.`
    });
  }

  async handleSetTextElements(args: any): Promise<any> {
    const { url, objectType } = this.textUrl(args);
    const category = this.category(args);
    const hasTitle = typeof args?.title === 'string';
    const given = args?.elements === undefined || args?.elements === null
      ? undefined
      : this.parseObjectArg(args.elements, 'elements');
    if (given !== undefined && !Array.isArray(given)) {
      throw new McpError(ErrorCode.InvalidParams, 'elements must be an array of {id, text}.');
    }
    if (given === undefined && !hasTitle) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass elements, or title, or both - there is nothing to write.');
    }
    const elements: TextElement[] = (given || []) as TextElement[];

    // The title is not part of any category and ADT serves it nowhere, so any
    // call carrying one goes the pool way whole - writing the elements over ADT
    // and dropping the title on the floor would be the worst of both.
    if (hasTitle) {
      return this.writeThroughTextPool(
        args, url, objectType, category, elements,
        new EndpointNotServed(undefined, 'ADT serves the program title in no category, so it is written with INSERT TEXTPOOL.')
      );
    }

    try {
      return await this.writeThroughAdt(args, url, objectType, category, elements);
    } catch (error: any) {
      const notServed = asNotServed(error);
      if (!notServed) throw error;
      return this.writeThroughTextPool(args, url, objectType, category, elements, notServed);
    }
  }

  private async writeThroughAdt(
    args: any,
    url: string,
    objectType: string,
    category: TextElementCategory,
    elements: TextElement[]
  ): Promise<any> {
    // The lock goes on the text elements resource itself, not on the object.
    // That is the opposite of what this handler assumed for as long as no
    // system served the endpoint: with a lock on the program, the write is
    // refused with 423 "Resource REPT ZFOO is not locked (invalid lock
    // handle)", naming REPT - the text pool - rather than the program.
    const objectUrl = this.objectUrl(args, objectType);
    // Without the endpoint the 404 lands here, on the lock, so the fallback is
    // decided before a single byte of the write is sent.
    const { lockHandle, from, taken } = await this.lockFor(url, args).catch((error: any) => {
      const notServed = asNotServed(error);
      throw notServed ?? error;
    });

    const startTime = performance.now();
    try {
      this.adtclient.stateful = session_types.stateful;
      await this.adtclient.setTextElements(url, category, elements, lockHandle, args?.transport);
      this.trackRequest(startTime, true);
    } catch (error: any) {
      this.trackRequest(startTime, false);
      if (taken) {
        await releaseLock(this.adtclient, url, lockHandle, (start, ok) => this.trackRequest(start, ok));
      }
      const notServed = asNotServed(error);
      if (notServed) throw notServed;
      throw wrapAdtError(error, `Failed to write the ${category} of ${url}`);
    }

    const steps: Record<string, unknown>[] = [];
    let released = !taken;
    if (taken) {
      const unlock = await releaseLock(
        this.adtclient,
        url,
        lockHandle,
        (start, ok) => this.trackRequest(start, ok)
      );
      released = unlock.released;
      steps.push({ step: 'unlock', ...unlock });
    }

    const common = {
      written: true,
      via: 'adt',
      url,
      objectUrl,
      category,
      count: elements.length,
      lockHandleFrom: from
    };

    if (args?.activate !== true) {
      return this.answer({
        status: 'success',
        ...common,
        activated: false,
        ...(steps.length ? { steps } : {}),
        hint: taken
          ? `The whole set of ${category} was replaced and the lock is back off. Activate the object with activateSafe.`
          : `The whole set of ${category} was replaced. The lock is the one you hold, so release it before activating with activateSafe.`
      });
    }
    if (!released) {
      return this.answer({
        status: 'error',
        ...common,
        activated: false,
        steps,
        hint: 'Written, but the lock would not come off and activation fails while it is held. Release it (unlockAll) and run activateSafe.'
      });
    }

    const activateStart = performance.now();
    try {
      // A text write leaves TWO rows inactive: the object (PROG/P) and its text
      // pool (PROG/PX). Activating by name catches both, which activating the
      // object URL alone would not.
      const outcome = await activateAndVerify(this.adtclient, {
        objectUrl,
        objectName: String(args?.objectName || '').trim().toUpperCase() || undefined
      });
      this.trackRequest(activateStart, true);
      steps.push({ step: 'activate', ...outcome });
      return this.answer({
        status: outcome.success ? 'success' : 'error',
        ...common,
        activated: outcome.success,
        steps,
        hint: outcome.success
          ? `The whole set of ${category} was replaced and the object is active.`
          : 'Written but not active, so the texts are not the ones in use yet. Run activateSafe.'
      });
    } catch (error: any) {
      this.trackRequest(activateStart, false);
      steps.push({ step: 'activate', error: describeAdtError(error).error });
      return this.answer({
        status: 'error',
        ...common,
        activated: false,
        steps,
        hint: 'Written but not active. Nothing was rolled back; run activateSafe.'
      });
    }
  }

  /**
   * Writing the text pool with ABAP, for the releases that serve no endpoint.
   *
   * Read, change and write happen inside one snippet: INSERT TEXTPOOL replaces
   * the pool whole, so splitting them would drop every text of the categories
   * this call is not about. STATE 'A' writes the active version outright -
   * there is nothing to lock and nothing to activate afterwards, which is the
   * one way this path is simpler than the ADT one.
   */
  private async writeThroughTextPool(
    args: any,
    url: string,
    objectType: string,
    category: TextElementCategory,
    elements: TextElement[],
    notServed: EndpointNotServed
  ): Promise<any> {
    this.refuseWhenReadOnly(url, category, notServed);
    const { program, objectName } = this.poolProgram(args, url, objectType);
    const language = args?.language ? String(args.language).trim() : undefined;
    const merge = args?.merge === true;
    const notes: string[] = [];

    const hasTitle = typeof args?.title === 'string';
    const titleOnly = hasTitle && elements.length === 0;
    // With no elements to write, replacing the category as well would wipe the
    // texts the caller never mentioned - and the answer has to say that this is
    // what happened, rather than repeating the merge flag it was given.
    const effectiveMerge = merge || elements.length === 0;
    let code: string[];
    try {
      const writes = writesFor(category as PoolCategory, elements as any, notes);
      // The title is a row of the pool like any other, and it survives a
      // category replace because no category owns the letter R.
      if (hasTitle) writes.push(titleWrite(args.title, args?.titleMaxLength, notes));
      code = writePoolSnippet({
        program,
        category: category as PoolCategory,
        writes,
        language,
        merge: effectiveMerge
      });
    } catch (error: any) {
      if (error instanceof TextPoolError) throw new McpError(ErrorCode.InvalidParams, error.message);
      throw error;
    }

    const { output, answer } = await this.runPoolSnippet(code);
    const print = parsePoolPrint(output);
    const written = answer?.ran === true && print.steps.insert === 0;
    const transport = String(args?.transport || '').trim();
    const steps: Record<string, unknown>[] = [];
    let registered: boolean | undefined;

    if (written) {
      // INSERT TEXTPOOL registers nothing, and a text that is not in a request
      // simply stays in this system - which is the failure nobody sees until
      // the next system is missing it.
      const target = transportObjectFor(objectType, objectName);
      try {
        if (transport) {
          const outcome = JSON.parse((await this.transports.handleRegisterInTransport({
            pgmid: 'R3TR',
            object: target.object,
            objName: target.objName,
            transport
          })).content[0].text);
          registered = outcome?.registered === true;
          steps.push({ step: 'registerInTransport', ...outcome });
          if (!registered) {
            notes.push(
              `The texts are written, but R3TR ${target.object} ${target.objName} did not get into ${transport}: ` +
              `${outcome?.hint || 'the registration was refused'} Nothing was rolled back - the pool keeps the new texts.`
            );
          }
        } else {
          const state = await this.transports.registrationState({
            pgmid: 'R3TR',
            object: target.object,
            objName: target.objName
          });
          if (!state.local && state.openRequests.length === 0) {
            notes.push(
              `R3TR ${target.object} ${target.objName} is in no open request` +
              (state.devclass ? ` (package ${state.devclass})` : '') +
              ', so these texts stay in this system. Pass transport to register it, or add it by hand in SE09. ' +
              'The includes of a program do not carry its text pool: the main program has to be in the request.'
            );
          }
        }
      } catch (error: any) {
        // The texts are already written; failing to say where they travel must
        // not turn into an error that hides that.
        notes.push(
          `The texts are written, but the transport side could not be checked: ${describeAdtError(error).error}`
        );
      }
    }

    if (!written) {
      return this.answer({
        status: 'error',
        via: 'textpool',
        written: false,
        url,
        objectName,
        program,
        category,
        steps: [...(answer?.steps || []), ...steps],
        ...(answer?.runError?.error ? { error: answer.runError.error } : {}),
        ...(print.steps.insert !== undefined ? { insertSubrc: print.steps.insert } : {}),
        ...(notes.length ? { notes } : {}),
        hint: answer?.ran === true
          ? `INSERT TEXTPOOL answered sy-subrc ${print.steps.insert}, so the pool was not written.`
          : `${notServed.hint} The write was attempted with ABAP instead and did not get as far as running.`
      });
    }

    const textElements = elementsFromRows(print.rows, category as PoolCategory);
    const title = titleFromRows(print.rows);
    return this.answer({
      status: registered === false ? 'error' : 'success',
      via: 'textpool',
      written: true,
      url,
      objectName,
      program,
      category,
      ...(language ? { language } : {}),
      merge: effectiveMerge,
      count: elements.length,
      textElements,
      ...(title ? { title: title.text, titleMaxLength: title.maxLength } : {}),
      activated: true,
      ...(registered !== undefined ? { registered, transport } : {}),
      ...(steps.length ? { steps } : {}),
      ...(notes.length ? { notes } : {}),
      hint: titleOnly
        ? 'The title was written and nothing else in the pool was touched. INSERT TEXTPOOL wrote the active ' +
          'version straight away, so there is nothing to activate.'
        : effectiveMerge
          ? 'The elements passed were updated and the rest of the pool was left as it was. INSERT TEXTPOOL wrote ' +
            'the active version straight away, so there is nothing to activate.'
          : `The whole set of ${category} was replaced; the other categories and the program title were kept. ` +
            'INSERT TEXTPOOL wrote the active version straight away, so there is nothing to activate.'
    });
  }

  /**
   * The lock to write with, taken on the text elements resource.
   *
   * A handle the caller passed, or one this process holds for that resource, is
   * used as it stands and left alone. With neither, the lock is taken here and
   * given back after the write - demanding a separate lock call made writing
   * one selection text a three-call sequence, and the URL it has to be taken on
   * is not the object's, which is exactly the mistake this handler used to make
   * itself.
   */
  private async lockFor(
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
}

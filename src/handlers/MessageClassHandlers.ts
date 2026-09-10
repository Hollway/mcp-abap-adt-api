import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler';
import { wrapAdtError, describeAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools';
import type { ADTClient } from 'abap-adt-api';
import { takeLock, releaseLock } from '../lib/lockCycle';
import { readValidation } from '../lib/newObjectValidation';
import {
  messageClassUrl,
  messageLongtextUrl,
  parseMessageClass,
  buildMessageClassDocument,
  prepareMessages,
  missingAfterWrite,
  normaliseNumber,
  MAX_MESSAGE_TEXT,
  type Message,
  type MessageClass,
  type PreparedMessage
} from '../lib/messageClass';

const CONTENT_TYPE = 'application/vnd.sap.adt.mc.messageclass+xml';

/** How many messages an answer carries unless the caller asks for more. */
const DEFAULT_MAX = 200;

/**
 * Message classes and their messages (SE91).
 *
 * MESSAGE e001(zfoo) is the most common way ABAP talks to a user, and until
 * now none of it was reachable here: objectStructure asks the very endpoint
 * that carries the messages and then throws them away, keeping only the
 * generic metadata. So a report written through this server could raise
 * messages that did not exist, and a class could not be given any.
 *
 * What the backend allows is narrower than SE91: a message can be added or
 * changed, but not removed, and its long text can be read and not written.
 * Both refusals are the backend's, are stated in the tool descriptions, and
 * are reported rather than worked around - see lib/messageClass for the
 * measurements behind them.
 */
export class MessageClassHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'getMessages',
        description: 'Read the messages of a message class (SE91): number, text, and whether the message is self-explanatory or has a long text. The messages live inside the class document, so this is the only way to see them - objectStructure on the same class shows the metadata alone. Standard classes are large (class 00 has 875 messages), so pass fromNumber/toNumber or numbers to narrow it down.',
        inputSchema: {
          type: 'object',
          properties: {
            className: {
              type: 'string',
              description: 'Message class, e.g. ZAPP_NOCOND.'
            },
            numbers: {
              type: 'array',
              description: 'Only these message numbers, e.g. ["001","042"]. Leading zeros are added for you.',
              items: { type: 'string' }
            },
            fromNumber: {
              type: 'string',
              description: 'Lowest message number to return, inclusive.'
            },
            toNumber: {
              type: 'string',
              description: 'Highest message number to return, inclusive.'
            },
            search: {
              type: 'string',
              description: 'Only messages whose text contains this (case-insensitive).'
            },
            maxMessages: {
              type: 'number',
              description: `Cap on the messages returned, default ${DEFAULT_MAX}. The answer says when it was cut.`
            }
          },
          required: ['className']
        }
      },
      {
        name: 'getMessageLongtext',
        description: 'Read the long text (cause and procedure) of one message, as the HTML the backend serves. The text is stored per language and there is no fallback: a message documented in EN answers nothing in RU. Writing a long text is not possible over ADT - that resource refuses PUT.',
        inputSchema: {
          type: 'object',
          properties: {
            className: {
              type: 'string',
              description: 'Message class, e.g. ZAPP_NOCOND.'
            },
            number: {
              type: 'string',
              description: 'Message number, e.g. 001 (or 1 - the zeros are added).'
            },
            language: {
              type: 'string',
              description: 'One-character SAP language key of the text, e.g. E or R. Defaults to the logon language.'
            }
          },
          required: ['className', 'number']
        }
      },
      {
        name: 'setMessages',
        description: `Add or change messages of an existing message class. Only the messages passed are touched: the backend upserts by number, so the rest of the class is left alone - and for the same reason a message CANNOT be deleted through ADT. A field left out keeps its current value. The class description is read first and carried over, because the write replaces the class header. The text is capped at ${MAX_MESSAGE_TEXT} characters (what T100 holds) and the answer says what was cut. Takes and releases the lock itself; no activation is needed - the message is in T100 as soon as this returns. Outside $TMP a transport request is required.`,
        inputSchema: {
          type: 'object',
          properties: {
            className: {
              type: 'string',
              description: 'Message class, e.g. ZAPP_NOCOND.'
            },
            messages: {
              type: 'array',
              description: 'The messages to add or change: [{number, text, selfExplanatory}]. text may be omitted only for a message that already exists.',
              items: {
                type: 'object',
                properties: {
                  number: { type: 'string', description: 'Message number, e.g. 001.' },
                  text: { type: 'string', description: 'Message text; &1..&4 are the placeholders.' },
                  selfExplanatory: {
                    type: 'boolean',
                    description: 'True when the message needs no long text. Defaults to the current value, or true for a new message.'
                  }
                },
                required: ['number']
              }
            },
            description: {
              type: 'string',
              description: 'New description of the class itself. Omit to keep the current one.'
            },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task. Required outside $TMP.'
            }
          },
          required: ['className', 'messages']
        }
      },
      {
        name: 'createMessageClass',
        description: 'Create a message class and fill in its messages in one call: validate the name, create the class, write the messages, read them back. No activation is involved. Nothing is rolled back - the answer says which step stopped and in what state the class was left. Outside $TMP a transport request is required.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the new message class, e.g. ZDEV_MCP_MSG.'
            },
            packageName: {
              type: 'string',
              description: 'Package. $TMP for a local class; anything else needs a transport request.'
            },
            description: {
              type: 'string',
              description: 'Description of the class.'
            },
            messages: {
              type: 'array',
              description: 'Messages to write straight away: [{number, text, selfExplanatory}]. Optional - an empty class is valid.',
              items: {
                type: 'object',
                properties: {
                  number: { type: 'string' },
                  text: { type: 'string' },
                  selfExplanatory: { type: 'boolean' }
                },
                required: ['number', 'text']
              }
            },
            language: {
              type: 'string',
              description: 'Master language of the class. Defaults to the logon language - creating it in EN files every text where nobody will look for it.'
            },
            transport: {
              type: 'string',
              description: 'Transport request number - the request itself, not a developer task.'
            },
            dryRun: {
              type: 'boolean',
              description: 'Only validate the name and stop.'
            }
          },
          required: ['name', 'packageName', 'description']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'getMessages':
        return this.handleGetMessages(args);
      case 'getMessageLongtext':
        return this.handleGetMessageLongtext(args);
      case 'setMessages':
        return this.handleSetMessages(args);
      case 'createMessageClass':
        return this.handleCreateMessageClass(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown message class tool: ${toolName}`);
    }
  }

  private answer(payload: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  private className(args: any): string {
    const name = String(args?.className || args?.name || '').trim().toUpperCase();
    if (!name) {
      throw new McpError(ErrorCode.InvalidParams, 'Which message class? Pass className.');
    }
    return name;
  }

  /**
   * Read and parse the class document.
   *
   * The client is an argument on purpose: a plain read goes on the stateless
   * clone, but the read that setMessages does before writing has to stay in
   * the session that holds the lock.
   */
  private async readClass(client: ADTClient, name: string): Promise<MessageClass> {
    const url = messageClassUrl(name);
    const startTime = performance.now();
    try {
      const response = await client.httpClient.request(url, { method: 'GET' });
      this.trackRequest(startTime, true);
      return parseMessageClass(String(response.body ?? ''));
    } catch (error: any) {
      this.trackRequest(startTime, false);
      const info = describeAdtError(error);
      throw wrapAdtError(
        error,
        info.status === 404
          ? `Message class ${name} does not exist`
          : `Failed to read message class ${name}`
      );
    }
  }

  async handleGetMessages(args: any): Promise<any> {
    const name = this.className(args);
    const parsed = await this.readClass(this.readClient, name);

    const wanted: string[] | undefined = Array.isArray(args?.numbers) && args.numbers.length
      ? args.numbers.map((n: string | number) => normaliseNumber(n))
      : undefined;
    const from = args?.fromNumber !== undefined ? normaliseNumber(args.fromNumber) : undefined;
    const to = args?.toNumber !== undefined ? normaliseNumber(args.toNumber) : undefined;
    const search = args?.search ? String(args.search).toLowerCase() : undefined;

    let selected = parsed.messages;
    if (wanted) selected = selected.filter(m => wanted.includes(m.number));
    if (from) selected = selected.filter(m => m.number >= from);
    if (to) selected = selected.filter(m => m.number <= to);
    if (search) selected = selected.filter(m => m.text.toLowerCase().includes(search));

    const max = Number(args?.maxMessages) > 0 ? Number(args.maxMessages) : DEFAULT_MAX;
    const cut = selected.length > max;

    return this.answer({
      status: 'success',
      className: parsed.name || name,
      description: parsed.description,
      packageName: parsed.packageName,
      masterLanguage: parsed.masterLanguage,
      responsible: parsed.responsible,
      totalMessages: parsed.messages.length,
      matched: selected.length,
      messages: cut ? selected.slice(0, max) : selected,
      ...(cut
        ? { truncated: true, hint: `Showing ${max} of ${selected.length} matching messages. Narrow it with fromNumber/toNumber, numbers or search, or raise maxMessages.` }
        : {}),
      ...(wanted
        ? { notFound: wanted.filter(n => !parsed.messages.some(m => m.number === n)) }
        : {})
    });
  }

  async handleGetMessageLongtext(args: any): Promise<any> {
    const name = this.className(args);
    const number = normaliseNumber(args?.number);
    const language = String(args?.language || this.adtclient.language || 'E').toUpperCase();
    const url = messageLongtextUrl(name, number);

    const startTime = performance.now();
    try {
      const response = await this.readClient.httpClient.request(url, {
        method: 'GET',
        qs: { language }
      });
      this.trackRequest(startTime, true);
      return this.answer({
        status: 'success',
        className: name,
        number,
        language,
        contentType: String(response.headers?.['content-type'] ?? ''),
        longtext: String(response.body ?? '')
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      // The backend answers this as a missing resource, which reads like a
      // wrong message number. Nearly always it means the message has no long
      // text in that language - self-explanatory messages never have one.
      throw wrapAdtError(
        error,
        `No long text for message ${number} of ${name} in language ${language}. ` +
        `Self-explanatory messages have none at all, and a text written in another language is not found under this one - getMessages shows which messages are documented`
      );
    }
  }

  async handleSetMessages(args: any): Promise<any> {
    const name = this.className(args);
    const incoming = this.parseObjectArg<any[]>(args?.messages, 'messages');
    if (!Array.isArray(incoming) || !incoming.length) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass messages: [{number, text}].');
    }

    const url = messageClassUrl(name);
    const steps: Record<string, unknown>[] = [];

    // Every call of the write sequence stays on the stateful client: the read
    // below decides what gets written, and reading it in another session would
    // be reading a different point in time from the one holding the lock.
    const before = await this.readClass(this.adtclient, name);
    if (before.packageName && before.packageName !== '$TMP' && !args?.transport) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${name} is in package ${before.packageName}, so changing it needs a transport request (the request itself, not a developer task).`
      );
    }

    let prepared: PreparedMessage[];
    try {
      prepared = prepareMessages(before.messages, incoming);
    } catch (error: any) {
      throw new McpError(ErrorCode.InvalidParams, error?.message || 'The messages could not be prepared.');
    }
    steps.push({ step: 'read', totalMessages: before.messages.length, description: before.description });

    let lockHandle: string;
    let takenHere: boolean;
    try {
      const lock = await takeLock(
        this.adtclient,
        url,
        undefined,
        (start, ok) => this.trackRequest(start, ok)
      );
      lockHandle = lock.lockHandle;
      takenHere = lock.taken;
    } catch (error: any) {
      steps.push({ step: 'lock', error: describeAdtError(error).error });
      return this.answer({
        status: 'error',
        className: name,
        written: false,
        steps,
        hint: 'Nothing was written: the class could not be locked. Somebody else may be editing it in SE91.'
      });
    }
    steps.push({ step: 'lock', lockHandle, reused: !takenHere });

    const document = buildMessageClassDocument({
      name,
      // The write replaces the class header, so the description has to be
      // carried over - a write without it empties the class description.
      description: args?.description !== undefined ? String(args.description) : before.description,
      masterLanguage: before.masterLanguage || String(this.adtclient.language || 'EN').toUpperCase(),
      language: before.language || before.masterLanguage,
      messages: prepared as Message[]
    });

    const writeStart = performance.now();
    try {
      const qs: Record<string, string> = { lockHandle };
      if (args?.transport) qs.corrNr = String(args.transport);
      await this.adtclient.httpClient.request(url, {
        method: 'PUT',
        qs,
        headers: { 'Content-Type': CONTENT_TYPE },
        body: document
      });
      this.trackRequest(writeStart, true);
      steps.push({ step: 'write', messages: prepared.length });
    } catch (error: any) {
      this.trackRequest(writeStart, false);
      steps.push({ step: 'write', error: describeAdtError(error).error });
      if (takenHere) {
        steps.push({ step: 'unlock', ...(await this.release(url, lockHandle)) });
      }
      return this.answer({
        status: 'error',
        className: name,
        written: false,
        steps,
        hint: 'Nothing was written. The backend rejects the whole document over one bad message, so no message of this call landed.'
      });
    }

    // Read back before releasing the lock: the proof belongs to the same
    // session, and an upsert that quietly did nothing looks like success.
    const after = await this.readClass(this.adtclient, name);
    const missing = missingAfterWrite(prepared, after.messages);

    if (takenHere) {
      steps.push({ step: 'unlock', ...(await this.release(url, lockHandle)) });
    }

    const truncated = prepared.filter(m => m.truncatedFrom);
    return this.answer({
      status: missing.length ? 'error' : 'success',
      className: name,
      written: !missing.length,
      description: after.description,
      totalMessages: after.messages.length,
      added: prepared.filter(m => m.action === 'added').map(m => m.number),
      changed: prepared.filter(m => m.action === 'changed').map(m => m.number),
      unchanged: prepared.filter(m => m.action === 'unchanged').map(m => m.number),
      ...(truncated.length
        ? { truncatedTexts: truncated.map(m => ({ number: m.number, from: m.truncatedFrom, to: MAX_MESSAGE_TEXT })) }
        : {}),
      ...(missing.length ? { notWritten: missing } : {}),
      messages: after.messages.filter(m => prepared.some(p => p.number === m.number)),
      steps,
      hint: missing.length
        ? `The class came back without ${missing.join(', ')}. Nothing was rolled back - read the class with getMessages and check what is there.`
        : 'In T100 and usable now: no activation is involved. A message cannot be removed again through ADT - that needs SE91.'
    });
  }

  async handleCreateMessageClass(args: any): Promise<any> {
    const name = String(args?.name || '').trim().toUpperCase();
    const packageName = String(args?.packageName || '').trim().toUpperCase();
    if (!name || !packageName || !args?.description) {
      throw new McpError(ErrorCode.InvalidParams, 'Pass name, packageName and description.');
    }
    if (!args?.transport && packageName !== '$TMP') {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Creating a message class in ${packageName} needs a transport request (the request itself, not a developer task). Only $TMP goes without one.`
      );
    }

    const url = messageClassUrl(name);
    const parentPath = `/sap/bc/adt/packages/${encodeURIComponent(packageName.toLowerCase())}`;
    const language = String(args?.language || this.adtclient.language || 'EN').toUpperCase();
    const steps: Record<string, unknown>[] = [];

    const validateStart = performance.now();
    let validation: any;
    try {
      validation = await this.adtclient.validateNewObject({
        objtype: 'MSAG/N' as any,
        objname: name,
        packagename: packageName,
        description: String(args.description)
      });
      this.trackRequest(validateStart, true);
    } catch (error: any) {
      this.trackRequest(validateStart, false);
      throw wrapAdtError(error, `Failed to validate the new message class ${name}. Nothing was created`);
    }
    // This endpoint answers the validation with 200 and an empty body, which
    // the library reports as success:false. Refusing on that alone would make
    // every message class uncreatable.
    const verdict = readValidation(validation);
    steps.push({ step: 'validate', ...validation, ...(verdict.silent ? { note: 'The backend answered without a verdict, which it does for message classes. Taken as no objection.' } : {}) });
    if (verdict.objection) {
      return this.answer({
        status: 'error',
        created: false,
        className: name,
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
        className: name,
        objectUrl: url,
        packageName,
        steps,
        note: 'The name is free and the package accepts it. Nothing was created.'
      });
    }

    const createStart = performance.now();
    try {
      await this.adtclient.createObject({
        objtype: 'MSAG/N' as any,
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
      throw wrapAdtError(error, `Failed to create the message class ${name}`);
    }
    steps.push({ step: 'create', objectUrl: url, packageName, language });

    const messages = this.parseObjectArg<any[]>(args?.messages, 'messages');
    if (!Array.isArray(messages) || !messages.length) {
      return this.answer({
        status: 'success',
        created: true,
        className: name,
        objectUrl: url,
        packageName,
        totalMessages: 0,
        steps,
        hint: 'The class exists and is empty. Add messages with setMessages.'
      });
    }

    const written = await this.handleSetMessages({
      className: name,
      messages,
      transport: args?.transport
    });
    const outcome = JSON.parse(written.content[0].text);
    steps.push(...(outcome.steps || []));

    return this.answer({
      status: outcome.status,
      created: true,
      className: name,
      objectUrl: url,
      packageName,
      language,
      totalMessages: outcome.totalMessages,
      added: outcome.added,
      ...(outcome.truncatedTexts ? { truncatedTexts: outcome.truncatedTexts } : {}),
      ...(outcome.notWritten ? { notWritten: outcome.notWritten } : {}),
      messages: outcome.messages,
      steps,
      hint: outcome.status === 'success'
        ? 'Class created and its messages are in T100. No activation is involved.'
        : `The class was created but its messages were not all written: ${outcome.hint}`
    });
  }

  private async release(objectUrl: string, lockHandle: string) {
    return releaseLock(
      this.adtclient,
      objectUrl,
      lockHandle,
      (start, ok) => this.trackRequest(start, ok)
    );
  }
}

/**
 * The message class document (SE91), read and written.
 *
 * ADT serves a message class as one attribute-only document: the class header
 * plus a <mc:messages> element per message. Everything here was measured
 * against a live ERP backend, because the endpoint behaves unlike the rest of
 * ADT in four ways that the code has to be built around:
 *
 *  - The messages come inside the class document and nowhere else. The
 *    per-message resource (.../messages/{no}) answers 200 with an empty stub -
 *    msgno="" msgtext="" - for every message, including ones that plainly
 *    exist, so reading one message at a time is not possible.
 *  - The only write that the backend accepts is a PUT of the whole class
 *    document under a lock on the class. A PUT or DELETE on the per-message
 *    resource is refused with "Message X is not locked (invalid lock handle)"
 *    no matter which handle is offered - the class handle, or one taken on the
 *    message URL itself.
 *  - Messages are upserted by number: a PUT carrying one message leaves the
 *    others alone, and a PUT carrying none deletes nothing. Removing a message
 *    through ADT is therefore impossible. The class header, in contrast, is
 *    replaced - so a write that does not carry the current description wipes
 *    it, which is why setMessages reads before it writes.
 *  - The message text is an XML attribute and nearly every real message
 *    contains &1 &2 placeholders. Unescaped, they end the parse with
 *    "End of element messageClass expected" and nothing is written.
 *
 * No activation is involved: the messages land in T100 immediately and
 * inactiveObjects stays empty.
 */

/** The longest text T100 can hold. */
export const MAX_MESSAGE_TEXT = 73;

export interface Message {
  /** Three digits, 000-999. */
  number: string;
  text: string;
  /** True when the message carries no long text of its own. */
  selfExplanatory: boolean;
  /** Whether a long text exists. Computed by the backend - never written. */
  documented?: boolean;
}

export interface MessageClass {
  name: string;
  description: string;
  masterLanguage: string;
  language: string;
  responsible: string;
  packageName: string;
  version: string;
  messages: Message[];
}

export const messageClassUrl = (name: string): string =>
  `/sap/bc/adt/messageclass/${encodeURIComponent(String(name).trim().toLowerCase())}`;

export const messageUrl = (name: string, number: string | number): string =>
  `${messageClassUrl(name)}/messages/${normaliseNumber(number)}`;

export const messageLongtextUrl = (name: string, number: string | number): string =>
  `${messageUrl(name, number)}/longtext`;

/**
 * Message numbers are three digits and SAP keeps the leading zeros: 1, "1" and
 * "001" all mean message 001, and asking for "1" reads nothing.
 */
export function normaliseNumber(value: string | number): string {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(raw)) {
    throw new Error(`Message number '${raw}' is not one to three digits (000-999).`);
  }
  return raw.padStart(3, '0');
}

export function escapeXmlAttribute(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // last, so that an escaped escape (&amp;lt;) survives as text
    .replace(/&amp;/g, '&');
}

/** Attributes of one start tag, by local name (mc:msgno is read as msgno). */
function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  const pattern = /([\w.-]+)(?::([\w.-]+))?\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag)) !== null) {
    const local = match[2] || match[1];
    found[local] = unescapeXml(match[3]);
  }
  return found;
}

const isTrue = (value: string | undefined): boolean => String(value).toLowerCase() === 'true';

/**
 * Read the class document.
 *
 * The message text is absent as an attribute when a message has no text -
 * message 000 of the standard class 00 is like that - and an absent text is
 * not the same thing as an absent message, so it becomes an empty string on a
 * message that is nonetheless reported.
 */
export function parseMessageClass(xml: string): MessageClass {
  const document = String(xml ?? '');
  const header = document.match(/<mc:messageClass\b([^>]*)>/);
  if (!header) {
    throw new Error('The answer is not a message class document: no <mc:messageClass> element.');
  }
  const head = attributes(header[1]);
  const packageRef = document.match(/<adtcore:packageRef\b([^>]*)>/);

  const messages: Message[] = [];
  const pattern = /<mc:messages\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(document)) !== null) {
    const attrs = attributes(match[1]);
    if (attrs.msgno === undefined) continue;
    messages.push({
      number: attrs.msgno,
      text: attrs.msgtext ?? '',
      selfExplanatory: isTrue(attrs.selfexplainatory),
      documented: isTrue(attrs.documented)
    });
  }
  messages.sort((a, b) => a.number.localeCompare(b.number));

  return {
    name: head.name ?? '',
    description: head.description ?? '',
    masterLanguage: head.masterLanguage ?? '',
    language: head.language ?? '',
    responsible: head.responsible ?? '',
    packageName: packageRef ? (attributes(packageRef[1]).name ?? '') : '',
    version: head.version ?? '',
    messages
  };
}

export interface DocumentOptions {
  name: string;
  description: string;
  masterLanguage: string;
  language?: string;
  /** Only the messages to write - the backend upserts them by number. */
  messages: Message[];
}

/**
 * Build the document to PUT. `documented` is deliberately not written: the
 * backend derives it from whether a long text exists, and a long text cannot
 * be written over ADT at all (the longtext resource refuses PUT).
 */
export function buildMessageClassDocument(options: DocumentOptions): string {
  const language = options.language || options.masterLanguage;
  const messages = options.messages
    .map(m =>
      `<mc:messages mc:msgno="${escapeXmlAttribute(normaliseNumber(m.number))}"` +
      ` mc:msgtext="${escapeXmlAttribute(m.text)}"` +
      ` mc:selfexplainatory="${m.selfExplanatory ? 'true' : 'false'}"/>`)
    .join('');

  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass"' +
    ' xmlns:adtcore="http://www.sap.com/adt/core"' +
    ` adtcore:name="${escapeXmlAttribute(options.name.toUpperCase())}"` +
    ' adtcore:type="MSAG/N"' +
    ` adtcore:description="${escapeXmlAttribute(options.description)}"` +
    ` adtcore:masterLanguage="${escapeXmlAttribute(options.masterLanguage)}"` +
    ` adtcore:language="${escapeXmlAttribute(language)}">` +
    messages +
    '</mc:messageClass>';
}

export interface PreparedMessage extends Message {
  /** What this write does to the message that is in the system now. */
  action: 'added' | 'changed' | 'unchanged';
  /** Set when the text was longer than T100 can hold. */
  truncatedFrom?: number;
}

/**
 * Work out what to write, against what the system currently holds.
 *
 * A field the caller left out keeps its current value rather than reverting to
 * a default: asking to change a text should not silently turn a documented
 * message into a self-explanatory one.
 */
export function prepareMessages(
  existing: Message[],
  incoming: Array<{ number: string | number; text?: string; selfExplanatory?: boolean }>
): PreparedMessage[] {
  const current = new Map(existing.map(m => [m.number, m]));
  const seen = new Set<string>();

  return incoming.map(wanted => {
    const number = normaliseNumber(wanted.number);
    if (seen.has(number)) {
      throw new Error(`Message ${number} is listed twice - the last one would silently win.`);
    }
    seen.add(number);

    const now = current.get(number);
    if (wanted.text === undefined && !now) {
      throw new Error(`Message ${number} does not exist yet, so it needs a text.`);
    }

    const requested = wanted.text === undefined ? (now?.text ?? '') : String(wanted.text);
    const text = requested.slice(0, MAX_MESSAGE_TEXT);
    const selfExplanatory = wanted.selfExplanatory === undefined
      ? (now?.selfExplanatory ?? true)
      : Boolean(wanted.selfExplanatory);

    const action: PreparedMessage['action'] = !now
      ? 'added'
      : (now.text === text && now.selfExplanatory === selfExplanatory ? 'unchanged' : 'changed');

    const prepared: PreparedMessage = { number, text, selfExplanatory, action };
    if (requested.length > MAX_MESSAGE_TEXT) prepared.truncatedFrom = requested.length;
    return prepared;
  });
}

/** Numbers a caller asked to write that the system did not come back with. */
export function missingAfterWrite(written: PreparedMessage[], after: Message[]): string[] {
  const present = new Map(after.map(m => [m.number, m]));
  return written
    .filter(w => {
      const got = present.get(w.number);
      return !got || got.text !== w.text;
    })
    .map(w => w.number);
}

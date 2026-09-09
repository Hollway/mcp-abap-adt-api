/**
 * Reading an asXML payload back into plain values.
 *
 * A generated call has to hand its results back somehow, and the console is
 * the only channel a class run has. Printing them with out->write( ) gives the
 * formatted dump an ADT editor shows - readable, but not something that can be
 * taken apart again: a structure and a table of one row look the same, field
 * names are padded away, and a long value is cut.
 *
 * So the generated code serialises the results with CALL TRANSFORMATION id,
 * which is available on every release and needs no helper class, and prints
 * that. What comes back is asXML:
 *
 *   <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
 *    <asx:values>
 *     <EV_COUNT>3</EV_COUNT>
 *     <ES_HEAD><WERKS>1000</WERKS></ES_HEAD>
 *     <ET_ITEMS><item><MATNR>4711</MATNR></item></ET_ITEMS>
 *    </asx:values>
 *   </asx:abap>
 *
 * which is a small enough dialect to read here rather than take a dependency
 * on an XML parser: elements, text, no mixed content, and tables written as a
 * sequence of <item> children.
 */

export class AsXmlError extends Error {}

/** What a parsed element turns into: a value, a structure, or a table. */
export type AsXmlValue = string | AsXmlValue[] | { [name: string]: AsXmlValue };

interface Element {
  name: string;
  children: Element[];
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
};

/**
 * Text as ABAP meant it.
 *
 * Numeric references matter here: the serialiser escapes control characters
 * that way, and a field carrying a tab would otherwise arrive as the literal
 * six characters "&#9;".
 */
export const unescapeXml = (text: string): string =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });

/** The local name of a tag: asx:values and values are the same element here. */
const localName = (name: string): string => {
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
};

interface Cursor {
  position: number;
  nodes: number;
}

const MAX_NODES = 200000;

/**
 * Parse the children of one element, stopping at its closing tag.
 *
 * Anything that is not an element or text - the declaration, comments, CDATA -
 * is skipped rather than refused: the payload is machine-written, and a parser
 * that dies on a processing instruction would be brittle for no gain.
 */
function parseChildren(xml: string, cursor: Cursor, parent: string | undefined): Element[] {
  const children: Element[] = [];
  let text = '';

  while (cursor.position < xml.length) {
    const next = xml.indexOf('<', cursor.position);
    if (next < 0) {
      text += xml.slice(cursor.position);
      cursor.position = xml.length;
      break;
    }
    text += xml.slice(cursor.position, next);
    cursor.position = next;

    if (xml.startsWith('<!--', cursor.position)) {
      const end = xml.indexOf('-->', cursor.position);
      cursor.position = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', cursor.position)) {
      const end = xml.indexOf(']]>', cursor.position);
      const stop = end < 0 ? xml.length : end;
      text += xml.slice(cursor.position + 9, stop);
      cursor.position = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', cursor.position) || xml.startsWith('<!', cursor.position)) {
      const end = xml.indexOf('>', cursor.position);
      cursor.position = end < 0 ? xml.length : end + 1;
      continue;
    }
    if (xml.startsWith('</', cursor.position)) {
      const end = xml.indexOf('>', cursor.position);
      if (end < 0) throw new AsXmlError('The payload ends inside a closing tag.');
      const name = localName(xml.slice(cursor.position + 2, end).trim());
      if (parent !== undefined && name !== parent) {
        throw new AsXmlError(`Expected </${parent}> but found </${name}>.`);
      }
      cursor.position = end + 1;
      return finish(children, text);
    }

    const end = xml.indexOf('>', cursor.position);
    if (end < 0) throw new AsXmlError('The payload ends inside a tag.');
    const inside = xml.slice(cursor.position + 1, end);
    const selfClosing = inside.endsWith('/');
    const head = (selfClosing ? inside.slice(0, -1) : inside).trim();
    const name = localName(head.split(/[\s/]/)[0]);
    if (!name) throw new AsXmlError('The payload has a tag without a name.');
    cursor.position = end + 1;

    if (++cursor.nodes > MAX_NODES) {
      throw new AsXmlError(`The payload has more than ${MAX_NODES} elements.`);
    }

    children.push(
      selfClosing
        ? { name, children: [], text: '' }
        : { name, ...pack(parseChildren(xml, cursor, name)) }
    );
  }

  if (parent !== undefined) throw new AsXmlError(`The payload ends before </${parent}>.`);
  return finish(children, text);
}

/** Children and their text, as one element body. */
const pack = (children: Element[]): { children: Element[]; text: string } =>
  children.length === 1 && children[0].name === '#text'
    ? { children: [], text: children[0].text }
    : { children: children.filter(child => child.name !== '#text'), text: '' };

/**
 * The text of an element is only its own when it has no element children:
 * asXML never mixes the two, and the whitespace between nested tags is layout,
 * not data.
 */
const finish = (children: Element[], text: string): Element[] =>
  children.length > 0 ? children : [{ name: '#text', children: [], text }];

/** One element as a value: text, a table of items, or a structure. */
function toValue(element: Element): AsXmlValue {
  if (element.children.length === 0) return unescapeXml(element.text);

  // A table is written as repeated children of one name - and that name is
  // the row type when the table has a named one, not <item>: DDIF_FIELDINFO_GET
  // answers its DFIES_TAB as <DFIES_TAB><DFIES>..</DFIES><DFIES>..</DFIES>.
  // So repetition is what marks a table, whatever the name; <item> marks one
  // even unrepeated, since a row type without a name is never a component.
  const names = new Set(element.children.map(child => child.name));
  if (names.size === 1) {
    const only = [...names][0];
    if (element.children.length > 1 || only.toLowerCase() === 'item') {
      return element.children.map(toValue);
    }
  }

  const structure: { [name: string]: AsXmlValue } = {};
  for (const child of element.children) structure[child.name] = toValue(child);
  return structure;
}

/**
 * The values of an asXML payload, keyed by the names the serialiser bound.
 *
 * The wrapper is skipped rather than required: what matters is the content of
 * asx:values, and a payload written by a different release may nest it
 * differently or leave the namespace prefix off.
 */
export function parseAsXmlValues(xml: string): Record<string, AsXmlValue> {
  const text = String(xml ?? '').trim();
  if (!text) throw new AsXmlError('The payload is empty.');

  const roots = parseChildren(text, { position: 0, nodes: 0 }, undefined);
  const values = findValues(roots);
  if (!values) {
    throw new AsXmlError('The payload has no asx:values element - it is not an asXML result.');
  }

  const result: Record<string, AsXmlValue> = {};
  for (const child of values.children) result[child.name] = toValue(child);
  return result;
}

/** The asx:values element, wherever the wrapper put it. */
function findValues(elements: Element[]): Element | undefined {
  for (const element of elements) {
    if (element.name.toLowerCase() === 'values') return element;
    const found = findValues(element.children);
    if (found) return found;
  }
  return undefined;
}

/**
 * The payload out of a console the backend may have wrapped.
 *
 * The generated code prints the result base64 encoded between two markers,
 * because the console is a formatted channel: it is free to break a long line,
 * and a break landing inside a field value would corrupt it silently. Base64
 * survives that - every character outside the alphabet is dropped before
 * decoding - and the markers keep whatever else the called code printed out of
 * the way.
 */
export const RESULT_MARKER = '<<<MCP-RESULT>>>';
export const RESULT_END = '<<<MCP-END>>>';

export function decodeResultPayload(output: string): string | undefined {
  const text = String(output ?? '');
  const start = text.indexOf(RESULT_MARKER);
  if (start < 0) return undefined;
  const from = start + RESULT_MARKER.length;
  const end = text.indexOf(RESULT_END, from);
  const encoded = (end < 0 ? text.slice(from) : text.slice(from, end)).replace(/[^A-Za-z0-9+/=]/g, '');
  if (!encoded) return undefined;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  return decoded || undefined;
}

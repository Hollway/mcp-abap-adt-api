/**
 * SAP documentation arrives as a whole HTML page, and it was handed on whole.
 *
 * Measured on a classic ERP system, abapDocumentation for one word of a class
 * source answers with 13,893 characters, of which the doctype, the head, the
 * stylesheet links and the icon links are the larger part; the documentation
 * itself is a few paragraphs. atcDocumentation has the same shape.
 *
 * This turns such a page into the text it carries, keeping the line breaks
 * that make it readable and nothing else. The raw HTML stays available to a
 * caller who asks for it.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...'
};

export function decodeEntities(text: string): string {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[String(name).toLowerCase()] ?? whole);
}

/** The readable text of an HTML page, with its paragraph breaks kept. */
export function htmlToText(html: string): string {
  const raw = String(html ?? '');
  if (!raw) return '';
  // Quick-fix descriptions arrive with their markup escaped - &lt;p&gt; - so
  // the tags have to be brought back before they can be taken out.
  const source = /<[a-z!/]/i.test(raw) || !/&lt;[a-z/]/i.test(raw) ? raw : decodeEntities(raw);
  if (!/<[a-z!/]/i.test(source)) return decodeEntities(source).trim();
  return decodeEntities(
    source
      .replace(/<!doctype[^>]*>/gi, '')
      .replace(/<head\b[\s\S]*?<\/head>/gi, '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol|pre|blockquote)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export interface DocumentText {
  text: string;
  chars: number;
  htmlChars: number;
  /** Present only when the caller asked for the page itself. */
  html?: string;
}

export function documentText(html: string, includeHtml = false): DocumentText {
  const text = htmlToText(html);
  const out: DocumentText = { text, chars: text.length, htmlChars: String(html ?? '').length };
  if (includeHtml) out.html = String(html ?? '');
  return out;
}

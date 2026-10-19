/**
 * The short description of a class or an interface (SE24 "Description").
 *
 * The description is metadata, not source, so editObject never reaches it.
 * Measured on EUD before this existed: the only way left was an UPDATE on
 * SEOCLASSTX from a snippet, which bypasses the class builder: nothing is
 * registered in a transport, and SE80 went on showing the old text for a
 * while (SEOCLASSTX is buffered generically).
 *
 * ADT does serve the write. A PUT of the metadata document to the object URL
 * itself (no /source/main) lands in CL_OO_ADT_RES_CLASS->UPDATE_METADATA, or
 * CL_OO_ADT_RES_INTF->UPDATE_METADATA for an interface: the length is checked
 * (60 characters, not blank), SEO_CLASS_CHANGE_F_DATA /
 * SEO_INTERFACE_CHANGE_F_DATA changes the text and SEO_CLIF_SAVE_ALL saves it
 * with the transport passed as corrNr. That is the path Eclipse takes.
 *
 * Two things follow from that code and shape the tool:
 *  - The document is the one GET returned, with only adtcore:description
 *    replaced. UPDATE_METADATA also takes the message class, the shared-memory
 *    flag and the fixed-point flag from what it is sent, so a document built
 *    from scratch would reset them.
 *  - SEO_CLIF_SAVE_ALL leaves the CU/CP (IU/IP) includes inactive, so the
 *    object has to be activated afterwards - and an activation takes whatever
 *    else of the object is inactive along with it.
 */
import { escapeXmlAttribute, unescapeXml } from './messageClass';

/** What SEOCLASSTX-DESCRIPT holds and what UPDATE_METADATA checks against. */
export const MAX_DESCRIPTION = 60;

export type DescribedType = 'CLAS' | 'INTF';

export interface DescriptionTarget {
  type: DescribedType;
  /** ADT type of the object, as the inactive list names it. */
  adtType: 'CLAS/OC' | 'INTF/OI';
  name: string;
  objectUrl: string;
}

export interface DescriptionDocument {
  description: string;
  packageName: string;
  masterLanguage: string;
  language: string;
  version: string;
}

export class DescriptionError extends Error {}

/** The object a call names: its type from objectType or the name's prefix. */
export function descriptionTarget(name: unknown, objectType?: unknown): DescriptionTarget {
  const upper = String(name ?? '').trim().toUpperCase();
  if (!upper) throw new DescriptionError('Which object? Pass name - a class or an interface.');
  if (!/^[A-Z0-9_/]+$/.test(upper)) {
    throw new DescriptionError(`'${upper}' is not a class or interface name.`);
  }

  const given = String(objectType ?? '').trim().toUpperCase().split('/')[0];
  let type: DescribedType;
  if (given === 'CLAS' || given === 'INTF') {
    type = given;
  } else if (given) {
    throw new DescriptionError(
      `objectType ${given} is not served: only CLAS and INTF descriptions are written over ADT here.`
    );
  } else {
    // Without a type the name decides, as it does for every Z/Y object worth
    // describing; a name that says neither has to say it with objectType.
    const bare = upper.replace(/^\/[^/]+\//, '');
    if (/^[ZY]?IF_/.test(bare)) type = 'INTF';
    else if (/^[ZY]?C[LX]_/.test(bare)) type = 'CLAS';
    else {
      throw new DescriptionError(
        `Is ${upper} a class or an interface? Pass objectType CLAS or INTF.`
      );
    }
  }

  const segment = type === 'CLAS' ? 'classes' : 'interfaces';
  return {
    type,
    adtType: type === 'CLAS' ? 'CLAS/OC' : 'INTF/OI',
    name: upper,
    objectUrl: `/sap/bc/adt/oo/${segment}/${encodeURIComponent(upper.toLowerCase())}`
  };
}

/** The new text, trimmed and checked the way the backend checks it. */
export function checkedDescription(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new DescriptionError('Pass description - the backend refuses an empty one.');
  if (text.length > MAX_DESCRIPTION) {
    throw new DescriptionError(
      `The description is ${text.length} characters; SEOCLASSTX holds ${MAX_DESCRIPTION}. Nothing was written.`
    );
  }
  return text;
}

/** The root element of the document: everything up to its first '>'. */
function rootTag(xml: string): { start: number; end: number; tag: string } {
  const body = xml.replace(/^\s*<\?xml[^>]*\?>/, match => ' '.repeat(match.length));
  const start = body.search(/<[A-Za-z]/);
  if (start < 0) throw new DescriptionError('The metadata document has no root element.');
  const end = body.indexOf('>', start);
  if (end < 0) throw new DescriptionError('The metadata document has no complete root element.');
  return { start, end, tag: xml.slice(start, end) };
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`));
  return match ? unescapeXml(match[1]) : undefined;
}

export function parseDescriptionDocument(xml: string): DescriptionDocument {
  const { tag } = rootTag(xml);
  const description = attribute(tag, 'adtcore:description');
  if (description === undefined) {
    throw new DescriptionError('The metadata document carries no adtcore:description.');
  }
  const packageRef = xml.match(/<adtcore:packageRef\b[^>]*\sadtcore:name="([^"]*)"/);
  return {
    description,
    packageName: packageRef ? unescapeXml(packageRef[1]).toUpperCase() : '',
    masterLanguage: attribute(tag, 'adtcore:masterLanguage') ?? '',
    language: attribute(tag, 'adtcore:language') ?? '',
    version: attribute(tag, 'adtcore:version') ?? ''
  };
}

/**
 * The document as read, with the description of the root element replaced and
 * nothing else touched: UPDATE_METADATA takes the other properties from it too.
 */
export function withDescription(xml: string, description: string): string {
  const { start, end, tag } = rootTag(xml);
  const pattern = /(\sadtcore:description=")[^"]*(")/;
  if (!pattern.test(tag)) {
    throw new DescriptionError('The metadata document carries no adtcore:description.');
  }
  const replaced = tag.replace(pattern, (_m, open, close) => `${open}${escapeXmlAttribute(description)}${close}`);
  return xml.slice(0, start) + replaced + xml.slice(end);
}

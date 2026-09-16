/**
 * Activating an object and proving it happened.
 *
 * Neither answer from the backend can be taken at face value: activateByName
 * has returned success:true for a class that stayed inactive, and activating
 * only the CLAS/OC entry leaves changed method fragments behind, so the old
 * implementation keeps running while the new signature is already active. An
 * empty inactive list afterwards is the only proof, and this is where that
 * check lives - activateSafe and editObject both use it.
 */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ADTClient } from "abap-adt-api";

export interface InactiveObject {
  "adtcore:uri": string;
  "adtcore:type": string;
  "adtcore:name": string;
  "adtcore:parentUri": string;
}

export interface InactiveObjectElement extends InactiveObject {
  user: string;
  deleted: boolean;
}

export interface InactiveObjectRecord {
  object?: InactiveObjectElement;
  transport?: InactiveObjectElement;
}

export interface ActivationMessage {
  objDescr: string;
  type: string;
  line: number;
  href: string;
  forceSupported: boolean;
  shortText: string;
}

export interface ActivationResult {
  success: boolean;
  messages: ActivationMessage[];
  inactive: InactiveObjectRecord[];
}

export interface ObjectRef {
  name: string;
  type: string;
}

export interface ActivationOutcome {
  success: boolean;
  activated: ObjectRef[];
  messages?: ActivationMessage[];
  stillInactive?: ObjectRef[];
  /** Inactive objects that were not part of this activation. */
  othersInactive?: ObjectRef[];
  othersInactiveCount?: number;
  note?: string;
  hint?: string;
}

export interface ActivationRequest {
  objectName?: string;
  objectUrl?: string;
  parentUri?: string;
  objects?: InactiveObject[];
  preauditRequested?: boolean;
}

/**
 * Rows of the inactive list that belong to one object.
 *
 * Fragments are named "<OBJECT>  <METHOD>" and their URIs extend the object
 * URI with a #type=... suffix, so both matches are prefix-based.
 */
export function selectInactive(
  records: InactiveObjectRecord[],
  objectName?: string,
  objectUrl?: string
): InactiveObjectElement[] {
  const elements = records
    .map(r => r.object)
    .filter((e): e is InactiveObjectElement => !!e && !!e['adtcore:uri']);
  if (!objectName && !objectUrl) return elements;

  const name = objectName?.toUpperCase();
  const url = objectUrl?.toLowerCase();
  return elements.filter(e => {
    const byName = name ? (e['adtcore:name'] || '').toUpperCase().startsWith(name) : false;
    const byUrl = url ? (e['adtcore:uri'] || '').toLowerCase().startsWith(url) : false;
    return byName || byUrl;
  });
}

const asRef = (e: { 'adtcore:name': string; 'adtcore:type': string }): ObjectRef =>
  ({ name: e['adtcore:name'], type: e['adtcore:type'] });

/** How many of the other inactive objects an answer lists before it counts them. */
export const MAX_OTHERS_LISTED = 25;

/**
 * What is still inactive after an activation, split in two: the object that
 * was activated, and everything else.
 *
 * The second half is the one that misleads. An activation narrowed to a name -
 * activateByName with mainInclude takes exactly one include per call - checks
 * itself against that name only, so the answer reads `stillInactive: []` while
 * the four other includes of the same program sit inactive. Reporting them is
 * the difference between "this include is active" and "the program is".
 */
export function splitInactive(
  records: InactiveObjectRecord[],
  objectName?: string,
  objectUrl?: string
): { forObject: ObjectRef[]; others: ObjectRef[] } {
  const mine = selectInactive(records, objectName, objectUrl);
  const uris = new Set(mine.map(e => e['adtcore:uri']));
  return {
    forObject: mine.map(asRef),
    others: selectInactive(records).filter(e => !uris.has(e['adtcore:uri'])).map(asRef)
  };
}

/**
 * Package URI of an object, from the path the workbench shows for it.
 *
 * findObjectPath answers with the whole chain from the top of the package tree
 * down to the object, and the object's own metadata does not carry its package.
 * The chain is where it has to be read - but it is the step CLOSEST to the
 * object, not the first one: ZCL_APP comes back as ZAPP, ZAPP_BASE, ZCL_APP, and
 * taking the first DEVC named the superpackage ZAPP. The object really sits in
 * ZAPP_BASE, so a package move was built against a package the object is not in
 * and the backend refused the preview with "Package assignment of object
 * changed since the refactoring started", and an activation that needed a
 * parentUri was given the wrong one.
 *
 * Returns undefined rather than throwing: this is a convenience, and the caller
 * still has a clear error for the case where it does not work.
 */
export async function packageUriOf(
  client: ADTClient,
  objectUrl: string
): Promise<string | undefined> {
  try {
    const url = objectUrl.split('#')[0];
    const path: any[] = await client.findObjectPath(url);
    const isPackage = (step: any) =>
      `${step?.['adtcore:type'] || ''}`.toUpperCase().startsWith('DEVC');

    // The object's own step names its package in parentUri; the package steps
    // are ordered from the root down, so the last one is the innermost.
    const self = (path || []).find(step =>
      `${step?.['adtcore:uri'] || ''}`.split('#')[0] === url && !isPackage(step));
    const parentUri = `${self?.['adtcore:parentUri'] || ''}`;
    const fromParent = parentUri
      ? decodeURIComponent(parentUri.split('/').pop() || '')
      : '';

    const packages = (path || []).filter(isPackage);
    const name = fromParent || packages[packages.length - 1]?.['adtcore:name'];
    if (!name) return undefined;
    return `/sap/bc/adt/packages/${encodeURIComponent(String(name).toLowerCase())}`;
  } catch {
    return undefined;
  }
}

/** Activate exactly what is inactive for this object, then check it is gone. */
export async function activateAndVerify(
  client: ADTClient,
  request: ActivationRequest
): Promise<ActivationOutcome> {
  const before: InactiveObjectRecord[] = await client.inactiveObjects();
  const selected = request.objects
    ? request.objects
    : selectInactive(before, request.objectName, request.objectUrl);

  if (selected.length === 0) {
    return {
      success: true,
      activated: [],
      note: request.objectName || request.objectUrl
        ? 'Nothing inactive matches that object - it is already active, or the edit never reached the system.'
        : 'Nothing is inactive; there was nothing to activate.'
    };
  }

  const objects: InactiveObject[] = selected.map(e => ({
    'adtcore:uri': e['adtcore:uri'],
    'adtcore:type': e['adtcore:type'],
    'adtcore:name': e['adtcore:name'],
    'adtcore:parentUri': e['adtcore:parentUri'] || request.parentUri || ''
  }));

  // Activation rejects an entry with an empty parentUri, and the inactive list
  // leaves it empty for a program - seen live on a $TMP report, where the
  // whole edit succeeded and only the activation fell over on a value the
  // system knows perfectly well. Ask it.
  if (objects.some(o => !o['adtcore:parentUri'])) {
    const resolved = await packageUriOf(client, request.objectUrl || objects[0]['adtcore:uri']);
    if (resolved) {
      objects.forEach(o => {
        if (!o['adtcore:parentUri']) o['adtcore:parentUri'] = resolved;
      });
    }
  }

  const missingParent = objects.filter(o => !o['adtcore:parentUri']);
  if (missingParent.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Activation needs a non-empty adtcore:parentUri, the inactive list left it empty for: ${
        missingParent.map(o => o['adtcore:name']).join(', ')
      }, and the package could not be looked up. Pass parentUri=/sap/bc/adt/packages/<package>.`
    );
  }

  const result: ActivationResult = await client.activate(objects, request.preauditRequested);

  const after: InactiveObjectRecord[] = await client.inactiveObjects();
  const { forObject: stillInactive, others } = splitInactive(after, request.objectName, request.objectUrl);

  const success = result.success && stillInactive.length === 0;
  return {
    success,
    activated: objects.map(asRef),
    messages: result.messages,
    stillInactive,
    // Only what was asked for was activated, and success says only that. What
    // else is inactive is the caller's own worklist, and a program whose other
    // includes are still inactive is not an activated program.
    ...(others.length
      ? {
        othersInactive: others.slice(0, MAX_OTHERS_LISTED),
        othersInactiveCount: others.length
      }
      : {}),
    hint: success
      ? others.length
        ? `Activated what was asked for. ${others.length} other object(s) are still inactive - they were not part of this call.`
        : undefined
      : stillInactive.length > 0
        ? 'Some parts are still inactive - read the messages, fix the source and run activateSafe again.'
        : 'The backend reported a failure; the messages carry the syntax or activation errors.'
  };
}

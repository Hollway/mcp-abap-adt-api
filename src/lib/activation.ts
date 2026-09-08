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

/**
 * Package URI of an object, from the path the workbench shows for it.
 *
 * findObjectPath answers with the chain from the package down to the object,
 * and the package step is the DEVC entry - the object's own metadata does not
 * carry it. Returns undefined rather than throwing: this is a convenience, and
 * the caller still has a clear error for the case where it does not work.
 */
export async function packageUriOf(
  client: ADTClient,
  objectUrl: string
): Promise<string | undefined> {
  try {
    const path: any[] = await client.findObjectPath(objectUrl.split('#')[0]);
    const devc = (path || []).find(step =>
      `${step?.['adtcore:type'] || ''}`.toUpperCase().startsWith('DEVC'));
    const name = devc?.['adtcore:name'];
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
  const stillInactive = selectInactive(after, request.objectName, request.objectUrl).map(asRef);

  const success = result.success && stillInactive.length === 0;
  return {
    success,
    activated: objects.map(asRef),
    messages: result.messages,
    stillInactive,
    hint: success
      ? undefined
      : stillInactive.length > 0
        ? 'Some parts are still inactive - read the messages, fix the source and run activateSafe again.'
        : 'The backend reported a failure; the messages carry the syntax or activation errors.'
  };
}

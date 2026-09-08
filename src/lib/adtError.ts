/**
 * Structured mapping of abap-adt-api exceptions to MCP tool errors.
 *
 * The library raises AdtErrorException / AdtCsrfException / AdtHttpException,
 * all of which carry far more than the axios message the handlers used to pass
 * on ("Request failed with status code 400"). SAP's own diagnosis lives in
 * `localizedMessage`, the exception `type` and the T100 message key, and losing
 * it makes every backend rejection look identical. wrapAdtError keeps those
 * fields, and keeps the original exception in `cause` so callers such as the
 * session-recovery wrapper can still inspect it.
 */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isAdtError, isCsrfError, isHttpError, isLoginError } from "abap-adt-api";

/**
 * `sap`       - the backend answered with an exc:exception document, i.e. this
 *               is a real, diagnosed rejection (wrong parameter, missing
 *               authorization, object locked by someone else, ...).
 * `transport` - HTTP failed without an ADT diagnosis (empty or unparseable
 *               body, network error). A dead ADT session looks like this: the
 *               library falls back to `simpleError`, which yields an empty
 *               `type` and no properties.
 */
export type AdtDiagnostic = 'sap' | 'transport';

export interface AdtErrorInfo {
  error: string;
  status?: number;
  adtType?: string;
  t100?: string;
  localizedMessage?: string;
  namespace?: string;
  sapMessage?: string;
  diagnostic: AdtDiagnostic;
}

export class AdtToolError extends McpError {
  readonly info: AdtErrorInfo;
  readonly cause: unknown;

  constructor(info: AdtErrorInfo, cause: unknown) {
    super(ErrorCode.InternalError, info.error);
    this.info = info;
    this.cause = cause;
  }
}

const trim = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const text = `${value}`.trim();
  return text.length > 0 ? text : undefined;
};

const t100Key = (properties: Record<string, string> | undefined): string | undefined => {
  const id = trim(properties?.["T100KEY-ID"]);
  const no = trim(properties?.["T100KEY-NO"]);
  if (!id && !no) return undefined;
  return [id, no].filter(Boolean).join('-');
};

/** Extract everything the exception knows, without assuming which kind it is. */
export function describeAdtError(e: unknown): AdtErrorInfo {
  const anyErr = e as any;

  if (isAdtError(e)) {
    const adtType = trim(e.type);
    return {
      error: trim(e.localizedMessage) || trim(e.message) || 'ADT error',
      status: typeof e.err === 'number' && e.err > 0 ? e.err : undefined,
      adtType,
      t100: t100Key(e.properties as Record<string, string>),
      localizedMessage: trim(e.localizedMessage),
      namespace: trim(e.namespace),
      sapMessage: trim(e.message),
      // simpleError() produces an AdtErrorException with an empty type and no
      // properties - that is an undiagnosed HTTP failure, not a SAP verdict.
      diagnostic: adtType ? 'sap' : 'transport'
    };
  }

  if (isCsrfError(e)) {
    return {
      error: trim(anyErr.message) || 'CSRF token rejected',
      adtType: 'CsrfError',
      diagnostic: 'transport'
    };
  }

  if (isHttpError(e)) {
    return {
      error: trim(anyErr.message) || 'HTTP error',
      status: typeof anyErr.status === 'number' ? anyErr.status : undefined,
      adtType: trim(anyErr.code),
      diagnostic: 'transport'
    };
  }

  return {
    error: trim(anyErr?.message) || `${e}`,
    diagnostic: 'transport'
  };
}

/**
 * Wrap an exception raised by abap-adt-api into an MCP error that keeps SAP's
 * diagnosis. `label` is the old human-readable prefix ("Failed to lock object").
 */
export function wrapAdtError(e: unknown, label: string): AdtToolError {
  if (e instanceof AdtToolError) return e;
  if (e instanceof McpError) {
    // Argument validation raised by a handler itself - keep its code and text.
    throw e;
  }
  const info = describeAdtError(e);
  return new AdtToolError({ ...info, error: `${label}: ${info.error}` }, e);
}

/** Serializable payload for a failed tool call. */
export function errorPayload(e: unknown): Record<string, unknown> {
  const info = e instanceof AdtToolError ? e.info : describeAdtError(e);
  const payload: Record<string, unknown> = { error: info.error, diagnostic: info.diagnostic };
  if (info.status !== undefined) payload.status = info.status;
  if (info.adtType) payload.adtType = info.adtType;
  if (info.t100) payload.t100 = info.t100;
  if (info.localizedMessage && info.localizedMessage !== info.error) {
    payload.localizedMessage = info.localizedMessage;
  }
  if (info.namespace) payload.namespace = info.namespace;
  if (info.sapMessage && info.sapMessage !== info.localizedMessage) {
    payload.sapMessage = info.sapMessage;
  }
  return payload;
}

/**
 * True when the failure looks like a dead ADT session rather than a rejection.
 *
 * Two shapes count:
 *  - isLoginError: HTTP 401, a CSRF exception, or the library's 400 +
 *    "Session timed out" special case;
 *  - an undiagnosed 400/403, which is what every call returns once the
 *    stateful session has been poisoned (no exc:exception body at all).
 */
export function isSessionFailure(e: unknown): boolean {
  const cause = e instanceof AdtToolError ? e.cause : e;
  try {
    if (isLoginError(cause as any)) return true;
  } catch {
    // isLoginError only inspects type guards; ignore anything unexpected
  }
  const info = e instanceof AdtToolError ? e.info : describeAdtError(e);
  return info.diagnostic === 'transport' && (info.status === 400 || info.status === 403);
}

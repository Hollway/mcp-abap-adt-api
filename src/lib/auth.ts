/**
 * Who is calling, taken from the HTTP Authorization header.
 *
 * Over stdio the credentials come from the environment and belong to the one
 * person who started the process. Over HTTP one server serves everybody, so
 * every request has to say who it is - and the answer decides which SAP
 * session in the pool it gets. That makes this module the place where a user
 * identity is established, and the only place that handles a password.
 *
 * Nothing here throws: a bad header is a 401 for the caller, not a stack trace
 * in the log, and the HTTP layer is what knows how to say that.
 */
import { createHash } from 'crypto';

export interface BasicCredentials {
  /**
   * Upper-cased, because SAP user names are: treating `jsmith` and
   * `JSMITH` as two people would open two sessions for one of them and
   * halve the pool for no reason.
   */
  user: string;
  /** Verbatim - a password is case sensitive and may legitimately end in a space. */
  password: string;
}

export type AuthFailure =
  | 'missing'      // no Authorization header at all
  | 'scheme'       // present, but not Basic
  | 'encoding'     // not valid base64, or not valid UTF-8 once decoded
  | 'malformed'    // no colon separating user from password
  | 'emptyUser'
  | 'emptyPassword';

export type AuthResult =
  | { ok: true; credentials: BasicCredentials }
  | { ok: false; failure: AuthFailure; message: string };

const MESSAGES: Record<AuthFailure, string> = {
  missing: 'No Authorization header. Send your SAP credentials as HTTP Basic authentication.',
  scheme: 'Only Basic authentication is supported. Send your SAP credentials as HTTP Basic.',
  encoding: 'The Basic credentials are not valid base64-encoded UTF-8.',
  malformed: 'The Basic credentials must decode to "user:password".',
  emptyUser: 'The Basic credentials carry no user name.',
  emptyPassword: 'The Basic credentials carry no password, and SAP will not accept an empty one.'
};

const fail = (failure: AuthFailure): AuthResult =>
  ({ ok: false, failure, message: MESSAGES[failure] });

/** What base64 may consist of; Buffer.from swallows anything else in silence. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** U+FFFD - what an invalid byte sequence decodes to instead of failing. */
const REPLACEMENT = '�';

const unpadded = (text: string): string => text.replace(/=+$/, '');

/**
 * Decode base64 strictly.
 *
 * Buffer.from(..., 'base64') never fails: it drops what it cannot read and
 * returns the rest. A password that quietly lost its last character that way
 * becomes a failed SAP logon nobody can explain, so the result is re-encoded
 * and compared - anything that does not survive the round trip was not
 * base64 to begin with.
 */
const decodeBase64 = (token: string): string | undefined => {
  if (!BASE64.test(token)) return undefined;
  // Length must be a multiple of four, padding included - RFC 4648 base64,
  // which is what RFC 7617 says Basic credentials are. Insisting on it is
  // what makes a truncated token detectable at all: re-encoding alone does
  // not always notice, because the bits a dropped character carried can be
  // zero, and then the shortened token round-trips as if nothing were
  // missing. The password would come out one character short and the logon
  // would fail with nothing to point at.
  if (token.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(token, 'base64');
  if (unpadded(bytes.toString('base64')) !== unpadded(token)) return undefined;
  const text = bytes.toString('utf-8');
  return text.includes(REPLACEMENT) ? undefined : text;
};

/**
 * Read `Authorization: Basic <base64>` into a user and a password.
 *
 * Deliberately tolerant about the shape of the header - the scheme in any
 * case, extra whitespace - and deliberately strict about its content.
 */
export function parseBasicAuth(header: string | undefined | null): AuthResult {
  if (!header || !header.trim()) return fail('missing');

  // Split on the first run of whitespace rather than matching the whole
  // header: "Basic abc def" is malformed credentials, not an unsupported
  // scheme, and saying so is the difference between a caller fixing their
  // encoding and a caller looking for an auth method that was never wrong.
  const trimmed = header.trim();
  const space = trimmed.search(/\s/);
  const scheme = space < 0 ? trimmed : trimmed.slice(0, space);
  if (scheme.toLowerCase() !== 'basic') return fail('scheme');

  const token = space < 0 ? '' : trimmed.slice(space + 1).trim();
  if (!token) return fail('encoding');
  const decoded = decodeBase64(token);
  if (decoded === undefined) return fail('encoding');

  // Only the first colon separates the two: a password may contain colons,
  // a SAP user name may not.
  const separator = decoded.indexOf(':');
  if (separator < 0) return fail('malformed');

  const user = decoded.slice(0, separator).trim().toUpperCase();
  const password = decoded.slice(separator + 1);

  if (!user) return fail('emptyUser');
  if (!password) return fail('emptyPassword');

  return { ok: true, credentials: { user, password } };
}

/**
 * Which pooled SAP session a request belongs to.
 *
 * The client and the language are part of the key because they are part of
 * the session: the same person against another client is another session, and
 * the texts ADT returns depend on the language it was opened with. The URL is
 * normalised so a trailing slash cannot split one system in two.
 *
 * The password is NOT part of the key - see passwordFingerprint.
 */
export function sessionKey(parts: {
  url: string;
  client?: string;
  language?: string;
  user: string;
}): string {
  const url = parts.url.trim().replace(/\/+$/, '').toLowerCase();
  const client = (parts.client || '').trim();
  const language = (parts.language || '').trim().toUpperCase();
  return `${url}|${client}|${language}|${parts.user.trim().toUpperCase()}`;
}

/**
 * A stable, non-reversible mark of the password behind a pooled session.
 *
 * Putting the password in the session key would leak it into every log line
 * and every metric that names a session. Keeping its fingerprint beside the
 * session answers the only question the pool has - "same password as last
 * time, or did the user change it" - without the pool holding a usable copy.
 */
export function passwordFingerprint(password: string): string {
  return createHash('sha256').update(password, 'utf-8').digest('hex');
}

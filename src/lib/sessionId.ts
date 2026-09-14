/**
 * The id of a SAP security session, in a form that is safe to log and that
 * SAP can be asked about.
 *
 * SM04 lists sessions that belong to nobody the moment the process holding
 * them dies without logging off - a pod killed rather than stopped, a crash,
 * a `taskkill`. Telling one of those apart from a session that is in use
 * needs a key that appears both in this server's log and somewhere on the
 * backend, and SM04's own "session key" (T82_U11195_M0) is not it: that is
 * an internal dialogue-session key, and nothing the HTTP client holds
 * corresponds to it.
 *
 * What does correspond is the SAP_SESSIONID cookie. Decoded it is 32 bytes,
 * and it splits in two:
 *
 *   - the first 16 bytes are the secret. Whoever has them has the session.
 *   - the last 16 bytes are SECURITY_CONTEXT-LINK - the "time-invariant"
 *     handle SAP keeps for that security session, listed in SM05 and
 *     readable from the SECURITY_CONTEXT table.
 *
 * So the second half is logged and the first half never is. That is not a
 * compromise between usefulness and safety: the half that identifies is not
 * the half that authenticates, and printing only LINK gives an exact join
 * against SAP's own list while leaking nothing that can be replayed. It also
 * survives SAP rotating the session id, which the cookie itself does not.
 *
 *   SELECT * FROM security_context WHERE link = '<what the log printed>'
 */
import type { ADTClient } from 'abap-adt-api';

/** Bytes of SECURITY_CONTEXT-LINK, which is the tail of the cookie. */
const LINK_BYTES = 16;

/**
 * The cookie value, or undefined when the client holds none.
 *
 * Reading it reaches no backend - it looks at cookies the client already has
 * - so it costs nothing and, importantly, is not use of the session: the
 * pool's idle clock must not be reset by describing a session for a log line.
 */
const cookieValue = (client: unknown): string | undefined => {
  try {
    const raw = (client as ADTClient | undefined)?.sessionID;
    if (!Array.isArray(raw) || raw.length < 2) return undefined;
    // The getter splits the cookie on '=', and the value is base64 that is
    // often padded with one - so put it back together.
    const value = raw.slice(1).join('=');
    return value || undefined;
  } catch {
    // A client that never logged in, or a test double without the property.
    // Not knowing the id is no reason to fail whatever was being logged.
    return undefined;
  }
};

/**
 * SECURITY_CONTEXT-LINK for this client, as SAP stores it: 32 hex digits,
 * ready to paste into SE16 or a WHERE clause.
 */
export const sessionLink = (client: unknown): string | undefined => {
  const value = cookieValue(client);
  if (!value) return undefined;
  // The cookie arrives percent-encoded (the base64 padding becomes %3d) and
  // in the URL alphabet, where '-' and '_' stand for '+' and '/'.
  const bytes = Buffer.from(
    decodeURIComponent(value).replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  );
  if (bytes.length < LINK_BYTES) return undefined;
  return bytes.subarray(bytes.length - LINK_BYTES).toString('hex').toUpperCase();
};

import { sessionLink } from '../lib/sessionId';

/**
 * Measured against EUD: a live cookie decoded to
 *   3E675D79E8FA97BC7B40B0BAEA737BF9 DB883C5FADA111F18000005056A2C8B3
 * and SECURITY_CONTEXT held a row whose LINK was the second half exactly,
 * while its ID - the first half - was already a different value, because SAP
 * rotates that and leaves LINK alone. So the tail is the part worth printing
 * and the head is the part that must never be printed.
 */
const client = (sessionID: unknown) => ({ sessionID }) as unknown;
const LIVE = 'Pmddeej6l7x7QLC66nN7-duIPF-toRHxgAAAUFaiyLM%3d';

describe('sessionLink', () => {
  it('gives back the LINK half of a real cookie', () => {
    expect(sessionLink(client(['SAP_SESSIONID_EUD_102', LIVE])))
      .toBe('DB883C5FADA111F18000005056A2C8B3');
  });

  /**
   * The head of the cookie authenticates. A log that carries it hands
   * whoever reads it the session, so no arrangement of characters from the
   * first sixteen bytes may appear in the answer.
   */
  it('says nothing about the half that is the secret', () => {
    const link = sessionLink(client(['SAP_SESSIONID_EUD_102', LIVE]));
    expect(link).not.toContain('3E675D79');
    expect(link).toHaveLength(32);
  });

  /**
   * The getter splits the cookie on '=', and base64 padding is a '='. Taking
   * only the first two pieces would decode a truncated value and produce a
   * link that matches nothing.
   */
  it('puts a padded value back together', () => {
    const split = ['SAP_SESSIONID_EUD_102', ...LIVE.split('=')];
    expect(sessionLink(client(split))).toBe('DB883C5FADA111F18000005056A2C8B3');
  });

  it('has nothing to say about a client that never logged in', () => {
    expect(sessionLink(client(''))).toBeUndefined();
    expect(sessionLink(client(['SAP_SESSIONID_EUD_102']))).toBeUndefined();
    expect(sessionLink(undefined)).toBeUndefined();
  });

  /** A value too short to hold a link is not one, however it decodes. */
  it('refuses a value that is not long enough to contain a link', () => {
    expect(sessionLink(client(['SAP_SESSIONID_EUD_102', 'YWJj']))).toBeUndefined();
  });

  /**
   * Reading the cookie reaches into the client's internals. Whatever happens
   * there must not bring down the line that was being logged.
   */
  it('survives a client whose getter throws', () => {
    const angry = { get sessionID(): string[] { throw new Error('no session'); } };
    expect(sessionLink(angry)).toBeUndefined();
  });
});

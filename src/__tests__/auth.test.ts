import { parseBasicAuth, sessionKey, passwordFingerprint } from '../lib/auth';

/**
 * Over HTTP this is the only thing standing between a request and a SAP
 * session, so the failure modes matter more than the happy path: a header
 * that decodes to *almost* the right password produces a logon failure with
 * no visible cause, and a user name whose case is not normalised silently
 * doubles the sessions one person holds.
 */
const basic = (text: string): string => `Basic ${Buffer.from(text).toString('base64')}`;

describe('parseBasicAuth', () => {
  it('reads the user and the password', () => {
    const result = parseBasicAuth(basic('JSMITH:secret'));
    expect(result).toEqual({ ok: true, credentials: { user: 'JSMITH', password: 'secret' } });
  });

  it('upper-cases the user, because SAP does, and leaves the password alone', () => {
    const result = parseBasicAuth(basic('jsmith:SeCrEt'));
    expect(result.ok && result.credentials).toEqual({ user: 'JSMITH', password: 'SeCrEt' });
  });

  it('keeps a password that contains colons whole', () => {
    const result = parseBasicAuth(basic('USER:a:b:c'));
    expect(result.ok && result.credentials.password).toBe('a:b:c');
  });

  it('keeps whitespace inside a password, which is part of it', () => {
    const result = parseBasicAuth(basic('USER: pass '));
    expect(result.ok && result.credentials.password).toBe(' pass ');
  });

  it('accepts the scheme in any case and with extra whitespace', () => {
    const token = Buffer.from('USER:pw').toString('base64');
    for (const header of [`basic ${token}`, `BASIC ${token}`, `  Basic   ${token}  `]) {
      const result = parseBasicAuth(header);
      expect(result.ok && result.credentials.user).toBe('USER');
    }
  });

  it('reads a non-ASCII password', () => {
    const result = parseBasicAuth(basic('USER:пароль'));
    expect(result.ok && result.credentials.password).toBe('пароль');
  });

  it('reports a missing header rather than guessing', () => {
    for (const header of [undefined, null, '', '   ']) {
      expect(parseBasicAuth(header)).toMatchObject({ ok: false, failure: 'missing' });
    }
  });

  it('refuses another scheme', () => {
    expect(parseBasicAuth('Bearer abcdef')).toMatchObject({ ok: false, failure: 'scheme' });
  });

  it('refuses Basic with nothing after it', () => {
    expect(parseBasicAuth('Basic')).toMatchObject({ ok: false, failure: 'encoding' });
  });

  it('refuses a header carrying more than one token', () => {
    expect(parseBasicAuth('Basic abc def')).toMatchObject({ ok: false, failure: 'encoding' });
  });

  it('refuses a token that is not base64', () => {
    expect(parseBasicAuth('Basic not*base64!')).toMatchObject({ ok: false, failure: 'encoding' });
  });

  /**
   * The case that decides why this module decodes strictly: Buffer.from drops
   * what it cannot read, so a truncated token would otherwise yield a
   * password one character short and a logon failure with no explanation.
   */
  it('refuses a truncated token instead of returning a shortened password', () => {
    const token = Buffer.from('JSMITH:secret').toString('base64');
    expect(parseBasicAuth(`Basic ${token.slice(0, -1)}`))
      .toMatchObject({ ok: false, failure: 'encoding' });
  });

  /**
   * Re-encoding alone would not catch every truncation: when the bits the
   * dropped character carried happen to be zero, the shortened token
   * round-trips perfectly and the password comes out one character short.
   * The length rule is what closes that gap.
   */
  it('refuses a truncation that still round-trips', () => {
    const token = Buffer.from('JSMITH:hunter22').toString('base64');
    expect(token).not.toContain('=');
    expect(parseBasicAuth(`Basic ${token.slice(0, -1)}`))
      .toMatchObject({ ok: false, failure: 'encoding' });
  });

  it('refuses bytes that are not UTF-8', () => {
    const token = Buffer.concat([Buffer.from('USER:'), Buffer.from([0xff, 0xfe])]).toString('base64');
    expect(parseBasicAuth(`Basic ${token}`)).toMatchObject({ ok: false, failure: 'encoding' });
  });

  it('refuses credentials with no colon in them', () => {
    expect(parseBasicAuth(basic('JSMITH'))).toMatchObject({ ok: false, failure: 'malformed' });
  });

  it('refuses an empty user', () => {
    expect(parseBasicAuth(basic(':secret'))).toMatchObject({ ok: false, failure: 'emptyUser' });
  });

  it('refuses an empty password rather than letting SAP reject it', () => {
    expect(parseBasicAuth(basic('USER:'))).toMatchObject({ ok: false, failure: 'emptyPassword' });
  });

  it('explains every failure in words the caller can act on', () => {
    const result = parseBasicAuth('Bearer x');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/Basic/);
  });
});

describe('sessionKey', () => {
  const base = { url: 'https://sap.example.test/DEV00', client: '102', language: 'RU' };

  it('gives one key to one person however they spell themselves', () => {
    expect(sessionKey({ ...base, user: 'jsmith' }))
      .toBe(sessionKey({ ...base, user: ' JSMITH ' }));
  });

  it('does not split a system in two over a trailing slash', () => {
    expect(sessionKey({ ...base, url: `${base.url}/`, user: 'X' }))
      .toBe(sessionKey({ ...base, user: 'X' }));
  });

  it('separates the same person on another client', () => {
    expect(sessionKey({ ...base, client: '100', user: 'X' }))
      .not.toBe(sessionKey({ ...base, user: 'X' }));
  });

  it('separates the same person in another language, because the texts differ', () => {
    expect(sessionKey({ ...base, language: 'EN', user: 'X' }))
      .not.toBe(sessionKey({ ...base, user: 'X' }));
  });

  it('separates two people on the same system', () => {
    expect(sessionKey({ ...base, user: 'A' })).not.toBe(sessionKey({ ...base, user: 'B' }));
  });

  it('survives a missing client and language', () => {
    expect(sessionKey({ url: base.url, user: 'X' })).toBe(sessionKey({ url: base.url, user: 'X' }));
  });
});

describe('passwordFingerprint', () => {
  it('is the same for the same password and different for another', () => {
    expect(passwordFingerprint('secret')).toBe(passwordFingerprint('secret'));
    expect(passwordFingerprint('secret')).not.toBe(passwordFingerprint('secret '));
  });

  it('does not carry the password in it', () => {
    expect(passwordFingerprint('secret')).not.toContain('secret');
  });
});

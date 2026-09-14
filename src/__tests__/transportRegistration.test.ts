import {
  TransportRegistrationError,
  buildE071Row,
  chooseTask,
  diagnose,
  headerSql,
  holdersSql,
  isLocalPackage,
  isNoiseMessage,
  packageSql,
  registeredSql,
  tasksSql,
  transportNumber,
  EXCEPTIONS
} from '../lib/transportRegistration';

/**
 * Registering an object in a request by hand, for the writes that do not do it
 * themselves.
 *
 * Two measured facts shape all of this. TR_APPEND_TO_COMM_OBJS_KEYS wants the
 * TASK, not the request - a request number is accepted by the parameter and
 * achieves nothing - and the message SCTS_CTO_CUST_SYNC/003 it leaves behind
 * means the call worked. RS_CORR_INSERT, the obvious alternative, answers
 * subrc 1 from an ADT class whatever it is passed.
 */
const row = { PGMID: 'R3TR', OBJECT: 'PROG', OBJ_NAME: 'ZR_MM_NC_PG' };

describe('buildE071Row', () => {
  it('takes what the transport system spells, and uppercases it', () => {
    expect(buildE071Row({ object: 'prog', objName: 'zr_mm_nc_pg' })).toEqual(row);
    expect(buildE071Row({ pgmid: 'limu', object: 'rept', objName: 'zr_foo' }))
      .toEqual({ PGMID: 'LIMU', OBJECT: 'REPT', OBJ_NAME: 'ZR_FOO' });
  });

  it('refuses what would put a wrong or dangerous key into a request', () => {
    expect(() => buildE071Row({ pgmid: 'R3XX', object: 'PROG', objName: 'Z' })).toThrow(TransportRegistrationError);
    expect(() => buildE071Row({ object: 'PROGRAM', objName: 'Z' })).toThrow(TransportRegistrationError);
    expect(() => buildE071Row({ object: 'PROG', objName: '' })).toThrow(TransportRegistrationError);
    expect(() => buildE071Row({ object: 'PROG', objName: "Z'; DELETE FROM e071" })).toThrow(TransportRegistrationError);
    expect(() => buildE071Row({ object: 'PROG', objName: 'Z'.repeat(121) })).toThrow(TransportRegistrationError);
  });

  it('keeps the namespace characters a real object name has', () => {
    expect(buildE071Row({ object: 'PROG', objName: '/dune/zr_foo' }).OBJ_NAME).toBe('/DUNE/ZR_FOO');
  });
});

describe('diagnose', () => {
  it('says what the common refusals mean', () => {
    expect(diagnose('OB_LOCKED_BY_OTHER')).toMatch(/locked in somebody else/);
    expect(diagnose('TR_ORDER_RELEASED')).toMatch(/already released/);
    expect(diagnose('OB_LOCAL_OBJECT')).toMatch(/never transported/);
  });

  // Inventing a detailed diagnosis for an exception nobody here has seen would
  // read as knowledge this module does not have.
  it('falls back on the prefix rather than making something up', () => {
    expect(diagnose('OB_WRONG_TABLETYP')).toBe('The object was refused (OB_WRONG_TABLETYP).');
    expect(diagnose('KEY_NO_KEY_FIELDS')).toBe('The key entry was refused (KEY_NO_KEY_FIELDS).');
    expect(diagnose('TR_LOCKMOD_FAILED')).toBe('The request was refused (TR_LOCKMOD_FAILED).');
    expect(diagnose('')).toBe('');
  });

  it('carries the whole exception list the signature has', () => {
    expect(EXCEPTIONS.size).toBe(67);
    expect(EXCEPTIONS.has('OB_LOCKED_BY_OTHER')).toBe(true);
  });
});

describe('isNoiseMessage', () => {
  // Measured: this message sits in sy-msg* after a call that worked, and
  // reading it as a failure is the mistake.
  it('knows the message a successful call leaves behind', () => {
    expect(isNoiseMessage('SCTS_CTO_CUST_SYNC/003')).toBe(true);
    expect(isNoiseMessage('Object EUDK9A3P1S locked')).toBe(false);
  });
});

describe('the queries', () => {
  it('read the request, its tasks, the registration and the package', () => {
    expect(headerSql('eudk900123')).toContain("trkorr = 'EUDK900123'");
    expect(tasksSql('EUDK900123')).toContain("strkorr = 'EUDK900123'");
    expect(registeredSql('EUDK900124', row)).toContain("obj_name = 'ZR_MM_NC_PG'");
    expect(packageSql(row)).toContain('FROM tadir');
    // An object lives in one open request at a time, and which one is the
    // answer OB_LOCKED_BY_OTHER does not give.
    expect(holdersSql(row)).toContain("e070~trstatus = 'D'");
  });

  it('refuse a number that is not one', () => {
    expect(() => transportNumber("EUDK900123' OR '1'='1")).toThrow(TransportRegistrationError);
    expect(() => transportNumber('nonsense')).toThrow(TransportRegistrationError);
    expect(transportNumber('eudk9a3p1s')).toBe('EUDK9A3P1S');
  });
});

describe('isLocalPackage', () => {
  it('counts every $ package as local, not just $TMP', () => {
    expect(isLocalPackage('$TMP')).toBe(true);
    expect(isLocalPackage('$MCP')).toBe(true);
    expect(isLocalPackage('ZMM')).toBe(false);
    expect(isLocalPackage(undefined)).toBe(false);
  });
});

describe('chooseTask', () => {
  const request = { TRKORR: 'EUDK9A3P1R', STRKORR: '', TRSTATUS: 'D', TRFUNCTION: 'K' };
  const mine = { TRKORR: 'EUDK9A3P1S', STRKORR: 'EUDK9A3P1R', TRSTATUS: 'D', AS4USER: 'VKRIVOROT' };
  const theirs = { TRKORR: 'EUDK9A3P1T', STRKORR: 'EUDK9A3P1R', TRSTATUS: 'D', AS4USER: 'OTHER' };

  it('resolves a request to the caller\'s own open task', () => {
    expect(chooseTask('EUDK9A3P1R', request, [mine, theirs], 'VKRIVOROT'))
      .toEqual({ task: 'EUDK9A3P1S', request: 'EUDK9A3P1R', resolvedFrom: 'request' });
  });

  it('uses a task as it stands', () => {
    expect(chooseTask('EUDK9A3P1S', mine, [], 'VKRIVOROT'))
      .toEqual({ task: 'EUDK9A3P1S', request: 'EUDK9A3P1R', resolvedFrom: 'task' });
  });

  it('refuses somebody else\'s task and points at the request instead', () => {
    expect(() => chooseTask('EUDK9A3P1T', theirs, [], 'VKRIVOROT'))
      .toThrow(/task of OTHER.*EUDK9A3P1R/);
  });

  it('names the open tasks when none of them is the caller\'s', () => {
    expect(() => chooseTask('EUDK9A3P1R', request, [theirs], 'VKRIVOROT'))
      .toThrow(/no open task of VKRIVOROT.*EUDK9A3P1T \(OTHER\)/);
  });

  // Guessing between two tasks of one user puts the object in the one the
  // caller is not looking at.
  it('refuses to choose between two of the caller\'s own tasks', () => {
    const second = { ...mine, TRKORR: 'EUDK9A3P1U' };
    expect(() => chooseTask('EUDK9A3P1R', request, [mine, second], 'VKRIVOROT'))
      .toThrow(/EUDK9A3P1S, EUDK9A3P1U/);
  });

  it('refuses a released request and a number that is not there', () => {
    expect(() => chooseTask('EUDK9A3P1R', { ...request, TRSTATUS: 'R' }, [], 'VKRIVOROT'))
      .toThrow(/released/);
    expect(() => chooseTask('EUDK9A3P1R', undefined, [], 'VKRIVOROT'))
      .toThrow(/does not exist/);
  });
});

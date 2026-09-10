import { DdicPropertyHandlers } from '../handlers/DdicPropertyHandlers';
import { lockRegistry } from '../lib/lockRegistry';

/**
 * createDomain and createDataElement are the sequence a DDIC object needs to
 * end up usable: create, lock, write the definition, unlock, activate. What
 * these tests hold in place is that order, the refusal to create outside $TMP
 * without a transport, and the promise that a failure half-way says exactly
 * where it stopped instead of rolling anything back.
 */
const DOMAIN_URL = '/sap/bc/adt/ddic/domains/zapp_test';
const ELEMENT_URL = '/sap/bc/adt/ddic/dataelements/zapp_test';

const META = {
  name: 'ZAPP_TEST',
  description: 'Test',
  language: 'EN',
  masterLanguage: 'EN',
  masterSystem: 'DEV',
  responsible: 'TESTER',
  packageName: '$TMP'
};

const EMPTY_DOMAIN = {
  metaData: META,
  properties: {
    typeInformation: { datatype: '', length: 0, decimals: 0 },
    outputInformation: { length: 0, signExists: false, lowercase: false, ampmFormat: false }
  }
};

const EMPTY_ELEMENT = {
  metaData: META,
  properties: {
    typeName: '',
    dataType: '',
    dataTypeLength: 0,
    dataTypeDecimals: 0,
    fieldLabels: {
      shortFieldLabel: '',
      mediumFieldLabel: '',
      longFieldLabel: '',
      headingFieldLabel: ''
    },
    searchHelp: '',
    searchHelpParameter: '',
    setGetParameter: '',
    defaultComponentName: '',
    deactivateInputHistory: false,
    changeDocument: false,
    leftToRightDirection: false,
    deactivateBIDIFiltering: false
  }
};

const handler = (over: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const created: any[] = [];
  const written: any[] = [];
  let activations = 0;
  const client = {
    stateful: 'stateless',
    language: 'RU',
    validateNewObject: async () => { calls.push('validate'); return { success: true }; },
    createObject: async (options: any) => { calls.push('create'); created.push(options); },
    lock: async () => { calls.push('lock'); return { LOCK_HANDLE: 'HANDLE' }; },
    unLock: async () => { calls.push('unlock'); },
    getDomainProperties: async () => { calls.push('read'); return EMPTY_DOMAIN; },
    getDataElementProperties: async () => { calls.push('read'); return EMPTY_ELEMENT; },
    setDomainProperties: async (_url: string, properties: any, metaData: any) => {
      calls.push('write');
      written.push({ properties, metaData });
    },
    setDataElementProperties: async (_url: string, properties: any, metaData: any) => {
      calls.push('write');
      written.push({ properties, metaData });
    },
    inactiveObjects: async () => {
      calls.push('inactiveObjects');
      return activations === 0
        ? [{
          object: {
            'adtcore:uri': DOMAIN_URL,
            'adtcore:type': 'DOMA/DD',
            'adtcore:name': 'ZAPP_TEST',
            'adtcore:parentUri': '/sap/bc/adt/packages/%24tmp',
            user: 'TESTER',
            deleted: false
          }
        }]
        : [];
    },
    activate: async () => {
      calls.push('activate');
      activations += 1;
      return { success: true, messages: [], inactive: [] };
    },
    ...over
  };
  return { handlers: new DdicPropertyHandlers(client as any), calls, created, written };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

const DOMAIN_ARGS = {
  name: 'ZAPP_TEST',
  description: 'Test',
  packageName: '$TMP',
  datatype: 'CHAR',
  length: 4
};

beforeEach(() => lockRegistry.clear());

describe('createDomain', () => {
  it('validates, creates, locks, writes, unlocks and only then activates', async () => {
    const { handlers, calls, written } = handler();
    const result = answer(await handlers.handleCreateDomain(DOMAIN_ARGS));

    expect(calls).toEqual([
      'validate', 'create', 'lock', 'read', 'write', 'unlock',
      'inactiveObjects', 'activate', 'inactiveObjects'
    ]);
    expect(result).toMatchObject({
      status: 'success',
      created: true,
      written: true,
      activated: true,
      objectUrl: DOMAIN_URL,
      name: 'ZAPP_TEST'
    });
    expect(written[0].properties.typeInformation).toEqual({ datatype: 'CHAR', length: 4, decimals: 0 });
    // The metadata written back is the system's own, apart from the language:
    // the library would create the object as EN and file its texts there,
    // where a developer logged on in another language never sees them.
    expect(written[0].metaData).toEqual({ ...META, language: 'RU', masterLanguage: 'RU' });
    expect(lockRegistry.count()).toBe(0);
  });

  it('creates in the logon language, not the library default of EN', async () => {
    const { handlers, created } = handler();
    await handlers.handleCreateDomain(DOMAIN_ARGS);
    expect(created[0]).toMatchObject({ language: 'RU', masterLanguage: 'RU', parentName: '$TMP' });

    const explicit = handler();
    await explicit.handlers.handleCreateDomain({ ...DOMAIN_ARGS, language: 'en' });
    expect(explicit.created[0]).toMatchObject({ language: 'EN', masterLanguage: 'EN' });
  });

  it('refuses a package other than $TMP without a transport, before creating anything', async () => {
    const { handlers, calls } = handler();
    await expect(handlers.handleCreateDomain({ ...DOMAIN_ARGS, packageName: 'ZAPP_BASE' }))
      .rejects.toThrow(/needs a transport request/);
    expect(calls).toEqual([]);
  });

  it('stops at a name the system refuses, and creates nothing', async () => {
    const { handlers, calls } = handler({
      validateNewObject: async () => ({ success: false, SEVERITY: 'E', SHORT_TEXT: 'Name is already used' })
    });
    const result = answer(await handlers.handleCreateDomain(DOMAIN_ARGS));
    expect(result).toMatchObject({ status: 'error', created: false });
    expect(result.hint).toContain('Name is already used');
    expect(calls).toEqual([]);
  });

  it('a dry run validates and stops', async () => {
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleCreateDomain({ ...DOMAIN_ARGS, dryRun: true }));
    expect(result).toMatchObject({ status: 'success', dryRun: true, created: false });
    expect(calls).toEqual(['validate']);
  });

  it('reports where it stopped when the definition cannot be written, and keeps no lock', async () => {
    const { handlers, calls } = handler({
      setDomainProperties: async () => { throw new Error('type not allowed'); }
    });
    const result = answer(await handlers.handleCreateDomain(DOMAIN_ARGS));
    expect(result).toMatchObject({ status: 'error', created: true, written: false });
    expect(result.hint).toContain('cannot be activated');
    expect(calls).toEqual(['validate', 'create', 'lock', 'read', 'unlock']);
    expect(lockRegistry.count()).toBe(0);
  });

  it('leaves the object inactive when asked not to activate', async () => {
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleCreateDomain({ ...DOMAIN_ARGS, activate: false }));
    expect(result).toMatchObject({ status: 'success', written: true, activated: false });
    expect(calls).not.toContain('activate');
  });
});

describe('createDataElement', () => {
  it('writes a domain-based element and activates it', async () => {
    const { handlers, calls, written } = handler();
    const result = answer(await handlers.handleCreateDataElement({
      name: 'ZAPP_TEST',
      description: 'Test',
      packageName: '$TMP',
      domain: 'zapp_test',
      label: 'Test status'
    }));

    expect(calls).toEqual([
      'validate', 'create', 'lock', 'read', 'write', 'unlock',
      'inactiveObjects', 'activate', 'inactiveObjects'
    ]);
    expect(result).toMatchObject({
      status: 'success',
      activated: true,
      objectUrl: ELEMENT_URL,
      typeKind: 'domain'
    });
    expect(written[0].properties.typeName).toBe('ZAPP_TEST');
    expect(written[0].properties.fieldLabels.shortFieldLabel).toBe('Test statu');
    expect(result.truncatedLabels).toEqual([{ label: 'short', limit: 10, written: 'Test statu' }]);
  });

  it('writes a built-in type element', async () => {
    const { handlers, written } = handler();
    const result = answer(await handlers.handleCreateDataElement({
      name: 'ZAPP_TEST',
      description: 'Test',
      packageName: '$TMP',
      dataType: 'dec',
      length: 13,
      decimals: 2,
      label: 'Amount'
    }));
    expect(result).toMatchObject({ status: 'success', typeKind: 'predefinedAbapType' });
    expect(written[0].properties).toMatchObject({
      typeName: '',
      dataType: 'DEC',
      dataTypeLength: 13,
      dataTypeDecimals: 2
    });
  });

  it('refuses a type given twice and a type given not at all', async () => {
    const { handlers, calls } = handler();
    await expect(handlers.handleCreateDataElement({
      name: 'ZAPP_TEST', description: 'Test', packageName: '$TMP', domain: 'ZD', dataType: 'CHAR'
    })).rejects.toThrow(/either from a domain/);
    await expect(handlers.handleCreateDataElement({
      name: 'ZAPP_TEST', description: 'Test', packageName: '$TMP'
    })).rejects.toThrow(/needs a type/);
    expect(calls).toEqual([]);
  });
});

/**
 * Changing an existing definition used to demand a lock handle of its own and
 * refuse without one, pointing at createDomain - which is no help when the
 * object already exists. The lock is taken and given back here now, unless it
 * belongs to somebody else.
 */
describe('setDomainProperties and setDataElementProperties: the lock', () => {
  it('takes the lock, writes and gives it back', async () => {
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleSetDomainProperties({
      name: 'ZAPP_TEST', description: 'Edited'
    }));

    expect(calls).toEqual(['lock', 'read', 'write', 'unlock']);
    expect(result.status).toBe('success');
    expect(result.written).toBe(true);
    expect(result.lockHandleFrom).toBe('takenHere');
    expect(result.activated).toBe(false);
    expect(result.hint).toMatch(/lock is back off/);
  });

  it('reads what the system holds only once the lock is ours', async () => {
    const { handlers, calls } = handler();
    await handlers.handleSetDataElementProperties({ name: 'ZAPP_TEST', label: 'Status' });
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('read'));
  });

  it('leaves a caller\'s own handle alone', async () => {
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleSetDomainProperties({
      name: 'ZAPP_TEST', description: 'Edited', lockHandle: 'THEIRS'
    }));

    expect(calls).toEqual(['read', 'write']);
    expect(result.lockHandleFrom).toBe('argument');
    expect(result.hint).toMatch(/lock is the one you hold/);
  });

  it('reuses a lock this process already holds, and does not release it', async () => {
    lockRegistry.remember(DOMAIN_URL, 'OUTER', undefined);
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleSetDomainProperties({
      name: 'ZAPP_TEST', description: 'Edited'
    }));

    expect(calls).toEqual(['read', 'write']);
    expect(result.lockHandleFrom).toBe('lockRegistry');
  });

  it('activates when asked, and only after the lock is off', async () => {
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleSetDomainProperties({
      name: 'ZAPP_TEST', description: 'Edited', activate: true
    }));

    expect(calls).toEqual(['lock', 'read', 'write', 'unlock', 'inactiveObjects', 'activate', 'inactiveObjects']);
    expect(calls.indexOf('unlock')).toBeLessThan(calls.indexOf('activate'));
    expect(result.activated).toBe(true);
    expect(result.status).toBe('success');
  });

  it('gives the lock back when the write is refused', async () => {
    const { handlers, calls } = handler({
      setDomainProperties: async () => { throw new Error('type not allowed'); }
    });
    await expect(handlers.handleSetDomainProperties({ name: 'ZAPP_TEST', datatype: 'NOPE' }))
      .rejects.toThrow(/type not allowed/);
    expect(calls).toContain('unlock');
  });

  it('does not activate on a lock that would not come off', async () => {
    const { handlers } = handler({
      unLock: async () => { throw new Error('lock is not yours'); }
    });
    const result = answer(await handlers.handleSetDataElementProperties({
      name: 'ZAPP_TEST', label: 'Status', activate: true
    }));

    expect(result.written).toBe(true);
    expect(result.activated).toBe(false);
    expect(result.hint).toMatch(/would not come off/);
  });
});

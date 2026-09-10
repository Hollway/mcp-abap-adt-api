import { TextElementHandlers } from '../handlers/TextElementHandlers';
import { ObjectManagementHandlers } from '../handlers/ObjectManagementHandlers';
import { lockRegistry } from '../lib/lockRegistry';

/**
 * Text elements were written blind for as long as no system here served the
 * endpoint. Two things that seemed obvious turned out to be wrong, and these
 * tests hold the measured behaviour in place:
 *
 *  - the lock goes on the text elements resource, not on the object. With the
 *    object's lock the write is refused with 423 "Resource REPT ZFOO is not
 *    locked", naming the text pool;
 *  - a text write leaves TWO rows inactive - the object (PROG/P) and its text
 *    pool (PROG/PX) - and one activation by name covers both.
 */
const PROGRAM = 'ZDEV_MCP_TXT';
const TEXT_URL = `/sap/bc/adt/textelements/programs/${PROGRAM.toLowerCase()}`;
const PROGRAM_URL = `/sap/bc/adt/programs/programs/${PROGRAM.toLowerCase()}`;

const inactiveRow = (type: string) => ({
  object: {
    'adtcore:uri': type === 'PROG/PX' ? TEXT_URL : PROGRAM_URL,
    'adtcore:type': type,
    'adtcore:name': PROGRAM,
    'adtcore:parentUri': '/sap/bc/adt/packages/%24tmp',
    user: 'TESTER',
    deleted: false
  }
});

const harness = (over: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const locked: string[] = [];
  const unlocked: string[] = [];
  const writes: any[] = [];
  let activations = 0;

  const client: any = {
    stateful: 'stateless',
    language: 'RU',
    lock: async (url: string) => { calls.push('lock'); locked.push(url); return { LOCK_HANDLE: 'HANDLE' }; },
    unLock: async (url: string) => { calls.push('unlock'); unlocked.push(url); },
    getTextElements: async () => { calls.push('read'); return { textElements: [] }; },
    setTextElements: async (url: string, category: string, elements: any[], lockHandle: string) => {
      calls.push('write');
      writes.push({ url, category, elements, lockHandle });
    },
    inactiveObjects: async () => {
      calls.push('inactiveObjects');
      return activations === 0 ? [inactiveRow('PROG/P'), inactiveRow('PROG/PX')] : [];
    },
    activate: async (objects: any) => {
      calls.push('activate');
      activations += 1;
      return { success: true, messages: [], inactive: [] };
    },
    ...over
  };
  if (!('statelessClone' in over)) client.statelessClone = client;
  return { handlers: new TextElementHandlers(client), calls, locked, unlocked, writes };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

const ARGS = {
  objectName: PROGRAM,
  objectType: 'PROG/P',
  category: 'symbols',
  elements: [{ id: '001', text: 'Probe symbol', maxLength: 30 }]
};

beforeEach(() => lockRegistry.clear());

describe('setTextElements', () => {
  it('locks the text elements resource, not the object', async () => {
    const { handlers, locked, unlocked, writes } = harness();
    const result = answer(await handlers.handleSetTextElements(ARGS));

    expect(locked).toEqual([TEXT_URL]);
    expect(unlocked).toEqual([TEXT_URL]);
    expect(writes[0].url).toBe(TEXT_URL);
    expect(writes[0].lockHandle).toBe('HANDLE');
    expect(result.lockHandleFrom).toBe('takenHere');
    expect(result.objectUrl).toBe(PROGRAM_URL);
  });

  it('takes the lock, writes and gives it back', async () => {
    const { handlers, calls } = harness();
    const result = answer(await handlers.handleSetTextElements(ARGS));

    expect(calls).toEqual(['lock', 'write', 'unlock']);
    expect(result.status).toBe('success');
    expect(result.written).toBe(true);
    expect(result.activated).toBe(false);
    expect(result.hint).toMatch(/lock is back off/);
  });

  it('leaves a handle the caller passed alone', async () => {
    const { handlers, calls } = harness();
    const result = answer(await handlers.handleSetTextElements({ ...ARGS, lockHandle: 'THEIRS' }));

    expect(calls).toEqual(['write']);
    expect(result.lockHandleFrom).toBe('argument');
    expect(result.hint).toMatch(/lock is the one you hold/);
  });

  it('reuses a lock this process holds on the text elements', async () => {
    lockRegistry.remember(TEXT_URL, 'OUTER', undefined);
    const { handlers, calls } = harness();
    const result = answer(await handlers.handleSetTextElements(ARGS));

    expect(calls).toEqual(['write']);
    expect(result.lockHandleFrom).toBe('lockRegistry');
  });

  // One pass has to cover the object and its text pool; activating the object
  // URL alone would leave the PROG/PX row behind.
  it('activates the object and its text pool in one pass, after the unlock', async () => {
    const { handlers, calls } = harness();
    const result = answer(await handlers.handleSetTextElements({ ...ARGS, activate: true }));

    expect(calls).toEqual(['lock', 'write', 'unlock', 'inactiveObjects', 'activate', 'inactiveObjects']);
    expect(calls.indexOf('unlock')).toBeLessThan(calls.indexOf('activate'));
    expect(result.activated).toBe(true);
    const activated = result.steps.find((s: any) => s.step === 'activate');
    expect(activated.activated.map((o: any) => o.type).sort()).toEqual(['PROG/P', 'PROG/PX']);
  });

  it('gives the lock back when the write is refused', async () => {
    const { handlers, unlocked } = harness({
      setTextElements: async () => { throw new Error('Resource REPT ZDEV_MCP_TXT is not locked'); }
    });
    await expect(handlers.handleSetTextElements(ARGS)).rejects.toThrow(/is not locked/);
    expect(unlocked).toEqual([TEXT_URL]);
  });

  it('does not activate when the lock would not come off', async () => {
    const { handlers } = harness({
      unLock: async () => { throw new Error('lock is not yours'); }
    });
    const result = answer(await handlers.handleSetTextElements({ ...ARGS, activate: true }));

    expect(result.written).toBe(true);
    expect(result.activated).toBe(false);
    expect(result.hint).toMatch(/would not come off/);
  });

  it('refuses a category it does not know', async () => {
    const { handlers } = harness();
    await expect(handlers.handleSetTextElements({ ...ARGS, category: 'captions' }))
      .rejects.toThrow(/Unknown category/);
  });
});

describe('inactiveObjects', () => {
  // Measured live: after a text write and its activation, the writing session
  // reports nothing inactive while a stateless clone kept reporting the
  // program - three consecutive reads apart, with the object provably active.
  it('is read in the session that does the writing, not through the clone', async () => {
    const asked: string[] = [];
    const client: any = {
      stateful: 'stateful',
      inactiveObjects: async () => { asked.push('stateful'); return []; },
      statelessClone: {
        inactiveObjects: async () => { asked.push('clone'); return [inactiveRow('PROG/P')]; }
      }
    };
    const handlers = new ObjectManagementHandlers(client);
    const result = JSON.parse((await handlers.handleInactiveObjects({})).content[0].text);

    expect(asked).toEqual(['stateful']);
    expect(result).toEqual([]);
  });
});

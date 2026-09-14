import { TextElementHandlers } from '../handlers/TextElementHandlers';
import { ObjectManagementHandlers } from '../handlers/ObjectManagementHandlers';
import { lockRegistry } from '../lib/lockRegistry';
import { AdtErrorException } from 'abap-adt-api';

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

/**
 * The fallback for the releases that serve no text elements at all.
 *
 * The 404 does not arrive where it would be convenient: on a write it lands on
 * the lock of the text elements resource, before anything is written, so the
 * decision to go the ABAP way is taken around the whole ADT attempt rather than
 * inside it. Running the ABAP itself belongs to SnippetHandlers and is stubbed
 * out here - what these tests hold is the decision, the parsing and the answer.
 */
describe('the text pool fallback', () => {
  const notServed = () => new AdtErrorException(404, {}, 'ExceptionResourceNotFound', 'Resource not found');

  const fallbackHarness = (
    output: string,
    over: Record<string, unknown> = {},
    transport: { registered?: boolean; hint?: string; openRequests?: Record<string, string>[]; local?: boolean } = {}
  ) => {
    const ran: string[][] = [];
    const registrations: any[] = [];
    const { handlers, calls } = harness({
      getTextElements: async () => { throw notServed(); },
      lock: async () => { throw notServed(); },
      ...over
    });
    (handlers as any).snippets = {
      handleRunSnippet: async ({ code }: { code: string[] }) => {
        ran.push(code);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', ran: true, output }) }] };
      }
    };
    // The transport side is a handler of its own, with a function module and
    // two queries behind it; what belongs here is what this handler does with
    // its answer.
    (handlers as any).transports = {
      handleRegisterInTransport: async (args: any) => {
        registrations.push(args);
        const registered = transport.registered !== false;
        return {
          content: [{
            type: 'text', text: JSON.stringify({
              status: registered ? 'success' : 'error',
              registered,
              task: 'EUDK900124',
              hint: transport.hint || (registered ? 'in the task.' : 'The object is locked in another request.')
            })
          }]
        };
      },
      registrationState: async () => ({
        row: {},
        local: transport.local === true,
        devclass: transport.local === true ? '$TMP' : 'ZMM',
        openRequests: transport.openRequests || []
      })
    };
    return { handlers, ran, calls, registrations };
  };

  const READ_PRINT = [
    'READ~#~0~#~2',
    'ROW~#~I~#~001~#~30~#~[Probe symbol]',
    'ROW~#~S~#~P_WERKS~#~13~#~[        Plant]'
  ].join('\n');

  it('reads the pool with ABAP when the endpoint is not there', async () => {
    const { handlers, ran } = fallbackHarness(READ_PRINT);
    const result = answer(await handlers.handleGetTextElements({ objectName: PROGRAM, category: 'symbols' }));

    expect(result.via).toBe('textpool');
    expect(result.program).toBe(PROGRAM);
    expect(result.textElements).toEqual([{ id: '001', text: 'Probe symbol', maxLength: 30 }]);
    expect(ran[0]).toEqual(expect.arrayContaining([`READ TEXTPOOL '${PROGRAM}' INTO lt_pool LANGUAGE lv_langu.`]));
  });

  it('says which way a read went when the endpoint is there', async () => {
    const { handlers } = harness();
    const result = answer(await handlers.handleGetTextElements({ objectName: PROGRAM, category: 'symbols' }));
    expect(result.via).toBe('adt');
  });

  it('writes the pool without a lock and without an activation', async () => {
    const { handlers, ran, calls } = fallbackHarness('READ~#~0~#~0\nINSERT~#~0~#~1\nROW~#~I~#~001~#~30~#~[Probe symbol]');
    const result = answer(await handlers.handleSetTextElements(ARGS));

    expect(calls).toEqual([]);
    expect(result.status).toBe('success');
    expect(result.via).toBe('textpool');
    expect(result.written).toBe(true);
    expect(result.activated).toBe(true);
    expect(ran[0]).toEqual(expect.arrayContaining([
      `INSERT TEXTPOOL '${PROGRAM}' FROM lt_pool LANGUAGE lv_langu STATE 'A'.`
    ]));
    expect(result.hint).toMatch(/nothing to activate/);
  });

  it('reports a write the pool refused instead of calling it done', async () => {
    const { handlers } = fallbackHarness('READ~#~0~#~0\nINSERT~#~4~#~1');
    const result = answer(await handlers.handleSetTextElements(ARGS));

    expect(result.status).toBe('error');
    expect(result.written).toBe(false);
    expect(result.insertSubrc).toBe(4);
  });

  // INSERT TEXTPOOL registers nothing of its own, so the write has to put the
  // object into the request itself or the texts never leave this system.
  it('registers the object in the request it was given', async () => {
    const { handlers, registrations } = fallbackHarness('READ~#~0~#~0\nINSERT~#~0~#~1');
    const result = answer(await handlers.handleSetTextElements({ ...ARGS, transport: 'EUDK900123' }));

    expect(registrations).toEqual([{
      pgmid: 'R3TR', object: 'PROG', objName: PROGRAM, transport: 'EUDK900123'
    }]);
    expect(result.status).toBe('success');
    expect(result.registered).toBe(true);
    expect(result.steps.some((step: any) => step.step === 'registerInTransport')).toBe(true);
  });

  // The texts are on the system by then and nothing takes them back, so a
  // refused registration is an error to report, not one to hide.
  it('reports a refused registration without pretending the texts are unwritten', async () => {
    const { handlers } = fallbackHarness(
      'READ~#~0~#~0\nINSERT~#~0~#~1', {}, { registered: false, hint: 'The object is locked in EUDK900999.' }
    );
    const result = answer(await handlers.handleSetTextElements({ ...ARGS, transport: 'EUDK900123' }));

    expect(result.written).toBe(true);
    expect(result.registered).toBe(false);
    expect(result.status).toBe('error');
    expect(result.notes.join(' ')).toMatch(/did not get into EUDK900123/);
  });

  // Measured in a live task: the request held the includes of a program and not
  // the program itself, and the text pool of the main program would have stayed
  // behind without a word.
  it('warns when the object is in no open request at all', async () => {
    const { handlers } = fallbackHarness('READ~#~0~#~0\nINSERT~#~0~#~1', {}, { openRequests: [] });
    const result = answer(await handlers.handleSetTextElements(ARGS));

    expect(result.status).toBe('success');
    expect(result.notes.join(' ')).toMatch(/in no open request/);
    expect(result.notes.join(' ')).toMatch(/includes of a program do not carry its text pool/);
  });

  it('says nothing about transports for a local object', async () => {
    const { handlers } = fallbackHarness('READ~#~0~#~0\nINSERT~#~0~#~1', {}, { local: true });
    const result = answer(await handlers.handleSetTextElements(ARGS));

    expect(result.status).toBe('success');
    expect(result.notes).toBeUndefined();
  });

  it('leaves the rest of the category alone with merge', async () => {
    const { handlers, ran } = fallbackHarness('READ~#~0~#~0\nINSERT~#~0~#~1');
    const result = answer(await handlers.handleSetTextElements({ ...ARGS, merge: true }));

    expect(result.merge).toBe(true);
    expect(ran[0].some(line => line === "DELETE lt_pool WHERE id = 'I'.")).toBe(false);
  });

  // Measured live: a title-only call reported merge:false and "the whole set of
  // symbols was replaced", when it had replaced nothing at all. What the answer
  // says has to be what happened.
  it('says what a title-only write actually did', async () => {
    const { handlers, ran } = fallbackHarness(['READ~#~0~#~0', 'INSERT~#~0~#~1'].join('\n'));
    const result = answer(await handlers.handleSetTextElements({
      objectName: PROGRAM, objectType: 'PROG/P', title: 'A report'
    }));

    expect(result.written).toBe(true);
    expect(result.merge).toBe(true);
    expect(result.hint).toMatch(/nothing else in the pool was touched/);
    // No category may be emptied by a call that named no elements.
    expect(ran[0].some(line => line === "DELETE lt_pool WHERE id = 'I'.")).toBe(false);
    expect(ran[0]).toEqual(expect.arrayContaining(['ls_new-entry = `A report`.']));
  });

  it('refuses a write that names neither elements nor a title', async () => {
    const { handlers } = fallbackHarness('');
    await expect(handlers.handleSetTextElements({ objectName: PROGRAM }))
      .rejects.toThrow(/nothing to write/);
  });

  it('does not fall back on a failure that is not the missing endpoint', async () => {
    const { handlers } = fallbackHarness('', {
      getTextElements: async () => { throw new Error('Program ZDEV_MCP_TXT does not exist'); }
    });
    await expect(handlers.handleGetTextElements({ objectName: PROGRAM })).rejects.toThrow(/does not exist/);
  });

  // Reading the pool means creating, activating, running and deleting a class:
  // four changes to answer a question, which a read-only server must refuse -
  // while the ADT read, which changes nothing, keeps working.
  it('refuses to run ABAP on a read-only server, explaining why', async () => {
    process.env.SAP_READONLY = 'true';
    try {
      const { handlers } = fallbackHarness(READ_PRINT);
      await expect(handlers.handleGetTextElements({ objectName: PROGRAM })).rejects.toThrow(/SAP_READONLY/);

      const served = harness();
      const result = answer(await served.handlers.handleGetTextElements({ objectName: PROGRAM }));
      expect(result.via).toBe('adt');
    } finally {
      delete process.env.SAP_READONLY;
    }
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

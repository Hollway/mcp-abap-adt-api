import { ObjectSourceHandlers } from '../handlers/ObjectSourceHandlers';
import { lockRegistry } from '../lib/lockRegistry';

/**
 * editObject is the four-call sequence an ABAP change needs, run once. What
 * these tests hold in place is the order - the lock has to be gone before the
 * activation, or ADT refuses with "user is already processing" - and the
 * promise that nothing is rolled back, so a failure leaves a source written to
 * the inactive version and says so.
 */
const SOURCE_URL = '/sap/bc/adt/oo/classes/zcl_test/source/main';
const OBJECT_URL = '/sap/bc/adt/oo/classes/zcl_test';
const SOURCE = ['CLASS zcl_test IMPLEMENTATION.', '  METHOD run.', '  ENDMETHOD.', 'ENDCLASS.'].join('\n');

const inactiveRow = () => ({
  object: {
    'adtcore:uri': OBJECT_URL,
    'adtcore:type': 'CLAS/OC',
    'adtcore:name': 'ZCL_TEST',
    'adtcore:parentUri': '/sap/bc/adt/packages/ztest',
    user: 'TESTER',
    deleted: false
  }
});

const handler = (over: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  let written: string | undefined;
  let activations = 0;
  const client = {
    stateful: 'stateless',
    getObjectSource: async () => SOURCE,
    lock: async () => { calls.push('lock'); return { LOCK_HANDLE: 'HANDLE' }; },
    setObjectSource: async (_url: string, source: string) => { calls.push('write'); written = source; },
    unLock: async () => { calls.push('unlock'); },
    inactiveObjects: async () => {
      calls.push('inactiveObjects');
      // inactive before the activation, clean afterwards
      return activations === 0 ? [inactiveRow()] : [];
    },
    activate: async () => {
      calls.push('activate');
      activations += 1;
      return { success: true, messages: [], inactive: [] };
    },
    ...over
  };
  return {
    handlers: new ObjectSourceHandlers(client as any),
    calls,
    source: () => written
  };
};

const answer = (result: any) => JSON.parse(result.content[0].text);
const edits = [{ anchor: '  ENDMETHOD.', replacement: '    WRITE 1.\n  ENDMETHOD.' }];

beforeEach(() => lockRegistry.clear());

describe('editObject', () => {
  it('locks, writes, unlocks and only then activates', async () => {
    const { handlers, calls, source } = handler();
    const result = answer(await handlers.handleEditObject({ objectSourceUrl: SOURCE_URL, edits }));

    expect(calls).toEqual(['lock', 'write', 'unlock', 'inactiveObjects', 'activate', 'inactiveObjects']);
    expect(result).toMatchObject({ status: 'success', activated: true, objectUrl: OBJECT_URL });
    expect(source()).toContain('WRITE 1.');
    expect(lockRegistry.count()).toBe(0);
  });

  it('reports every step it took', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleEditObject({ objectSourceUrl: SOURCE_URL, edits }));
    expect(result.steps.map((s: any) => s.step)).toEqual(['lock', 'patch', 'unlock', 'activate']);
    expect(result.steps[1]).toMatchObject({ written: true, linesBefore: 4, linesAfter: 5 });
    expect(result.steps[1].diff).toContain('+    WRITE 1.');
  });

  it('reuses a lock this process already holds and still releases it', async () => {
    lockRegistry.remember(OBJECT_URL, 'EARLIER');
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleEditObject({ objectSourceUrl: SOURCE_URL, edits }));
    expect(calls).not.toContain('lock');
    expect(result.steps[0]).toMatchObject({ step: 'lock', lockHandle: 'EARLIER', taken: false });
    expect(lockRegistry.count()).toBe(0);
  });

  it('stops at the write and releases the lock it took', async () => {
    const { handlers, calls } = handler({
      setObjectSource: async () => { throw new Error('object is in another transport'); }
    });
    await expect(handlers.handleEditObject({ objectSourceUrl: SOURCE_URL, edits }))
      .rejects.toThrow(/another transport/);
    expect(calls).toEqual(['lock', 'unlock']);
    expect(lockRegistry.count()).toBe(0);
  });

  it('does not activate when the lock could not be released', async () => {
    const { handlers, calls } = handler({
      unLock: async () => { throw new Error('lock handle is void'); }
    });
    const result = answer(await handlers.handleEditObject({ objectSourceUrl: SOURCE_URL, edits }));
    expect(calls).not.toContain('activate');
    expect(result).toMatchObject({ status: 'error', activated: false });
    expect(result.hint).toMatch(/unlockAll/);
  });

  it('keeps the written source when the activation fails, and says so', async () => {
    const { handlers, source } = handler({
      activate: async () => ({
        success: false,
        messages: [{ shortText: 'Field FOO is unknown', type: 'E' }],
        inactive: []
      })
    });
    const result = answer(await handlers.handleEditObject({ objectSourceUrl: SOURCE_URL, edits }));
    expect(result).toMatchObject({ status: 'error', activated: false });
    expect(result.hint).toMatch(/nothing was rolled back/i);
    // no rollback: the new source stays in the inactive version
    expect(source()).toContain('WRITE 1.');
  });

  it('stops after the unlock when activate is false', async () => {
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleEditObject({
      objectSourceUrl: SOURCE_URL,
      edits,
      activate: false
    }));
    expect(calls).toEqual(['lock', 'write', 'unlock']);
    expect(result).toMatchObject({ status: 'success', activated: false });
  });

  it('takes no lock at all on a dry run', async () => {
    const { handlers, calls, source } = handler();
    const result = answer(await handlers.handleEditObject({
      objectSourceUrl: SOURCE_URL,
      edits,
      dryRun: true
    }));
    expect(calls).toEqual([]);
    expect(source()).toBeUndefined();
    expect(result).toMatchObject({ status: 'success', dryRun: true });
    expect(result.patch.diff).toContain('+    WRITE 1.');
  });
});

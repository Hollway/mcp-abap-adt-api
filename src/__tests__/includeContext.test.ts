import { AdtErrorException } from 'abap-adt-api';
import {
  activateWithContexts,
  addIncludeContexts,
  chooseMainProgram,
  mainProgramUri,
  needsContext,
  refusedInclude,
  withContext
} from '../lib/includeContext';
import { activateAndVerify } from '../lib/activation';

/**
 * A report include is activated with ?context=<main program> or not at all:
 * the backend answers "Select a master program for include X in the properties
 * view" for every include that has a main program and is sent without one.
 * Measured on the ERP system 2026-10-19 on a $TMP include with exactly one main
 * program: the bare URI refused, the same call with the context activated.
 */
const INCLUDE = '/sap/bc/adt/programs/includes/zr_app_f01';
const MAIN = '/sap/bc/adt/programs/programs/zr_app';
const OTHER = '/sap/bc/adt/programs/programs/zr_app_copy';
const entry = (uri = INCLUDE, name = 'ZR_APP_F01', type = 'PROG/I') =>
  ({ 'adtcore:uri': uri, 'adtcore:type': type, 'adtcore:name': name, 'adtcore:parentUri': '/sap/bc/adt/packages/zapp' });
const selectMaster = (name = 'ZR_APP_F01') =>
  new AdtErrorException(500, {}, 'invalidMainProgram', `Select a master program for include ${name} in the properties view`);
const invalidMaster = (name = 'ZR_APP_F01') =>
  new AdtErrorException(500, {}, 'invalidMainProgram', `Master program ZR_APP is invalid for include ${name}`);
const mainsClient = (byInclude: Record<string, string[]>) => ({
  mainPrograms: async (url: string) => (byInclude[url] || []).map(uri => ({
    'adtcore:uri': uri,
    'adtcore:type': 'PROG/P',
    'adtcore:name': uri.split('/').pop()!.toUpperCase()
  }))
});

describe('which main program', () => {
  it('takes the only one, the one in the same call, or the one named - and asks when it cannot tell', () => {
    const one = [{ uri: MAIN, name: 'ZR_APP' }];
    const two = [...one, { uri: OTHER, name: 'ZR_APP_COPY' }];
    expect(chooseMainProgram('ZR_APP_F01', one, new Set())).toEqual({ include: 'ZR_APP_F01', mainProgram: MAIN, from: 'only' });
    expect(chooseMainProgram('ZR_APP_F01', [], new Set())).toEqual({ include: 'ZR_APP_F01', from: 'none' });
    expect(chooseMainProgram('ZR_APP_F01', two, new Set([OTHER]))).toMatchObject({ mainProgram: OTHER, from: 'inThisActivation' });
    expect(chooseMainProgram('ZR_APP_F01', two, new Set(), 'zr_app')).toMatchObject({ mainProgram: MAIN, from: 'argument' });
    expect(chooseMainProgram('ZR_APP_F01', two, new Set())).toEqual({ refusal: expect.stringMatching(/2 main programs \(ZR_APP, ZR_APP_COPY\).*Pass mainProgram/) });
    expect(chooseMainProgram('ZR_APP_F01', one, new Set(), 'ZR_ELSE')).toEqual({ refusal: expect.stringMatching(/ZR_ELSE is not a main program/) });
  });

  it('reads a program as a name or a URI, and adds the context the way Eclipse sends it', () => {
    expect(mainProgramUri('ZR_APP')).toBe(MAIN);
    expect(mainProgramUri(`${MAIN}/source/main`)).toBe(MAIN);
    expect(withContext(INCLUDE, MAIN)).toBe(`${INCLUDE}?context=%2Fsap%2Fbc%2Fadt%2Fprograms%2Fprograms%2Fzr_app`);
    expect(needsContext(entry())).toBe(true);
    expect(needsContext(entry(withContext(INCLUDE, MAIN)))).toBe(false);
    expect(needsContext(entry('/sap/bc/adt/oo/classes/zcl_app', 'ZCL_APP', 'CLAS/OC'))).toBe(false);
  });

  it('knows both refusals and nothing else', () => {
    expect(refusedInclude(selectMaster())).toEqual({ include: 'ZR_APP_F01', wantsContext: true });
    expect(refusedInclude(invalidMaster())).toEqual({ include: 'ZR_APP_F01', wantsContext: false });
    expect(refusedInclude(new AdtErrorException(500, {}, 'X', 'Something else'))).toBeUndefined();
  });
});

describe('addIncludeContexts', () => {
  it('adds a context where one is needed and leaves the rest alone', async () => {
    const given = withContext('/sap/bc/adt/programs/includes/zr_app_f02', OTHER);
    const { entries, contexts } = await addIncludeContexts(
      mainsClient({ [INCLUDE]: [MAIN] }),
      [entry(), entry(given, 'ZR_APP_F02'), entry(MAIN, 'ZR_APP', 'PROG/P'), entry('/sap/bc/adt/programs/includes/zr_new', 'ZR_NEW')]
    );
    expect(entries.map(e => e['adtcore:uri'])).toEqual([withContext(INCLUDE, MAIN), given, MAIN, '/sap/bc/adt/programs/includes/zr_new']);
    expect(contexts).toEqual([
      { include: 'ZR_APP_F01', mainProgram: MAIN, from: 'only' },
      { include: 'ZR_NEW', from: 'none' }
    ]);
  });

  it('takes the main program activated in the same call, and refuses before activating when it cannot tell', async () => {
    const client = mainsClient({ [INCLUDE]: [MAIN, OTHER] });
    const inCall = await addIncludeContexts(client, [entry(), entry(OTHER, 'ZR_APP_COPY', 'PROG/P')]);
    expect(inCall.entries[0]['adtcore:uri']).toBe(withContext(INCLUDE, OTHER));
    await expect(addIncludeContexts(client, [entry()])).rejects.toThrow(/2 main programs.*Nothing was activated/);
  });
});

describe('activateWithContexts', () => {
  it('sends the include with its context', async () => {
    const sent: string[][] = [];
    const { contexts } = await activateWithContexts(mainsClient({ [INCLUDE]: [MAIN] }), [entry()], async entries => {
      sent.push(entries.map(e => e['adtcore:uri']));
      return 'ok';
    });
    expect(sent).toEqual([[withContext(INCLUDE, MAIN)]]);
    expect(contexts[0].from).toBe('only');
  });

  it('takes the context off and tries once more when the backend calls the main program invalid', async () => {
    const sent: string[][] = [];
    const { result, contexts } = await activateWithContexts(mainsClient({ [INCLUDE]: [MAIN] }), [entry()], async entries => {
      sent.push(entries.map(e => e['adtcore:uri']));
      if (sent.length === 1) throw invalidMaster();
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(sent).toEqual([[withContext(INCLUDE, MAIN)], [INCLUDE]]);
    expect(contexts).toEqual([{ include: 'ZR_APP_F01', from: 'retry' }]);
  });

  it('puts the context on and tries once more when the backend asks for one after all', async () => {
    let lookups = 0;
    const client = { mainPrograms: async () => (lookups++ === 0 ? [] : [{ 'adtcore:uri': MAIN, 'adtcore:type': 'PROG/P', 'adtcore:name': 'ZR_APP' }]) };
    const sent: string[][] = [];
    await activateWithContexts(client, [entry()], async entries => {
      sent.push(entries.map(e => e['adtcore:uri']));
      if (sent.length === 1) throw selectMaster();
      return 'ok';
    });
    expect(sent).toEqual([[INCLUDE], [withContext(INCLUDE, MAIN)]]);
  });

  it('tries once, not twice, and passes every other failure on', async () => {
    let calls = 0;
    await expect(activateWithContexts(mainsClient({ [INCLUDE]: [MAIN] }), [entry()], async () => {
      calls += 1;
      throw invalidMaster();
    })).rejects.toThrow(/invalid/);
    expect(calls).toBe(2);
    const other = new AdtErrorException(500, {}, 'X', 'Something else');
    await expect(activateWithContexts(mainsClient({}), [entry()], async () => { throw other; })).rejects.toBe(other);
  });
});

describe('activateAndVerify', () => {
  it('activates a report include from the inactive list with its main program', async () => {
    const sent: any[] = [];
    let active = false;
    const client = {
      ...mainsClient({ [INCLUDE]: [MAIN] }),
      inactiveObjects: async () => (active ? [] : [{ object: { ...entry(), 'adtcore:parentUri': '', user: 'DEV', deleted: false } }]),
      findObjectPath: async () => [{ 'adtcore:uri': INCLUDE, 'adtcore:type': 'PROG/I', 'adtcore:parentUri': '/sap/bc/adt/packages/zapp' }],
      activate: async (entries: any[]) => {
        sent.push(...entries);
        if (!String(entries[0]['adtcore:uri']).includes('?context=')) throw selectMaster();
        active = true;
        return { success: true, messages: [], inactive: [] };
      }
    };
    const outcome = await activateAndVerify(client as any, { objectName: 'ZR_APP_F01' });
    expect(outcome.success).toBe(true);
    expect(sent[0]['adtcore:uri']).toBe(withContext(INCLUDE, MAIN));
    expect(outcome.includeContexts).toEqual([{ include: 'ZR_APP_F01', mainProgram: MAIN, from: 'only' }]);
  });
});

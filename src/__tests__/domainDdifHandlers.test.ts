import { AdtErrorException } from 'abap-adt-api';
import { DdicPropertyHandlers } from '../handlers/DdicPropertyHandlers';
import { lockRegistry } from '../lib/lockRegistry';

/**
 * getDomainProperties and setDomainProperties on a release that answers 404
 * for every domain: the read comes from the tables, the change is previewed
 * first and written only with the preview's token, and the answer is what the
 * tables hold afterwards - not what the snippet said.
 */
const notServed = () => new AdtErrorException(404, {}, 'ExceptionResourceNotFound', 'Resource /sap/bc/adt/ddic/domains/ztest_prio does not exist.');

const system = (options: { inactive?: boolean; afterWrite?: (state: any) => void } = {}) => {
  const state = {
    versions: options.inactive ? ['A', 'N'] : ['A'],
    values: [{ VALPOS: 1, DOMVALUE_L: '1' }, { VALPOS: 2, DOMVALUE_L: '2' }],
    valueTexts: [
      { VALPOS: 1, DDLANGUAGE: 'R', DDTEXT: 'Высокий' },
      { VALPOS: 1, DDLANGUAGE: 'E', DDTEXT: 'Highest' },
      { VALPOS: 2, DDLANGUAGE: 'R', DDTEXT: 'Средний' }
    ],
    recorded: [] as string[]
  };
  const queries: string[] = [];
  const answer = (sql: string): any[] => {
    if (/FROM dd01l/.test(sql)) {
      return state.versions.map(version => ({
        AS4LOCAL: version, DATATYPE: 'CHAR', LENG: 1, OUTPUTLEN: 1, VALEXI: 'X', AS4DATE: '2026-09-28T00:00:00.000Z', AS4TIME: '170757'
      }));
    }
    if (/FROM dd01t/.test(sql)) return [{ DDLANGUAGE: 'R', DDTEXT: 'Уровень' }];
    if (/FROM dd07l/.test(sql)) return state.values;
    if (/FROM dd07t/.test(sql)) return state.valueTexts;
    if (/FROM tadir/.test(sql)) return [{ DEVCLASS: 'ZPKG', AUTHOR: 'DEV', MASTERLANG: 'R', SRCSYSTEM: 'DEV' }];
    if (/FROM t002/.test(sql)) return [{ SPRAS: 'E' }];
    if (/FROM e070 WHERE trkorr/.test(sql)) return [{ TRKORR: 'DEVK900100', STRKORR: '', TRSTATUS: 'D', TRFUNCTION: 'K' }];
    if (/FROM e070 WHERE strkorr/.test(sql)) return [{ TRKORR: 'DEVK900101' }];
    if (/FROM e071/.test(sql)) return state.recorded.map(trkorr => ({ TRKORR: trkorr }));
    return [];
  };
  const client = {
    stateful: 'stateless',
    language: 'RU',
    lock: async () => { throw notServed(); },
    getDomainProperties: async () => { throw notServed(); },
    runQuery: async (sql: string) => { queries.push(sql); return { values: answer(sql) }; }
  };
  const handlers = new DdicPropertyHandlers(client as any);
  const snippets: string[][] = [];
  (handlers as any).runDdif = async (code: string[]) => {
    snippets.push(code);
    state.values = [...state.values, { VALPOS: 3, DOMVALUE_L: '3' }];
    state.valueTexts = [...state.valueTexts, { VALPOS: 3, DDLANGUAGE: 'R', DDTEXT: 'Низкий' }];
    state.recorded = ['DEVK900101'];
    options.afterWrite?.(state);
    return {
      ran: true,
      output: '',
      print: {
        steps: ['transport', 'get', 'compare', 'put', 'activate'].map(name => ({ step: name, subrc: 0, rc: 0, ok: true })),
        info: { task: 'DEVK900101', request: 'DEVK900100' }
      }
    };
  };
  return { handlers, queries, snippets, state };
};

const answer = (result: any) => JSON.parse(result.content[0].text);
const ADD_THREE = {
  name: 'ZTEST_PRIO',
  fixValues: [{ low: '1' }, { low: '2' }, { low: '3', text: 'Низкий' }],
  transport: 'DEVK900100'
};

beforeEach(() => lockRegistry.clear());

describe('getDomainProperties without a domain endpoint', () => {
  it('reads the definition from the tables, in the master language', async () => {
    const { handlers } = system();
    const result = answer(await handlers.handle('getDomainProperties', { name: 'ZTEST_PRIO' }));
    expect(result.status).toBe('success');
    expect(result.via).toBe('tables');
    expect(result.metaData).toMatchObject({ name: 'ZTEST_PRIO', description: 'Уровень', language: 'R', packageName: 'ZPKG' });
    expect(result.properties.valueInformation.fixValues).toEqual([
      { low: '1', text: 'Высокий' },
      { low: '2', text: 'Средний' }
    ]);
    expect(result.textLanguages).toEqual(['E', 'R']);
  });

  it('takes an ISO code for the language', async () => {
    const { handlers, queries } = system();
    const result = answer(await handlers.handle('getDomainProperties', { name: 'ZTEST_PRIO', language: 'EN' }));
    expect(queries.some(sql => /laiso = 'EN'/.test(sql))).toBe(true);
    expect(result.properties.valueInformation.fixValues[0].text).toBe('Highest');
  });
});

describe('setDomainProperties without a domain endpoint', () => {
  it('previews first and writes nothing', async () => {
    const { handlers, snippets } = system();
    const result = answer(await handlers.handle('setDomainProperties', ADD_THREE));
    expect(result).toMatchObject({ status: 'success', preview: true, written: false, via: 'ddif', added: ['3'], removed: [] });
    expect(result.fixValues.planned[2]).toEqual({ position: 3, low: '3', text: 'Низкий', added: true });
    expect(result.otherTextLanguages).toEqual(['E']);
    expect(result.notes[0]).toMatch(/texts in E/);
    expect(result.previewToken).toMatch(/^[0-9a-f]{16}$/);
    expect(snippets).toHaveLength(0);
  });

  it('writes with the token and answers from the tables afterwards', async () => {
    const { handlers, snippets } = system();
    const { previewToken } = answer(await handlers.handle('setDomainProperties', ADD_THREE));
    const result = answer(await handlers.handle('setDomainProperties', { ...ADD_THREE, previewToken }));
    expect(snippets).toHaveLength(1);
    expect(result).toMatchObject({ status: 'success', written: true, request: 'DEVK900100', task: 'DEVK900101' });
    expect(result.requestEntry).toEqual({ recorded: true, in: ['DEVK900101'] });
    expect(result.fixValuesAfter).toHaveLength(3);
    expect(result.hint).toMatch(/Changed and active/);
  });

  it('refuses a token from another change, and a domain somebody is editing', async () => {
    const { handlers, snippets } = system();
    const stale = answer(await handlers.handle('setDomainProperties', { ...ADD_THREE, previewToken: '0123456789abcdef' }));
    expect(stale).toMatchObject({ status: 'error', written: false });
    expect(stale.hint).toMatch(/does not match/);
    const editing = answer(await system({ inactive: true }).handlers.handle('setDomainProperties', ADD_THREE));
    expect(editing.hint).toMatch(/inactive version/);
    expect(snippets).toHaveLength(0);
  });

  it('matches the values by value, not by position: DDIF_DOMA_PUT numbers them 1..n again', async () => {
    const { handlers } = system({
      afterWrite: state => {
        // Measured: removing value 1 of 1-2 and adding 3 leaves 2 and 3 at
        // positions 1 and 2, the translations moved along.
        state.values = [{ VALPOS: 1, DOMVALUE_L: '2' }, { VALPOS: 2, DOMVALUE_L: '3' }];
        state.valueTexts = [
          { VALPOS: 1, DDLANGUAGE: 'R', DDTEXT: 'Средний' },
          { VALPOS: 2, DDLANGUAGE: 'R', DDTEXT: 'Низкий' }
        ];
      }
    });
    const args = { ...ADD_THREE, fixValues: [{ low: '2' }, { low: '3', text: 'Низкий' }] };
    const preview = answer(await handlers.handle('setDomainProperties', args));
    expect(preview.fixValues.planned.map((value: any) => [value.position, value.low])).toEqual([[1, '2'], [2, '3']]);
    expect(preview.removed).toEqual(['1']);
    const result = answer(await handlers.handle('setDomainProperties', { ...args, previewToken: preview.previewToken }));
    expect(result.status).toBe('success');
    expect(result.fixValuesAfter.map((value: any) => [value.position, value.low])).toEqual([[1, '2'], [2, '3']]);
  });

  it('reads every changed header field back - the activation corrects what it does not take and says rc 4', async () => {
    const { handlers } = system();
    const args = { name: 'ZTEST_PRIO', length: 2, transport: 'DEVK900100' };
    const { previewToken } = answer(await handlers.handle('setDomainProperties', args));
    const result = answer(await handlers.handle('setDomainProperties', { ...args, previewToken }));
    expect(result.status).toBe('error');
    expect(result.hint).toMatch(/leng is '1', not '2'; outputlen is '1', not '2'/);
  });

  it('reports a translation the write lost', async () => {
    const { handlers } = system({
      afterWrite: state => { state.valueTexts = state.valueTexts.filter((row: any) => row.DDLANGUAGE !== 'E'); }
    });
    const { previewToken } = answer(await handlers.handle('setDomainProperties', ADD_THREE));
    const result = answer(await handlers.handle('setDomainProperties', { ...ADD_THREE, previewToken }));
    expect(result.status).toBe('error');
    expect(result.hint).toMatch(/texts lost in other languages: 1 \(E\)/);
  });

  it('says when there is nothing to change, and refuses the ADT escape hatch', async () => {
    const { handlers } = system();
    const same = answer(await handlers.handle('setDomainProperties', { name: 'ZTEST_PRIO', fixValues: [{ low: '1' }, { low: '2' }] }));
    expect(same).toMatchObject({ status: 'success', written: false });
    await expect(handlers.handle('setDomainProperties', { name: 'ZTEST_PRIO', properties: {}, metaData: {} }))
      .rejects.toThrow(/ADT documents/);
  });
});

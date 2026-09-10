import { SourceSearchHandlers } from '../handlers/SourceSearchHandlers';

/**
 * The handler side of findInSource / sourceOutline: which sources get read,
 * and what happens when one of them cannot be.
 */
const MAIN_URL = '/sap/bc/adt/programs/programs/zr_app_foo/source/main';

const MAIN = [
  'REPORT zr_app_foo.',
  'INCLUDE zr_app_foo_f01.',
  'INCLUDE zr_app_foo_gone.',
  'START-OF-SELECTION.',
  '  PERFORM read_data.'
].join('\n');

const F01 = [
  'FORM read_data.',
  '  SELECT * FROM ekpo INTO TABLE @DATA(lt_ekpo).',
  'ENDFORM.'
].join('\n');

const handler = () => {
  const read: { url: string; options: any }[] = [];
  const client = {
    statelessClone: undefined as any,
    getObjectSource: async (url: string, options: any) => {
      read.push({ url, options });
      if (url === MAIN_URL) return MAIN;
      if (url.includes('zr_app_foo_f01')) return F01;
      throw new Error('Object does not exist');
    }
  };
  return { handlers: new SourceSearchHandlers(client as any), read };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

describe('findInSource', () => {
  it('searches only the object itself by default', async () => {
    const { handlers, read } = handler();
    const result = answer(await handlers.handleFindInSource({
      objectSourceUrl: MAIN_URL,
      pattern: 'perform'
    }));
    expect(read).toHaveLength(1);
    expect(result).toMatchObject({ status: 'success', totalMatches: 1 });
    expect(result.results[0].matches[0]).toMatchObject({ line: 5 });
  });

  it('follows the INCLUDE statements when asked and says where the match was', async () => {
    const { handlers, read } = handler();
    const result = answer(await handlers.handleFindInSource({
      objectSourceUrl: MAIN_URL,
      pattern: 'FORM read_data',
      searchIncludes: true
    }));
    expect(read.map(r => r.url)).toEqual([
      MAIN_URL,
      '/sap/bc/adt/programs/includes/zr_app_foo_f01/source/main',
      '/sap/bc/adt/programs/includes/zr_app_foo_gone/source/main'
    ]);
    // "FORM read_data" also sits inside "PERFORM read_data." in the main
    // program, so both sources answer - and each one says which it is
    expect(result.results.map((r: any) => [r.name, r.matches[0].line])).toEqual([
      ['ZR_APP_FOO', 5],
      ['ZR_APP_FOO_F01', 1]
    ]);
  });

  it('reports an unreadable include instead of failing the search', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleFindInSource({
      objectSourceUrl: MAIN_URL,
      pattern: 'read_data',
      searchIncludes: true
    }));
    expect(result.status).toBe('success');
    expect(result.unreadableIncludes).toEqual([
      { name: 'ZR_APP_FOO_GONE', error: 'Object does not exist' }
    ]);
  });

  it('passes the requested version through to every read', async () => {
    const { handlers, read } = handler();
    await handlers.handleFindInSource({
      objectSourceUrl: MAIN_URL,
      pattern: 'x',
      version: 'active',
      searchIncludes: true
    });
    expect(read.every(r => r.options?.version === 'active')).toBe(true);
  });

  it('refuses a version that does not exist', async () => {
    const { handlers } = handler();
    await expect(handlers.handleFindInSource({
      objectSourceUrl: MAIN_URL,
      pattern: 'x',
      version: 'latest'
    })).rejects.toThrow(/version must be one of/);
  });

  it('keeps the total honest when maxMatches cuts the list short', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleFindInSource({
      objectSourceUrl: MAIN_URL,
      pattern: 'INCLUDE',
      maxMatches: 1
    }));
    expect(result).toMatchObject({ totalMatches: 2, returnedMatches: 1, truncated: true });
  });

  it('says what to try when nothing matched', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleFindInSource({
      objectSourceUrl: MAIN_URL,
      pattern: 'zzz_not_here'
    }));
    expect(result.totalMatches).toBe(0);
    expect(result.hint).toMatch(/version="active"/);
  });
});

describe('sourceOutline', () => {
  it('lists the blocks of the object', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleSourceOutline({ objectSourceUrl: MAIN_URL }));
    expect(result.results[0].entries).toEqual([
      { kind: 'REPORT', name: 'ZR_APP_FOO', line: 1 },
      { kind: 'INCLUDE', name: 'ZR_APP_FOO_F01', line: 2 },
      { kind: 'INCLUDE', name: 'ZR_APP_FOO_GONE', line: 3 },
      { kind: 'EVENT', name: 'START-OF-SELECTION', line: 4 }
    ]);
  });

  it('filters by kind', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleSourceOutline({
      objectSourceUrl: MAIN_URL,
      kinds: ['include']
    }));
    expect(result.entries).toBe(2);
    expect(result.results[0].entries.every((e: any) => e.kind === 'INCLUDE')).toBe(true);
  });

  it('outlines the includes as well when asked', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleSourceOutline({
      objectSourceUrl: MAIN_URL,
      searchIncludes: true,
      kinds: ['FORM']
    }));
    const forms = result.results.flatMap((r: any) => r.entries);
    expect(forms).toEqual([{ kind: 'FORM', name: 'READ_DATA', line: 1 }]);
  });
});

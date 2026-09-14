import { CodeAnalysisHandlers } from '../handlers/CodeAnalysisHandlers';
import { sourceCache } from '../lib/sourceCache';

/**
 * A syntax check needs the whole source, and for an include it needs the
 * program that include belongs to as well - without one the backend answers
 * 400, and the include's own URL does not say which program that is.
 */
const INCLUDE_URL = '/sap/bc/adt/programs/includes/zr_app_f01/source/main';
const PROGRAM_URL = '/sap/bc/adt/programs/programs/zr_app';
const SOURCE = 'FORM run.\nENDFORM.';

const handlers = (over: Record<string, unknown> = {}) => {
  const asked: any[] = [];
  const client = {
    syntaxCheck: async (url: string, mainUrl: string, code: string, mainProgram?: string, version?: string) => {
      asked.push({ url, mainUrl, code, mainProgram, version });
      return [];
    },
    getObjectSource: async () => SOURCE,
    mainPrograms: async () => [{ 'adtcore:uri': PROGRAM_URL, 'adtcore:name': 'ZR_APP' }],
    ...over
  };
  return { handler: new CodeAnalysisHandlers(client as any), asked };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

describe('syntaxCheckCode', () => {
  beforeEach(() => sourceCache.clear());

  it('reads the source itself when none was passed and none is cached', async () => {
    const { handler, asked } = handlers();
    const result = answer(await handler.handleSyntaxCheckCode({
      url: '/sap/bc/adt/oo/classes/zcl_app/source/main'
    }));
    expect(asked[0].code).toBe(SOURCE);
    expect(result.readSource).toBe(true);
    expect(result.usedCachedSource).toBe(false);
  });

  it('prefers what this session already read over reading again', async () => {
    const classUrl = '/sap/bc/adt/oo/classes/zcl_app/source/main';
    sourceCache.set(classUrl, 'CLASS zcl_app DEFINITION.\nENDCLASS. " cached');
    const { handler, asked } = handlers({
      getObjectSource: async () => { throw new Error('should not be read'); }
    });
    const result = answer(await handler.handleSyntaxCheckCode({ url: classUrl }));
    expect(asked[0].code).toMatch(/cached/);
    expect(result.usedCachedSource).toBe(true);
    expect(result.readSource).toBeUndefined();
  });

  it('checks an include against its program, not against its own text', async () => {
    // Live: the backend compiles the content it is given as the main program,
    // so the include's own text answered "REPORT/PROGRAM statement missing" -
    // a syntax error about the wrong object, on an include that is fine.
    const { handler, asked } = handlers({
      getObjectSource: async (url: string) =>
        url.includes('/includes/') ? 'FORM run.\nENDFORM.' : 'REPORT zr_app.\nINCLUDE zr_app_f01.'
    });
    const result = answer(await handler.handleSyntaxCheckCode({ url: INCLUDE_URL, code: 'FORM run.\nENDFORM.' }));
    expect(asked[0].url).toBe(INCLUDE_URL);
    expect(asked[0].mainUrl).toBe(`${PROGRAM_URL}/source/main`);
    expect(asked[0].code).toMatch(/^REPORT zr_app/);
    expect(result).toMatchObject({
      mainUrlResolved: `${PROGRAM_URL}/source/main`,
      checkedAgainst: `${PROGRAM_URL}/source/main`,
      codeIgnored: true
    });
    expect(result.includeNote).toMatch(/Write the include first/);
  });

  it('keeps the main URL the caller passed, and checks against that program', async () => {
    const { handler, asked } = handlers({
      mainPrograms: async () => { throw new Error('should not be asked'); }
    });
    const result = answer(await handler.handleSyntaxCheckCode({
      url: INCLUDE_URL, mainUrl: '/sap/bc/adt/programs/programs/zother/source/main'
    }));
    expect(asked[0].mainUrl).toBe('/sap/bc/adt/programs/programs/zother/source/main');
    expect(result.mainUrlResolved).toBeUndefined();
    expect(result.checkedAgainst).toBe('/sap/bc/adt/programs/programs/zother/source/main');
  });

  it('checks a class without looking for a main program, and is its own main URL', async () => {
    // Live, a class with nothing but its URL was refused: "mainUrl and content
    // are required for syntax check" - two parameters that for a class can
    // only ever hold the same value.
    const { handler, asked } = handlers({
      mainPrograms: async () => { throw new Error('should not be asked'); }
    });
    const classUrl = '/sap/bc/adt/oo/classes/zcl_app/source/main';
    const result = answer(await handler.handleSyntaxCheckCode({ url: classUrl, code: SOURCE }));
    expect(asked[0].mainUrl).toBe(classUrl);
    expect(result.mainUrlResolved).toBeUndefined();
    expect(result.checkedAgainst).toBeUndefined();
  });

  it('carries on with what it was given when the main program cannot be found', async () => {
    const { handler, asked } = handlers({ mainPrograms: async () => [] });
    const result = answer(await handler.handleSyntaxCheckCode({ url: INCLUDE_URL, code: SOURCE }));
    expect(asked[0].mainUrl).toBe(INCLUDE_URL);
    expect(asked[0].code).toBe(SOURCE);
    expect(result.checkedAgainst).toBeUndefined();
  });

  it('says what to pass when the source can be neither found nor read', async () => {
    const { handler } = handlers({
      getObjectSource: async () => { throw new Error('404 not found'); }
    });
    await expect(handler.handleSyntaxCheckCode({ url: '/sap/bc/adt/oo/classes/zcl_gone' }))
      .rejects.toThrow(/reading it failed.*404 not found/);
  });
});

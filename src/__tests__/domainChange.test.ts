import {
  domainChangeSnippet,
  domainDirectorySql,
  domainPreviewToken,
  domainStateFromTables,
  domainTextsSql,
  domainVersionsSql,
  fixValueRows,
  fixValueTextsSql,
  fixValuesFingerprint,
  fixValuesSql,
  languageOfIsoSql,
  planDomainChange,
  textLanguages
} from '../lib/domainChange';
import type { CurrentDomain } from '../lib/domainChange';
import { MAX_QUERY_CHARS } from '../lib/queryLimits';

/**
 * Changing a domain on a release with no domain endpoint. What is held here:
 * the tables are read in the shape ADT answers with; a value that stays keeps
 * its position (the translations in DD07T hang on it) and its text; only what
 * the caller passed is written; and the generated ABAP checks what it reads
 * against the preview before it writes anything.
 */
const HEADER = {
  AS4LOCAL: 'A',
  DATATYPE: 'CHAR',
  LENG: 1,
  OUTPUTLEN: 1,
  VALEXI: 'X',
  AS4DATE: '2026-09-28T00:00:00.000Z',
  AS4TIME: '170757'
};
const VALUES = [{ VALPOS: 1, DOMVALUE_L: '1' }, { VALPOS: 3, DOMVALUE_L: '2' }];
const VALUE_TEXTS = [
  { VALPOS: 1, DDLANGUAGE: 'R', DDTEXT: 'Высокий' },
  { VALPOS: 1, DDLANGUAGE: 'E', DDTEXT: 'Highest' },
  { VALPOS: 3, DDLANGUAGE: 'R', DDTEXT: 'Средний' }
];
const TABLES = {
  header: HEADER,
  texts: [{ DDLANGUAGE: 'R', DDTEXT: 'Уровень' }],
  values: VALUES,
  valueTexts: VALUE_TEXTS,
  directory: { DEVCLASS: 'ZPKG', AUTHOR: 'DEV', MASTERLANG: 'R', SRCSYSTEM: 'DEV' }
};
const current = (): CurrentDomain => ({
  header: HEADER,
  description: 'Уровень',
  fixValues: fixValueRows(VALUES, VALUE_TEXTS)
});

describe('reading the tables', () => {
  it('keeps every statement under the query endpoint limit with the longest name', () => {
    const longest = 'Z'.repeat(30);
    for (const sql of [
      domainVersionsSql(longest),
      domainTextsSql(longest, 'A'),
      fixValuesSql(longest, 'N'),
      fixValueTextsSql(longest, 'A'),
      domainDirectorySql(longest),
      languageOfIsoSql('ru')
    ]) {
      expect(sql.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    }
  });

  it('refuses a name that would need escaping', () => {
    expect(() => domainVersionsSql("Z' OR 'X")).toThrow(/not a domain name/);
    expect(() => languageOfIsoSql('RUS')).toThrow(/not a language/);
  });

  it('groups the value texts by position and language', () => {
    const rows = fixValueRows(VALUES, VALUE_TEXTS);
    expect(rows).toEqual([
      { position: 1, low: '1', high: '', texts: { R: 'Высокий', E: 'Highest' } },
      { position: 3, low: '2', high: '', texts: { R: 'Средний' } }
    ]);
    expect(textLanguages(TABLES)).toEqual(['E', 'R']);
  });

  it('answers in the shape getDomainProperties has over ADT, texts in the language asked', () => {
    const { state } = domainStateFromTables(TABLES, 'R');
    expect(state.metaData).toMatchObject({ description: 'Уровень', language: 'R', masterLanguage: 'R', packageName: 'ZPKG', responsible: 'DEV' });
    expect(state.properties.typeInformation).toEqual({ datatype: 'CHAR', length: 1, decimals: 0 });
    expect(state.properties.outputInformation).toEqual({ length: 1, signExists: false, lowercase: false, ampmFormat: false });
    expect(state.properties.valueInformation?.fixValues).toEqual([
      { low: '1', text: 'Высокий' },
      { low: '2', text: 'Средний' }
    ]);
    expect(domainStateFromTables(TABLES, 'E').state.properties.valueInformation?.fixValues?.[1].text).toBe('');
  });
});

describe('planDomainChange', () => {
  it('adds a value after the last and keeps the others in their order, numbered the way DDIF_DOMA_PUT numbers them', () => {
    const plan = planDomainChange(current(), {
      fixValues: [{ low: '1' }, { low: '2' }, { low: '3', text: 'Низкий' }]
    }, 'R');
    expect(plan.changed).toBe(true);
    expect(plan.added).toEqual(['3']);
    expect(plan.removed).toEqual([]);
    expect(plan.retexted).toEqual([]);
    expect(plan.assignments).toEqual([]);
    expect(plan.fixValues).toEqual([
      { position: 1, valpos: 1, low: '1', high: '', text: 'Высокий', origin: 'kept' },
      { position: 2, valpos: 3, low: '2', high: '', text: 'Средний', origin: 'kept' },
      { position: 3, valpos: 4, low: '3', high: '', text: 'Низкий', origin: 'added' }
    ]);
  });

  it('changes a text, removes a value, and clears the flag when nothing is left', () => {
    const retext = planDomainChange(current(), { fixValues: [{ low: '1', text: 'Главный' }] }, 'R');
    expect(retext.retexted).toEqual(['1']);
    expect(retext.removed).toEqual(['2']);
    expect(retext.fixValues).toEqual([{ position: 1, valpos: 1, low: '1', high: '', text: 'Главный', origin: 'kept', retexted: true }]);

    const cleared = planDomainChange(current(), { fixValues: [] }, 'R');
    expect(cleared.removed).toEqual(['1', '2']);
    expect(cleared.assignments).toEqual(["ls_dd01v-valexi = ' '."]);
  });

  it('writes only the header fields that change, and takes the output length along with the length', () => {
    const plan = planDomainChange(current(), { datatype: 'char', length: 2, description: 'Уровень', lowercase: false }, 'R');
    expect(plan.assignments).toEqual(['ls_dd01v-leng = 2.', 'ls_dd01v-outputlen = 2.']);
    expect(plan.header).toEqual({ leng: { from: '1', to: '2' }, outputlen: { from: '1', to: '2' } });
    expect(plan.fixValues).toBeUndefined();
  });

  it('says when there is nothing to change', () => {
    const plan = planDomainChange(current(), { fixValues: [{ low: '1' }, { low: '2' }], datatype: 'CHAR' }, 'R');
    expect(plan.changed).toBe(false);
  });

  it('takes the blank value and refuses what makes no sense', () => {
    expect(planDomainChange(current(), { fixValues: [{ low: '1' }, { low: '2' }, { low: '' }] }, 'R').added).toEqual(["' '"]);
    expect(() => planDomainChange(current(), { fixValues: [{ low: '3' }, { low: '3' }] }, 'R')).toThrow(/twice/);
    expect(() => planDomainChange(current(), { fixValues: [{ low: 'TOO_LONG_VALUE' }] }, 'R')).toThrow(/holds 10/);
    expect(() => planDomainChange(current(), { fixValues: [{} as any] }, 'R')).toThrow(/no low value/);
    expect(() => planDomainChange(current(), { conversionExit: 'TOOLONG' }, 'R')).toThrow(/conversion exit/);
    expect(() => planDomainChange(current(), { fixValues: 'x' as any }, 'R')).toThrow(/list/);
  });
});

describe('domainPreviewToken', () => {
  it('changes with the domain and with the change', () => {
    const plan = planDomainChange(current(), { fixValues: [{ low: '1' }, { low: '2' }, { low: '3' }] }, 'R');
    const token = domainPreviewToken('ZTEST', 'R', 'stamp', current(), plan);
    expect(domainPreviewToken('ZTEST', 'R', 'stamp', current(), plan)).toBe(token);
    expect(domainPreviewToken('ZTEST', 'R', 'later', current(), plan)).not.toBe(token);
    expect(domainPreviewToken('ZTEST', 'E', 'stamp', current(), plan)).not.toBe(token);
    const other = planDomainChange(current(), { fixValues: [{ low: '1' }, { low: '2' }, { low: '4' }] }, 'R');
    expect(domainPreviewToken('ZTEST', 'R', 'stamp', current(), other)).not.toBe(token);
  });
});

describe('domainChangeSnippet', () => {
  const plan = planDomainChange(current(), {
    length: 2,
    fixValues: [{ low: '1' }, { low: '2', text: 'Второй' }, { low: '3', text: 'Третий' }]
  }, 'R');
  const spec = {
    name: 'ztest_prio',
    packageName: 'ZPKG',
    request: 'DEVK900100',
    language: 'R',
    expected: fixValuesFingerprint(current().fixValues),
    plan,
    activate: true
  };

  it('registers, reads, compares, writes, activates - and puts the old definition back on a failed activation', () => {
    const text = domainChangeSnippet(spec).code.join('\n');
    const at = (needle: string) => text.indexOf(needle);
    expect(text).toContain("object = 'DOMAZTEST_PRIO' object_class = 'DICT' mode = ' '");
    expect(at("'RS_CORR_INSERT'")).toBeLessThan(at("'DDIF_DOMA_GET'"));
    expect(at("'DDIF_DOMA_GET'")).toBeLessThan(at('STEP~#~compare'));
    expect(at('STEP~#~compare')).toBeLessThan(at('ls_dd01v-leng = 2.'));
    expect(at('ls_dd01v-leng = 2.')).toBeLessThan(at("'DDIF_DOMA_PUT'"));
    expect(at("'DDIF_DOMA_PUT'")).toBeLessThan(at("'DDIF_DOMA_ACTIVATE'"));
    expect(text).toContain('dd01v_wa = ls_old');
    expect(text).toContain('lv_expected = `0001:1:,0003:2:,`.');
  });

  it('keeps the rows of the values that stay, as read, and builds only the new ones', () => {
    const text = domainChangeSnippet(spec).code.join('\n');
    expect(text).toContain("APPEND lt_old[ valpos = '0001' ] TO lt_dd07v.");
    expect(text).toContain("APPEND lt_old[ valpos = '0003' ] TO lt_dd07v.");
    expect(text).toContain("lt_dd07v[ valpos = '0003' ]-ddtext = 'Второй'.");
    expect(text).not.toContain("lt_dd07v[ valpos = '0001' ]-ddtext");
    expect(text).toContain("APPEND VALUE #( domname = 'ZTEST_PRIO' valpos = '0004' ddlanguage = lv_langu");
  });

  it('keeps every line under 255 characters, a long value list included', () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ position: index + 1, low: `V${index}`, high: '', texts: {} }));
    const code = domainChangeSnippet({ ...spec, expected: fixValuesFingerprint(many) }).code;
    for (const line of code) expect(line.length).toBeLessThanOrEqual(255);
    expect(code.filter(line => line.startsWith('  && ')).length).toBeGreaterThan(5);
  });

  it('leaves the activation out when asked, and refuses a language that is not a key', () => {
    expect(domainChangeSnippet({ ...spec, activate: false }).code.join('\n')).not.toContain('DDIF_DOMA_ACTIVATE');
    expect(() => domainChangeSnippet({ ...spec, language: 'RU' })).toThrow(/one-character/);
  });
});

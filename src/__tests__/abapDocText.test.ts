import { planComponentTexts, shortTextOf, AbapDocError, abapDocLines } from '../lib/abapDocText';
import { applyEdits, resolveEdits } from '../lib/sourcePatch';
import { planAddMethod, ClassEditError } from '../lib/classEdit';

/**
 * The short texts of components live in the source as ABAP Doc, and the
 * backend copies them into SEOCOMPOTX/SEOSUBCOTX on save. What is held in
 * place here is where the line goes - above the declaration, or above the
 * entry of a chain - and that an ABAP Doc block already there is kept.
 */
const CLASS = [
  'CLASS zcl_app DEFINITION PUBLIC FINAL CREATE PUBLIC.',
  '  PUBLIC SECTION.',
  '    "! Builds the answer.',
  '    "! <p class="shorttext synchronized" lang="ru">Старый текст</p>',
  '    "! @parameter iv_id | <p class="shorttext synchronized" lang="ru">Старый ID</p>',
  '    METHODS build',
  '      IMPORTING',
  '        !iv_id   TYPE i',
  '        !iv_name TYPE string',
  '      RETURNING',
  '        VALUE(rv_ok) TYPE abap_bool .',
  '    METHODS:',
  '      first,',
  '      second IMPORTING iv_x TYPE i.',
  '    METHODS: inline, other.',
  '  PRIVATE SECTION.',
  '    DATA mv_count TYPE i .',
  '    CONSTANTS c_max TYPE i VALUE 10 .',
  'ENDCLASS.',
  '',
  'CLASS zcl_app IMPLEMENTATION.',
  '  METHOD build.',
  '  ENDMETHOD.',
  'ENDCLASS.'
].join('\r\n');

const apply = (source: string, edits: any[]) => applyEdits(source, resolveEdits(source, edits));

describe('planComponentTexts', () => {
  it('replaces the short text of a documented method and keeps the rest of its block', () => {
    const plan = planComponentTexts(CLASS, { component: 'build', description: 'Новый текст', language: 'ru' });
    const after = apply(CLASS, plan.edits);
    expect(after).toContain('    "! Builds the answer.\r\n    "! <p class="shorttext synchronized" lang="ru">Новый текст</p>\r\n');
    expect(after).toContain('Старый ID');
    expect(shortTextOf(plan.before)).toBe('Старый текст');
    expect(shortTextOf(plan.after)).toBe('Новый текст');
  });

  it('replaces one parameter text and adds another at the end of the block', () => {
    const plan = planComponentTexts(CLASS, {
      component: 'BUILD',
      parameters: { IV_ID: 'Номер задачи', rv_ok: 'Признак успеха' },
      language: 'ru'
    });
    expect(plan.after).toEqual([
      '    "! Builds the answer.',
      '    "! <p class="shorttext synchronized" lang="ru">Старый текст</p>',
      '    "! @parameter iv_id | <p class="shorttext synchronized" lang="ru">Номер задачи</p>',
      '    "! @parameter rv_ok | <p class="shorttext synchronized" lang="ru">Признак успеха</p>'
    ]);
  });

  it('inserts a new block above an undocumented attribute and a constant', () => {
    const plan = planComponentTexts(CLASS, { component: 'mv_count', description: 'Счётчик <вызовов>', language: 'ru' });
    expect(plan.edits).toEqual([{
      insertAfterLine: 16,
      insertion: '    "! <p class="shorttext synchronized" lang="ru">Счётчик &lt;вызовов&gt;</p>',
      describe: 'ABAP Doc of MV_COUNT'
    }]);
    expect(planComponentTexts(CLASS, { component: 'c_max', description: 'Предел', language: 'ru' }).declaredAt).toBe(18);
  });

  it('puts the line above the entry of a chain, and refuses an entry on the line of the colon', () => {
    const plan = planComponentTexts(CLASS, { component: 'second', description: 'Второй', language: 'ru' });
    expect(plan.declaredAt).toBe(14);
    expect(apply(CLASS, plan.edits)).toContain('      first,\r\n      "! <p class="shorttext synchronized" lang="ru">Второй</p>\r\n      second IMPORTING');
    expect(() => planComponentTexts(CLASS, { component: 'inline', description: 'x', language: 'ru' }))
      .toThrow(/same line as the colon/);
  });

  it('writes nothing when the texts are already there', () => {
    const plan = planComponentTexts(CLASS, { component: 'build', description: 'Старый текст', language: 'ru' });
    expect(plan.edits).toEqual([]);
  });

  it('refuses what the tables cannot hold or the class does not have', () => {
    expect(() => planComponentTexts(CLASS, { component: 'nothing', description: 'x', language: 'ru' }))
      .toThrow(/not declared here/);
    expect(() => planComponentTexts(CLASS, { component: 'build', parameters: { iv_none: 'x' }, language: 'ru' }))
      .toThrow(/no parameter IV_NONE/);
    expect(() => planComponentTexts(CLASS, { component: 'mv_count', parameters: { a: 'x' }, language: 'ru' }))
      .toThrow(/has no parameters/);
    expect(() => planComponentTexts(CLASS, { component: 'build', description: 'x'.repeat(61), language: 'ru' }))
      .toThrow(AbapDocError);
    expect(() => planComponentTexts(CLASS, { component: 'build', language: 'ru' })).toThrow(/description, parameters/);
  });

  it('finds the methods of an interface', () => {
    const source = [
      'INTERFACE zif_app PUBLIC.',
      '  METHODS get_task',
      '    IMPORTING iv_key TYPE string.',
      'ENDINTERFACE.'
    ].join('\n');
    const plan = planComponentTexts(source, {
      component: 'get_task', description: 'Задача по ключу', parameters: { iv_key: 'Ключ' }, language: 'ru'
    });
    expect(apply(source, plan.edits).split('\n').slice(1, 3)).toEqual([
      '  "! <p class="shorttext synchronized" lang="ru">Задача по ключу</p>',
      '  "! @parameter iv_key | <p class="shorttext synchronized" lang="ru">Ключ</p>'
    ]);
  });
});

describe('addMethod with short texts', () => {
  const source = [
    'CLASS zcl_app DEFINITION PUBLIC FINAL CREATE PUBLIC.',
    '  PUBLIC SECTION.',
    '    METHODS run .',
    'ENDCLASS.',
    '',
    'CLASS zcl_app IMPLEMENTATION.',
    '  METHOD run.',
    '  ENDMETHOD.',
    'ENDCLASS.'
  ].join('\n');

  it('puts the ABAP Doc of the method and its parameters above the declaration', () => {
    const edits = planAddMethod(source, {
      name: 'get_task',
      description: 'Задача по ключу',
      language: 'ru',
      importing: [{ name: 'iv_key', type: 'string', description: 'Ключ' }, { name: 'iv_flag', type: 'abap_bool' }],
      returning: { name: 'rs_task', type: 'zst_task', description: 'Задача' }
    });
    const declaration = (edits[1] as any).insertion.split('\n');
    expect(declaration.slice(0, 4)).toEqual([
      '    "! <p class="shorttext synchronized" lang="ru">Задача по ключу</p>',
      '    "! @parameter iv_key | <p class="shorttext synchronized" lang="ru">Ключ</p>',
      '    "! @parameter rs_task | <p class="shorttext synchronized" lang="ru">Задача</p>',
      '    METHODS get_task'
    ]);
  });

  it('adds no ABAP Doc without texts, and refuses a text the table cannot hold', () => {
    const plain = (planAddMethod(source, { name: 'get_task' })[1] as any).insertion;
    expect(plain).not.toContain('"!');
    expect(() => planAddMethod(source, { name: 'get_task', description: 'x'.repeat(61) })).toThrow(ClassEditError);
  });

  it('builds the lines in the given language', () => {
    expect(abapDocLines('  ', 'EN', 'Text')).toEqual(['  "! <p class="shorttext synchronized" lang="en">Text</p>']);
  });
});

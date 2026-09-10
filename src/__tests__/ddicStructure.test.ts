import {
  buildStructureSource,
  parseStructureSource,
  openerFrom,
  structureUrl,
  structureSourceUrl
} from '../lib/ddicStructure';

/** What the backend answers for a freshly created TABL/DS on a classic ERP system. */
const STUB = [
  "@EndUserText.label : 'MCP probe structure'",
  '@AbapCatalog.enhancementCategory : #NOT_EXTENSIBLE',
  'define type zdev_mcp_struc {',
  '  component_to_be_changed : abap.string(0);',
  '',
  '}'
].join('\n');

/** A real table, read through the same endpoint. */
const TABLE = [
  "@EndUserText.label : 'Table of route requests'",
  '@AbapCatalog.enhancementCategory : #NOT_EXTENSIBLE',
  'define type zappstep {',
  '  key mandt   : mandt not null;',
  '  key stepout : zapp_step_out not null;',
  '  aedat       : aedat;',
  '',
  '}'
].join('\n');

describe('openerFrom', () => {
  // The keyword differs between releases - this backend writes "define type",
  // newer ones "define structure" - and a write with the wrong one is refused
  // with "Can't save due to errors in source".
  it('takes the opening line from what the backend served', () => {
    expect(openerFrom(STUB, 'ZDEV_MCP_STRUC')).toBe('define type zdev_mcp_struc {');
  });

  it('falls back to define type when there is no stub to learn from', () => {
    expect(openerFrom(undefined, 'ZDEV_MCP_STRUC')).toBe('define type zdev_mcp_struc {');
    expect(openerFrom('', 'ZFOO')).toBe('define type zfoo {');
  });

  it('keeps a newer release\'s keyword', () => {
    const newer = 'define structure zfoo {\n  a : abap.char(1);\n}';
    expect(openerFrom(newer, 'ZFOO')).toBe('define structure zfoo {');
  });
});

describe('buildStructureSource', () => {
  it('writes the label, the opener and the fields in order', () => {
    const source = buildStructureSource({
      name: 'ZDEV_MCP_STRUC',
      description: 'MCP probe structure',
      stub: STUB,
      fields: [
        { name: 'WERKS', type: 'WERKS_D', keyField: true },
        { name: 'MATNR', type: 'MATNR' }
      ]
    });
    expect(source.split('\n')).toEqual([
      "@EndUserText.label : 'MCP probe structure'",
      '@AbapCatalog.enhancementCategory : #NOT_EXTENSIBLE',
      'define type zdev_mcp_struc {',
      '  key werks : werks_d not null;',
      '  matnr : matnr;',
      '}'
    ]);
  });

  // SAP stores a key field NOT NULL whichever way it was written, and a key
  // without it makes the activation complain about the very field.
  it('writes a key field NOT NULL even when the caller did not ask', () => {
    const source = buildStructureSource({
      name: 'ZS', description: 'd',
      fields: [{ name: 'MANDT', type: 'MANDT', keyField: true }]
    });
    expect(source).toContain('key mandt : mandt not null;');
  });

  // A real table writes 'mseg.meins', not 'meins', and the unqualified form is
  // refused with a message that names the quantity field and not the reference.
  it('qualifies a unit or currency reference with the structure name', () => {
    const source = buildStructureSource({
      name: 'ZDEV_MCP_STRUC', description: 'd',
      fields: [
        { name: 'MEINS', type: 'MEINS' },
        { name: 'WAERS', type: 'WAERS' },
        { name: 'MENGE', type: 'MENGE_D', unitField: 'MEINS' },
        { name: 'NETWR', type: 'NETWR', currencyField: 'waers' }
      ]
    });
    expect(source).toContain("@Semantics.quantity.unitOfMeasure : 'zdev_mcp_struc.meins'");
    expect(source).toContain("@Semantics.amount.currencyCode : 'zdev_mcp_struc.waers'");
  });

  it('refuses a unit reference to a field the structure does not have', () => {
    expect(() => buildStructureSource({
      name: 'ZS', description: 'd',
      fields: [{ name: 'MENGE', type: 'MENGE_D', unitField: 'MEINS' }]
    })).toThrow(/unitField 'MEINS' is not a field of this structure/);
    expect(() => buildStructureSource({
      name: 'ZS', description: 'd',
      fields: [{ name: 'NETWR', type: 'NETWR', currencyField: 'WAERS' }]
    })).toThrow(/currencyField 'WAERS' is not a field/);
  });

  it('puts field annotations above their field', () => {
    const source = buildStructureSource({
      name: 'ZS', description: 'd',
      fields: [{
        name: 'MENGE', type: 'MENGE_D',
        annotations: ["@Semantics.quantity.unitOfMeasure: 'meins'"]
      }]
    });
    expect(source.split('\n').slice(-3)).toEqual([
      "  @Semantics.quantity.unitOfMeasure: 'meins'",
      '  menge : menge_d;',
      '}'
    ]);
  });

  it('escapes an apostrophe in the description', () => {
    const source = buildStructureSource({
      name: 'ZS', description: "Driver's log",
      fields: [{ name: 'A', type: 'abap.char(1)' }]
    });
    expect(source).toContain("@EndUserText.label : 'Driver''s log'");
  });

  it('takes an enhancement category with or without the hash', () => {
    const withHash = buildStructureSource({
      name: 'ZS', description: 'd', enhancementCategory: '#EXTENSIBLE_ANY',
      fields: [{ name: 'A', type: 'abap.char(1)' }]
    });
    const without = buildStructureSource({
      name: 'ZS', description: 'd', enhancementCategory: 'EXTENSIBLE_ANY',
      fields: [{ name: 'A', type: 'abap.char(1)' }]
    });
    expect(withHash).toContain('#EXTENSIBLE_ANY');
    expect(without).toContain('#EXTENSIBLE_ANY');
  });

  it('refuses an empty field list, a nameless field and a duplicate', () => {
    expect(() => buildStructureSource({ name: 'ZS', description: 'd', fields: [] }))
      .toThrow(/at least one field/);
    expect(() => buildStructureSource({
      name: 'ZS', description: 'd', fields: [{ name: '2BAD', type: 'abap.char(1)' }]
    })).toThrow(/is not a field name/);
    expect(() => buildStructureSource({
      name: 'ZS', description: 'd',
      fields: [{ name: 'A', type: 'abap.char(1)' }, { name: 'a', type: 'abap.char(2)' }]
    })).toThrow(/listed twice/);
    expect(() => buildStructureSource({
      name: 'ZS', description: 'd', fields: [{ name: 'A', type: '' }]
    })).toThrow(/has no type/);
  });
});

describe('parseStructureSource', () => {
  it('reads a real table into a field list with its keys', () => {
    const parsed = parseStructureSource(TABLE);
    expect(parsed.name).toBe('ZAPPSTEP');
    expect(parsed.label).toBe('Table of route requests');
    expect(parsed.fields).toEqual([
      { name: 'MANDT', type: 'mandt', keyField: true, notNull: true },
      { name: 'STEPOUT', type: 'zapp_step_out', keyField: true, notNull: true },
      { name: 'AEDAT', type: 'aedat', keyField: false, notNull: false }
    ]);
  });

  it('keeps a field annotation with its field', () => {
    const source = [
      'define type zs {',
      "  @Semantics.quantity.unitOfMeasure: 'meins'",
      '  menge : menge_d;',
      '}'
    ].join('\n');
    expect(parseStructureSource(source).fields[0].annotations)
      .toEqual(["@Semantics.quantity.unitOfMeasure: 'meins'"]);
  });

  it('reports a line it does not understand instead of dropping it', () => {
    const source = 'define type zs {\n  include zs_common;\n  a : abap.char(1);\n}';
    const parsed = parseStructureSource(source);
    expect(parsed.other).toEqual(['include zs_common;']);
    expect(parsed.fields.map(f => f.name)).toEqual(['A']);
  });

  it('survives a header with no define line', () => {
    const parsed = parseStructureSource('nothing useful here');
    expect(parsed).toEqual({ name: '', fields: [], other: [] });
  });

  it('round-trips what it builds', () => {
    const source = buildStructureSource({
      name: 'ZS', description: 'Round trip', stub: STUB,
      fields: [
        { name: 'WERKS', type: 'WERKS_D', keyField: true },
        { name: 'MATNR', type: 'MATNR' }
      ]
    });
    const parsed = parseStructureSource(source);
    expect(parsed.fields.map(f => [f.name, f.keyField])).toEqual([['WERKS', true], ['MATNR', false]]);
  });
});

describe('urls', () => {
  it('serves tables and structures from the same collection', () => {
    expect(structureUrl('ZAPPSTEP')).toBe('/sap/bc/adt/ddic/structures/zappstep');
    expect(structureSourceUrl('ZAPPSTEP')).toBe('/sap/bc/adt/ddic/structures/zappstep/source/main');
  });
});

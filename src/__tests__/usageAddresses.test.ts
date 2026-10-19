import { AdtErrorException } from 'abap-adt-api';
import { CodeAnalysisHandlers } from '../handlers/CodeAnalysisHandlers';
import {
  domainDataElementsSql,
  domainFieldsSql,
  domainOfUrl,
  domainUsage,
  isUnconvertibleReference,
  tableAsStructureUrl,
  usageReferencesAt
} from '../lib/usageReferences';
import { MAX_QUERY_CHARS } from '../lib/queryLimits';

/**
 * The where-used answers 500 "Error while converting object references" for an
 * address the release does not serve. Measured on the classic ERP system: a
 * table at /ddic/tables answers that and the same table at /ddic/structures
 * answers the whole tree; a domain has no address there at all, and is not in
 * the where-used index either - it is not an ABAP type.
 */
const unconvertible = () => new AdtErrorException(500, {}, 'ABAP References Resource Error', 'Error while converting object references');
const SITE = {
  'adtcore:name': 'GET_PRICES',
  'adtcore:type': 'CLAS/OM',
  uri: '/sap/bc/adt/oo/classes/zcl_x/source/main',
  objectIdentifier: 'ABAPFullName;ZCL_X=============CP;ZCL_X=============CM001;\\TY:ZTABLE;2'
};

describe('the addresses', () => {
  it('knows the 500 that means "no such address" and nothing else', () => {
    expect(isUnconvertibleReference(unconvertible())).toBe(true);
    expect(isUnconvertibleReference(new AdtErrorException(500, {}, 'X', 'Something else broke'))).toBe(false);
    expect(isUnconvertibleReference(new AdtErrorException(404, {}, 'X', 'Error while converting object references'))).toBe(false);
  });

  it('moves a table to the structure address and reads a domain name', () => {
    expect(tableAsStructureUrl('/sap/bc/adt/ddic/tables/ztable')).toBe('/sap/bc/adt/ddic/structures/ztable');
    expect(tableAsStructureUrl('/sap/bc/adt/ddic/tables/ztable/source/main')).toBe('/sap/bc/adt/ddic/structures/ztable/source/main');
    expect(tableAsStructureUrl('/sap/bc/adt/ddic/structures/ztable')).toBeUndefined();
    expect(domainOfUrl('/sap/bc/adt/ddic/domains/zdom_prio')).toBe('ZDOM_PRIO');
    expect(domainOfUrl('/sap/bc/adt/ddic/dataelements/zdom_prio')).toBeUndefined();
  });

  it('keeps the dictionary queries under the endpoint limit and refuses a name that needs escaping', () => {
    const longest = 'Z'.repeat(30);
    expect(domainDataElementsSql(longest).length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(domainFieldsSql(longest).length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(() => domainFieldsSql("Z' OR 'X")).toThrow(/not a domain name/);
  });
});

describe('usageReferencesAt', () => {
  it('asks a table again at the structure address, and says it did', async () => {
    const asked: string[] = [];
    const client = {
      usageReferences: async (url: string) => {
        asked.push(url);
        if (url.includes('/ddic/tables/')) throw unconvertible();
        return [SITE];
      }
    };
    const found = await usageReferencesAt(client as any, '/sap/bc/adt/ddic/tables/ztable');
    expect(asked).toEqual(['/sap/bc/adt/ddic/tables/ztable', '/sap/bc/adt/ddic/structures/ztable']);
    expect(found).toEqual({ rows: [SITE], addressedAs: '/sap/bc/adt/ddic/structures/ztable' });
  });

  it('passes every other failure on untouched', async () => {
    const other = new AdtErrorException(500, {}, 'X', 'Something else broke');
    const client = { usageReferences: async () => { throw other; } };
    await expect(usageReferencesAt(client as any, '/sap/bc/adt/ddic/tables/ztable')).rejects.toBe(other);
    const domain = { usageReferences: async () => { throw unconvertible(); } };
    await expect(usageReferencesAt(domain as any, '/sap/bc/adt/ddic/domains/zdom')).rejects.toThrow(/converting/);
  });
});

describe('domainUsage', () => {
  it('counts everything and lists a page of each', () => {
    const usage = domainUsage(
      'ZDOM',
      [{ ROLLNAME: 'ZDOM_E' }, { ROLLNAME: 'ZDOM_E2' }],
      [{ TABNAME: 'ZTAB1', CNT: 2 }, { TABNAME: 'ZTAB2', CNT: 1 }, { TABNAME: 'ZTAB3', CNT: '4' }],
      2
    );
    expect(usage).toEqual({
      domain: 'ZDOM',
      dataElements: ['ZDOM_E', 'ZDOM_E2'],
      dataElementCount: 2,
      tables: [{ name: 'ZTAB1', fields: 2 }, { name: 'ZTAB2', fields: 1 }],
      tableCount: 3,
      atLeast: false
    });
  });
});

describe('usageReferences on addresses the release does not serve', () => {
  const answer = (result: any) => JSON.parse(result.content[0].text);

  it('answers a table from the structure address', async () => {
    const client = {
      usageReferences: async (url: string) => {
        if (url.includes('/ddic/tables/')) throw unconvertible();
        return [SITE];
      }
    };
    const result = answer(await new CodeAnalysisHandlers(client as any).handle('usageReferences', { url: '/sap/bc/adt/ddic/tables/ztable' }));
    expect(result.status).toBe('success');
    expect(result.addressedAs).toBe('/sap/bc/adt/ddic/structures/ztable');
    expect(result.summary.usageSites).toBe(1);
  });

  it('answers a domain from the dictionary', async () => {
    const queries: string[] = [];
    const client = {
      usageReferences: async () => { throw unconvertible(); },
      runQuery: async (sql: string) => {
        queries.push(sql);
        return { values: /dd04l/.test(sql) ? [{ ROLLNAME: 'ZDOM_E' }] : [{ TABNAME: 'ZTAB1', CNT: 1 }] };
      }
    };
    const result = answer(await new CodeAnalysisHandlers(client as any).handle('usageReferences', { url: '/sap/bc/adt/ddic/domains/zdom' }));
    expect(result).toMatchObject({ status: 'success', via: 'dictionary', domain: 'ZDOM', dataElements: ['ZDOM_E'], tableCount: 1 });
    expect(result.hint).toMatch(/dataelements\/zdom_e/);
    expect(queries).toHaveLength(2);
  });

  it('still fails on a 500 of another kind', async () => {
    const client = { usageReferences: async () => { throw new AdtErrorException(500, {}, 'X', 'Something else broke'); } };
    await expect(new CodeAnalysisHandlers(client as any).handle('usageReferences', { url: '/sap/bc/adt/ddic/domains/zdom' }))
      .rejects.toThrow(/Usage references failed/);
  });
});

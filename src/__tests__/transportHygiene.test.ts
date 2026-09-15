import { TransportHandlers } from '../handlers/TransportHandlers';
import { QueryHandlers } from '../handlers/QueryHandlers';
import { MAX_QUERY_CHARS, chunkedQueries } from '../lib/queryLimits';
import {
    normalizeRequest,
    isObjectNameSafe,
    isoDate,
    describeRequest,
    textMap,
    objectParts,
    historyOf,
    conflictsOf,
    sourceNames,
    ddicNames,
    inactiveSources,
    readinessVerdict,
    entriesByObjectQueries,
    inactiveSourceQueries
} from '../lib/transportHygiene';

/**
 * Transport hygiene, all of it read from the organizer tables.
 *
 * What the live runs behind this found, and what these tests hold in place:
 *
 *  - the data preview refuses a statement over 255 characters, whole and not
 *    per line, so every list is asked for in pieces - the first version of
 *    these tools failed on a request with six objects;
 *  - a date column arrives as a Date, and String(Date) reads "Tue Sep 15";
 *  - a class is recorded in REPOSRC under its name padded with '=' to thirty
 *    characters plus a part suffix, which is how one request was found to
 *    carry ten parts of a class saved and never activated;
 *  - one report was recorded in eleven requests and one customizing table in
 *    forty-three open ones, which is the case this is for.
 */
const answer = (result: any) => JSON.parse(result.content[0].text);

const row = (over: any = {}) => ({
    TRKORR: 'DEVK900001',
    TRFUNCTION: 'K',
    TRSTATUS: 'D',
    AS4USER: 'TESTER',
    AS4DATE: '2026-09-15T00:00:00.000Z',
    STRKORR: '',
    ...over
});

const entry = (over: any = {}) => ({
    TRKORR: 'DEVK900001',
    AS4POS: 1,
    PGMID: 'R3TR',
    OBJECT: 'PROG',
    OBJ_NAME: 'ZREPORT_ONE',
    ...over
});

describe('statements that fit what the endpoint accepts', () => {
    it('cuts a value list into statements inside the limit', () => {
        const names = Array.from({ length: 40 }, (_, i) => `ZOBJECT_NAME_NUMBER_${String(i).padStart(3, '0')}`);
        const queries = chunkedQueries('SELECT trkorr FROM e071 WHERE obj_name IN (', names);

        expect(queries.length).toBeGreaterThan(1);
        expect(queries.every(query => query.length <= MAX_QUERY_CHARS)).toBe(true);
        expect(queries.join(' ')).toContain('ZOBJECT_NAME_NUMBER_039');
    });

    it('keeps a single long value rather than dropping it', () => {
        const queries = chunkedQueries('SELECT a FROM b WHERE c IN (', ['X'.repeat(240)]);
        expect(queries).toHaveLength(1);
    });

    it('refuses a query the endpoint would refuse, saying what to do', async () => {
        const handlers = new QueryHandlers({ statelessClone: { runQuery: async () => ({ values: [] }) } } as any);
        const sql = `SELECT trkorr FROM e070 WHERE trkorr IN (${Array.from({ length: 30 }, () => "'DEVK900001'").join(', ')})`;

        expect(sql.length).toBeGreaterThan(MAX_QUERY_CHARS);
        await expect(handlers.handleRunQuery({ sqlQuery: sql })).rejects.toThrow(/refuses anything over 255/);
    });

    it('lets a query inside the limit through', async () => {
        const handlers = new QueryHandlers({
            statelessClone: { runQuery: async () => ({ columns: [], values: [] }) }
        } as any);

        const result = answer(await handlers.handleRunQuery({ sqlQuery: 'SELECT trkorr FROM e070' }));
        expect(result.status).toBe('success');
    });
});

describe('reading the organizer tables', () => {
    it('takes a request number and refuses anything else', () => {
        expect(normalizeRequest(' devk900123 ')).toBe('DEVK900123');
        expect(() => normalizeRequest('not a request')).toThrow(/ten characters/);
        expect(() => normalizeRequest('')).toThrow();
    });

    it('takes an object name and refuses what would carry SQL with it', () => {
        expect(isObjectNameSafe('ZCL_SOMETHING')).toBe(true);
        expect(isObjectNameSafe('/SDF/CL_X')).toBe(true);
        expect(isObjectNameSafe("X' OR '1'='1")).toBe(false);
    });

    it('reads a date column however the endpoint sends it', () => {
        expect(isoDate(new Date('2026-09-15T00:00:00.000Z'))).toBe('2026-09-15');
        expect(isoDate('2026-09-15T00:00:00.000Z')).toBe('2026-09-15');
        expect(isoDate(undefined)).toBeUndefined();
    });

    it('says what a request is in words rather than in letters', () => {
        const described = describeRequest(row(), textMap([{ TRKORR: 'DEVK900001', AS4TEXT: 'a change' }]));

        expect(described).toMatchObject({
            number: 'DEVK900001',
            typeText: 'workbench request',
            statusText: 'modifiable',
            owner: 'TESTER',
            date: '2026-09-15',
            description: 'a change',
            open: true
        });
    });

    it('groups the history of an object by request, newest first', () => {
        const history = historyOf('ZREPORT_ONE', [
            { ...row({ TRKORR: 'DEVK900001', AS4DATE: '2026-09-15' }), PGMID: 'LIMU', OBJECT: 'REPS' },
            { ...row({ TRKORR: 'DEVK900001', AS4DATE: '2026-09-15' }), PGMID: 'LIMU', OBJECT: 'REPT' },
            { ...row({ TRKORR: 'DEVK900000', TRSTATUS: 'R', AS4USER: 'OTHER', AS4DATE: '2026-09-01' }), PGMID: 'R3TR', OBJECT: 'PROG' }
        ], new Map());

        expect(history.summary).toEqual({ requests: 2, open: 1, released: 1, owners: ['TESTER', 'OTHER'] });
        expect(history.requests[0].number).toBe('DEVK900001');
        expect(history.requests[0].parts).toEqual(['LIMU REPS', 'LIMU REPT']);
    });

    it('counts only other people open requests as conflicts', () => {
        const mine = objectParts([entry(), entry({ OBJ_NAME: 'ZREPORT_TWO' })]);
        const others = [
            { ...entry({ TRKORR: 'DEVK900009' }), TRSTATUS: 'D', AS4USER: 'OTHER' },
            { ...entry({ TRKORR: 'DEVK900008' }), TRSTATUS: 'R', AS4USER: 'OTHER' },
            { ...entry({ TRKORR: 'DEVK900001' }), TRSTATUS: 'D', AS4USER: 'TESTER' }
        ];
        const found = conflictsOf(mine, others, new Set(['DEVK900001']), new Map());

        expect(found.summary).toEqual({ objects: 2, conflicting: 1, otherRequests: 1, owners: ['OTHER'] });
        expect(found.conflicts[0]).toMatchObject({ object: 'ZREPORT_ONE', otherRequest: 'DEVK900009', owner: 'OTHER' });
    });
});

describe('what is still inactive', () => {
    it('asks for a class under the name REPOSRC records it by', () => {
        const { names, prefixes } = sourceNames(objectParts([
            entry({ OBJECT: 'PROG', OBJ_NAME: 'ZREPORT_ONE' }),
            entry({ PGMID: 'LIMU', OBJECT: 'METH', OBJ_NAME: 'ZCL_ONE' })
        ]));

        expect(names).toEqual(['ZREPORT_ONE']);
        expect(prefixes[0]).toBe('ZCL_ONE'.padEnd(30, '='));
        expect(inactiveSourceQueries(names, prefixes).every(query => query.length <= MAX_QUERY_CHARS)).toBe(true);
    });

    it('sorts the dictionary names by the table that records their state', () => {
        const ddic = ddicNames(objectParts([
            entry({ OBJECT: 'TABL', OBJ_NAME: 'ZTABLE_ONE' }),
            entry({ OBJECT: 'DTEL', OBJ_NAME: 'ZELEMENT' }),
            entry({ OBJECT: 'DOMA', OBJ_NAME: 'ZDOMAIN' })
        ]));

        expect(ddic).toEqual({ tables: ['ZTABLE_ONE'], dataElements: ['ZELEMENT'], domains: ['ZDOMAIN'] });
    });

    it('reads a class part back as a name that can be recognised', () => {
        const [inactive] = inactiveSources([
            { PROGNAME: `ZCL_ONE${'='.repeat(23)}CCIMP`, R3STATE: 'I', UNAM: 'TESTER', UDAT: new Date('2026-09-10T00:00:00Z') }
        ]);

        expect(inactive.name).toBe('ZCL_ONE CCIMP');
        expect(inactive.changedAt).toBe('2026-09-10');
    });
});

describe('the verdict before a release', () => {
    const base = {
        request: describeRequest(row(), new Map()),
        tasks: [],
        objects: objectParts([entry()]),
        conflicts: [],
        inactive: [],
        locks: [],
        activationChecked: true
    };

    it('is ready when every check passes', () => {
        const verdict = readinessVerdict(base);
        expect(verdict.ready).toBe(true);
        expect(verdict.checks.map(check => check.check)).toEqual(
            ['status', 'tasks', 'objects', 'conflicts', 'activation', 'locks']
        );
    });

    it('is not ready while a task under it is open, and says which', () => {
        const verdict = readinessVerdict({
            ...base,
            tasks: [describeRequest(row({ TRKORR: 'DEVK900002', TRFUNCTION: 'S' }), new Map())]
        });

        expect(verdict.ready).toBe(false);
        expect(verdict.checks.find(check => check.check === 'tasks')?.detail).toMatch(/DEVK900002/);
    });

    it('is not ready with an empty request, a conflict, an inactive object or a lock', () => {
        expect(readinessVerdict({ ...base, objects: [] }).ready).toBe(false);
        expect(readinessVerdict({
            ...base,
            conflicts: [{
                object: 'ZREPORT_ONE', pgmid: 'R3TR', type: 'PROG', otherRequest: 'DEVK900009',
                owner: 'OTHER', status: 'D', statusText: 'modifiable'
            }]
        }).ready).toBe(false);
        expect(readinessVerdict({ ...base, inactive: [{ name: 'ZREPORT_ONE', where: 'REPOSRC' }] }).ready).toBe(false);
        expect(readinessVerdict({ ...base, locks: ['/sap/bc/adt/programs/programs/zreport_one'] }).ready).toBe(false);
    });

    it('says the activation was not checked rather than passing it silently', () => {
        const verdict = readinessVerdict({ ...base, activationChecked: false });
        expect(verdict.checks.find(check => check.check === 'activation')?.detail).toBe('not checked');
    });
});

describe('the tools themselves', () => {
    const client = (over: any = {}) => {
        const answers = new Map<RegExp, any[]>([
            [/FROM e070/, [row()]],
            [/FROM e07t/, [{ TRKORR: 'DEVK900001', AS4TEXT: 'a change' }]],
            [/FROM e071/, [entry()]],
            [/FROM reposrc/, []],
            [/FROM dd0/, []]
        ]);
        return {
            statelessClone: {
                runQuery: async (sql: string) => {
                    for (const [pattern, values] of answers) if (pattern.test(sql)) return { values };
                    return { values: [] };
                },
                ...over
            }
        } as any;
    };

    it('answers the transport history of an object', async () => {
        const result = answer(await new TransportHandlers(client()).handleObjectTransports({ objectName: 'ZREPORT_ONE' }));

        expect(result.found).toBe(true);
        expect(result.summary.requests).toBe(1);
        expect(result.requests[0]).toMatchObject({ number: 'DEVK900001', description: 'a change' });
    });

    it('says an object travels in no transport at all', async () => {
        const empty = { statelessClone: { runQuery: async () => ({ values: [] }) } } as any;
        const result = answer(await new TransportHandlers(empty).handleObjectTransports({ objectName: 'ZLOCAL_ONE' }));

        expect(result.found).toBe(false);
        expect(result.hint).toMatch(/\$TMP/);
    });

    it('refuses an object name that is not one', async () => {
        await expect(new TransportHandlers(client()).handleObjectTransports({ objectName: "X' OR '1'='1" }))
            .rejects.toThrow(/not a repository object name/);
    });

    it('refuses a request number that does not exist', async () => {
        const empty = { statelessClone: { runQuery: async () => ({ values: [] }) } } as any;
        await expect(new TransportHandlers(empty).handleTransportReadiness({ transport: 'DEVK900999' }))
            .rejects.toThrow(/No transport request or task/);
    });

    it('checks a request and answers with a verdict per check', async () => {
        const result = answer(await new TransportHandlers(client()).handleTransportReadiness({ transport: 'DEVK900001' }));

        expect(result.request).toBe('DEVK900001');
        expect(Array.isArray(result.checks)).toBe(true);
        expect(result.objects).toEqual({ total: 1, examined: 1, skipped: 0 });
    });
});

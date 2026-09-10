import { parseTraceStatements, capTraceEntries } from '../lib/traceRead';
import { TraceHandlers } from '../handlers/TraceHandlers';

/**
 * Reading a trace, once one was finally recorded in a state the backend would
 * serve. Two things that run established:
 *
 * - the library's statement codec declares `callingProgram` mandatory, and two
 *   of 8051 statements in an ordinary trace are entry points that carry none,
 *   which lost the other 8049;
 * - the same trace answered 7.5 MB of statements and 1.5 MB of hit list, so
 *   both are capped here rather than thrown away whole by the response guard.
 *
 * The fixture keeps one statement of each kind: with a caller and without.
 */
const STATEMENTS = `<?xml version="1.0" encoding="utf-8"?>
<trc:statements withDetails="false" withSysEvents="false" m:count="3"
  xmlns:trc="http://www.sap.com/adt/runtime/traces/abaptraces"
  xmlns:m="http://schema.microsoft.com/ado/2007/08/dataservices/metadata">
  <atom:link rel="parent" href="/sap/bc/adt/runtime/traces/abaptraces/host_sid_00%2cAT000009" xmlns:atom="http://www.w3.org/2005/Atom"/>
  <trc:statement index="1" id="1" description="Runtime analysis" hitCount="1" callerId="1" callLevel="0" hitlistAnchor="1">
    <trc:callingProgram adtcore:context="SAPLHTTP_RUNTIME" byteCodeOffset="3634" adtcore:type="FUGR/I" adtcore:name="LHTTP_RUNTIMEU07" xmlns:adtcore="http://www.sap.com/adt/core"/>
    <trc:grossTime time="4703037" percentage="100.0"/>
    <trc:traceEventNetTime time="44" percentage="0.0009"/>
    <trc:proceduralNetTime time="44" percentage="0.0009"/>
  </trc:statement>
  <trc:statement index="2" id="2" description="Program RS_CALL_PROGRAMM" hitCount="1" callerId="1" callLevel="1" hitlistAnchor="2">
    <trc:grossTime time="7544" percentage="0.1604"/>
    <trc:traceEventNetTime time="2202" percentage="0.0468"/>
    <trc:proceduralNetTime time="2423" percentage="0.0515"/>
  </trc:statement>
  <trc:statement index="3" id="3" description="Call Function CONVERSION_EXIT" hitCount="4" callerId="2" callLevel="2" hitlistAnchor="3">
    <trc:callingProgram adtcore:context="SAPLSCNT" byteCodeOffset="12" adtcore:type="FUGR/I" adtcore:name="LSCNTU01" xmlns:adtcore="http://www.sap.com/adt/core"/>
    <trc:grossTime time="900000" percentage="19.1"/>
    <trc:traceEventNetTime time="120" percentage="0.0025"/>
    <trc:proceduralNetTime time="120" percentage="0.0025"/>
  </trc:statement>
</trc:statements>`;

const HIT_LIST = {
  parentLink: '/sap/bc/adt/runtime/traces/abaptraces/host_sid_00%2cAT000009',
  entries: [
    { index: 1, description: 'first', grossTime: { time: 10, percentage: 1 } },
    { index: 2, description: 'heaviest', grossTime: { time: 900, percentage: 90 } },
    { index: 3, description: 'third', grossTime: { time: 90, percentage: 9 } }
  ]
};

const answer = (result: any) => JSON.parse(result.content[0].text);

const handler = (over: { body?: string; hitList?: unknown } = {}) => {
  const calls: { url: string; options: any }[] = [];
  const client = {
    username: 'TESTER',
    tracesHitList: async () => over.hitList ?? HIT_LIST,
    httpClient: {
      request: async (url: string, options: any) => {
        calls.push({ url, options });
        return { body: over.body ?? STATEMENTS, headers: {} };
      }
    }
  };
  return { handlers: new TraceHandlers(client as any), calls };
};

describe('parseTraceStatements', () => {
  it('keeps a statement that has no calling program', () => {
    const parsed = parseTraceStatements(STATEMENTS);
    expect(parsed.total).toBe(3);
    expect(parsed.entries[1].callingProgram).toBeUndefined();
    expect(parsed.entries[0].callingProgram).toMatchObject({ name: 'LHTTP_RUNTIMEU07' });
  });

  it('reports the count and the parent the backend gave', () => {
    const parsed = parseTraceStatements(STATEMENTS);
    expect(parsed.count).toBe(3);
    expect(parsed.parentLink).toContain('AT000009');
  });

  it('reads the times off a statement', () => {
    const [first] = parseTraceStatements(STATEMENTS).entries;
    expect(first).toMatchObject({
      index: 1,
      description: 'Runtime analysis',
      grossTime: { time: 4703037, percentage: 100 }
    });
  });

  it('keeps the call sequence unless asked for the heavy end', () => {
    expect(parseTraceStatements(STATEMENTS).entries.map(s => s.index)).toEqual([1, 2, 3]);
    expect(parseTraceStatements(STATEMENTS, { heaviestFirst: true }).entries.map(s => s.index))
      .toEqual([1, 3, 2]);
  });
});

describe('capTraceEntries', () => {
  it('says how it ordered what it reported', () => {
    expect(capTraceEntries(HIT_LIST.entries).order).toBe('call sequence');
    expect(capTraceEntries(HIT_LIST.entries, { heaviestFirst: true }).order)
      .toBe('gross time, longest first');
  });

  it('caps and counts, and points at the option that helps', () => {
    const capped = capTraceEntries(HIT_LIST.entries, { limit: 1 });
    expect(capped).toMatchObject({ total: 3, returned: 1, truncated: true });
    expect(capped.hint).toContain('heaviestFirst');
  });

  it('takes the longest first when sorting was asked for', () => {
    const capped = capTraceEntries(HIT_LIST.entries, { limit: 1, heaviestFirst: true });
    expect((capped.entries[0] as any).description).toBe('heaviest');
  });

  it('leaves the array it was given in the order it came', () => {
    const entries = [...HIT_LIST.entries];
    capTraceEntries(entries, { heaviestFirst: true });
    expect(entries.map(entry => entry.index)).toEqual([1, 2, 3]);
  });
});

describe('tracesStatements', () => {
  it('asks the backend itself, with the call-tree content type', async () => {
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleTracesStatements({
      id: '/sap/bc/adt/runtime/traces/abaptraces/host_sid_00%2cAT000009'
    }));
    expect(calls[0].url).toBe('/sap/bc/adt/runtime/traces/abaptraces/host_sid_00%2cAT000009/statements');
    expect(calls[0].options.headers.Accept).toContain('aggcalltree');
    expect(result).toMatchObject({ status: 'success', total: 3, returned: 3 });
  });

  it('builds the URL from a bare trace id', async () => {
    const { handlers, calls } = handler();
    await handlers.handleTracesStatements({ id: 'host_sid_00%2cAT000009' });
    expect(calls[0].url).toBe('/sap/bc/adt/runtime/traces/abaptraces/host_sid_00%2cAT000009/statements');
  });

  it('passes the query options on to the backend', async () => {
    const { handlers, calls } = handler();
    await handlers.handleTracesStatements({ id: 'x', options: '{"withDetails":true}' });
    expect(calls[0].options.qs).toEqual({ withDetails: true });
  });
});

describe('tracesHitList', () => {
  it('caps the entries and keeps the parent link', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTracesHitList({ id: 'x', limit: 2 }));
    expect(result).toMatchObject({ status: 'success', total: 3, returned: 2, truncated: true });
    expect(result.parentLink).toContain('AT000009');
  });

  it('reports the longest first when asked', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTracesHitList({ id: 'x', limit: 1, heaviestFirst: true }));
    expect(result.entries[0].description).toBe('heaviest');
  });
});

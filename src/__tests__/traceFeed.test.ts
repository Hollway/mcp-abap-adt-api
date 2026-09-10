import { parseTraceFeed, normaliseTraceConfig } from '../lib/traceFeed';
import { TraceHandlers } from '../handlers/TraceHandlers';

/**
 * The trace list is parsed here instead of by the library, because the
 * library's codec declares the atom title mandatory and SAP only writes one for
 * a trace that was given a description. A live ECC run held twenty traces and
 * exactly one title, so the codec failed the whole call after the backend had
 * already answered correctly.
 *
 * The feed below is that answer, cut down to two entries: one without a title,
 * one with.
 */
const FEED = `<?xml version="1.0" encoding="utf-8"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:trc="http://www.sap.com/adt/runtime/traces/abaptraces">
  <atom:author><atom:name>ALFEUD11</atom:name></atom:author>
  <atom:contributor><atom:name>EUD</atom:name></atom:contributor>
  <atom:title>ABAP Traces</atom:title>
  <atom:updated>2026-09-10T11:34:29Z</atom:updated>
  <atom:entry xml:lang="RU">
    <atom:author><atom:name>TESTER</atom:name><atom:uri>http://example/TESTER</atom:uri></atom:author>
    <atom:content type="application/vnd.sap.adt.runtime.traces.abaptraces.hitlist+xml" src="/sap/bc/adt/runtime/traces/abaptraces/alfeud11_eud_00%2cAT000007/hitlist"/>
    <atom:id>/sap/bc/adt/runtime/traces/abaptraces/alfeud11_eud_00%2cAT000007</atom:id>
    <atom:link href="/sap/bc/adt/runtime/traces/abaptraces/alfeud11_eud_00%2cAT000007" rel="self" type="application/atom+xml;type=entry" title="Trace file"/>
    <atom:link href="/sap/bc/adt/runtime/traces/abaptraces/alfeud11_eud_00%2cAT000007" rel="http://www.sap.com/adt/relations/delete" type="text/plain" title="Delete"/>
    <atom:published>2026-09-10T11:34:31Z</atom:published>
    <atom:updated>2026-09-10T11:34:31Z</atom:updated>
    <trc:extendedData>
      <trc:host>alfeud11</trc:host>
      <trc:size>13</trc:size>
      <trc:runtime>8227698</trc:runtime>
      <trc:runtimeABAP>110097</trc:runtimeABAP>
      <trc:runtimeSystem>325</trc:runtimeSystem>
      <trc:runtimeDatabase>8117276</trc:runtimeDatabase>
      <trc:expiration>2026-10-08T11:34:31Z</trc:expiration>
      <trc:system>EUD</trc:system>
      <trc:client>102</trc:client>
      <trc:isAggregated>true</trc:isAggregated>
      <trc:aggregationKind>byCallPosition</trc:aggregationKind>
      <trc:objectName>ZDEV_TRACE_TEST</trc:objectName>
      <trc:state value="E" text="Errors"/>
    </trc:extendedData>
  </atom:entry>
  <atom:entry xml:lang="RU">
    <atom:author><atom:name>TESTER</atom:name><atom:uri>http://example/TESTER</atom:uri></atom:author>
    <atom:content type="application/vnd.sap.adt.runtime.traces.abaptraces.hitlist+xml" src="/sap/bc/adt/runtime/traces/abaptraces/alfeud11_eud_00%2cAT000003/hitlist"/>
    <atom:id>/sap/bc/adt/runtime/traces/abaptraces/alfeud11_eud_00%2cAT000003</atom:id>
    <atom:link href="/sap/bc/adt/runtime/traces/abaptraces/alfeud11_eud_00%2cAT000003" rel="self" type="application/atom+xml;type=entry" title="Trace file"/>
    <atom:published>2026-09-09T14:37:46Z</atom:published>
    <atom:title>DEFAULT</atom:title>
    <atom:updated>2026-09-09T14:37:46Z</atom:updated>
    <trc:extendedData>
      <trc:host>alfeud11</trc:host>
      <trc:size>34</trc:size>
      <trc:runtime>5321045</trc:runtime>
      <trc:expiration>2026-10-07T14:37:46Z</trc:expiration>
      <trc:system>EUD</trc:system>
      <trc:client>102</trc:client>
      <trc:isAggregated>true</trc:isAggregated>
      <trc:objectName></trc:objectName>
      <trc:state value="A" text="Active"/>
    </trc:extendedData>
  </atom:entry>
</atom:feed>`;

const answer = (result: any) => JSON.parse(result.content[0].text);

const handler = (body: string = FEED) => {
  const calls: { url: string; options: any }[] = [];
  const client = {
    username: 'TESTER',
    httpClient: {
      request: async (url: string, options: any) => {
        calls.push({ url, options });
        return { body, headers: {} };
      }
    }
  };
  return { handlers: new TraceHandlers(client as any), calls };
};

describe('parseTraceFeed', () => {
  it('keeps a trace that carries no title', () => {
    const feed = parseTraceFeed(FEED);
    expect(feed.total).toBe(2);
    expect(feed.runs[0].title).toBe('');
    expect(feed.runs[1].title).toBe('DEFAULT');
  });

  it('reports the fields a caller reads a trace by', () => {
    const [run] = parseTraceFeed(FEED).runs;
    expect(run.id).toBe('/sap/bc/adt/runtime/traces/abaptraces/alfeud11_eud_00%2cAT000007');
    expect(run.author).toBe('TESTER');
    expect(run.extendedData).toMatchObject({
      objectName: 'ZDEV_TRACE_TEST',
      runtime: 8227698,
      client: 102,
      state: { value: 'E', text: 'Errors' }
    });
  });

  it('drops the atom links unless they are asked for', () => {
    expect(parseTraceFeed(FEED).runs[0].links).toBeUndefined();
    expect(parseTraceFeed(FEED, { includeLinks: true }).runs[0].links).toHaveLength(2);
  });

  it('caps the runs but counts them all', () => {
    const feed = parseTraceFeed(FEED, { limit: 1 });
    expect(feed).toMatchObject({ total: 2, returned: 1 });
    expect(feed.runs).toHaveLength(1);
  });

  it('answers an empty feed with no runs rather than failing', () => {
    const empty = `<?xml version="1.0" encoding="utf-8"?>
      <atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>ABAP Traces</atom:title></atom:feed>`;
    expect(parseTraceFeed(empty)).toMatchObject({ total: 0, returned: 0, runs: [] });
  });
});

describe('tracesList', () => {
  it('reads the feed itself and reports the user it asked for', async () => {
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleTracesList({}));
    expect(calls[0].url).toBe('/sap/bc/adt/runtime/traces/abaptraces');
    expect(calls[0].options.qs).toEqual({ user: 'TESTER' });
    expect(result).toMatchObject({ status: 'success', user: 'TESTER', total: 2, returned: 2 });
  });

  it('uppercases the user it was given', async () => {
    const { handlers, calls } = handler();
    await handlers.handleTracesList({ user: 'someone' });
    expect(calls[0].options.qs).toEqual({ user: 'SOMEONE' });
  });

  it('says so when it reported fewer runs than it found', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTracesList({ limit: 1 }));
    expect(result).toMatchObject({ total: 2, returned: 1, truncated: true });
    expect(result.hint).toContain('1 of 2');
  });
});

describe('normaliseTraceConfig', () => {
  const base = {
    description: 'probe',
    traceUser: 'TESTER',
    traceClient: '102',
    processType: 'ANY',
    objectType: 'ANY',
    maximalExecutions: 1
  };

  it('makes a bare parameters id into the URI the backend wants', () => {
    const config = normaliseTraceConfig({ ...base, parametersId: '005056A2C8B31FD1AB9F58E87F9E0000' });
    expect(config.parametersId).toBe(
      '/sap/bc/adt/runtime/traces/abaptraces/parameters/005056A2C8B31FD1AB9F58E87F9E0000'
    );
  });

  it('leaves a parameters id that is already a URI alone', () => {
    const uri = '/sap/bc/adt/runtime/traces/abaptraces/parameters/ABC';
    expect(normaliseTraceConfig({ ...base, parametersId: uri }).parametersId).toBe(uri);
  });

  it('makes a plain date into the full timestamp the backend wants', () => {
    expect(normaliseTraceConfig({ ...base, expires: '2026-09-11' }).expires)
      .toBe('2026-09-11T00:00:00.000Z');
  });

  it('names the field when the date cannot be read', () => {
    expect(() => normaliseTraceConfig({ ...base, expires: 'tomorrow' })).toThrow(/expires is not a date/);
  });
});

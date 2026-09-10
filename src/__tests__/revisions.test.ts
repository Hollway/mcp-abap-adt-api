import { RevisionHandlers, revisionNumberOf } from '../handlers/RevisionHandlers';

/**
 * Shaped exactly like what ECC answers for ZCL_APP: the "version" field is the
 * transport request, the version number is only in the content URI, and most
 * rows of a long history are copies left behind by transport releases.
 */
const RAW = [
  {
    uri: '/sap/bc/adt/oo/classes/zcl_app/includes/main/versions/20260908074012/00090/content',
    version: 'DEVK9A3OK8',
    versionTitle: 'TASK-1001 ZAPPO_NEW правка отчёта',
    date: '2026-09-08T07:40:12Z',
    author: 'TESTER'
  },
  {
    uri: '/sap/bc/adt/oo/classes/zcl_app/includes/main/versions/20260908074012/00089/content',
    version: 'DEVK9A3OL9',
    versionTitle: 'Копия DEVK9A3OK8 TASK-1001',
    date: '2026-09-07T11:07:46Z',
    author: 'TESTER'
  },
  {
    uri: '/sap/bc/adt/oo/classes/zcl_app/includes/main/versions/20260908074012/00088/content',
    version: 'DEVK9A3NT8',
    versionTitle: 'TASK-1002 Новый интерфейс',
    date: '2026-08-27T07:19:44Z',
    author: 'ABELICHENKO'
  }
];

const SOURCES: Record<string, string> = {
  '/sap/bc/adt/oo/classes/zcl_app/includes/main/versions/20260908074012/00090/content':
    'CLASS zcl_app DEFINITION.\r\n  METHOD new.\r\n  ENDMETHOD.\r\nENDCLASS.\r\n',
  '/sap/bc/adt/oo/classes/zcl_app/includes/main/versions/20260908074012/00089/content':
    'CLASS zcl_app DEFINITION.\r\nENDCLASS.\r\n',
  '/sap/bc/adt/oo/classes/zcl_app/includes/main/versions/20260908074012/00088/content':
    'CLASS zcl_app DEFINITION.\r\nENDCLASS.\r\n',
  '/sap/bc/adt/oo/classes/zcl_app/source/main:active': 'CLASS zcl_app DEFINITION.\r\nENDCLASS.\r\n',
  '/sap/bc/adt/oo/classes/zcl_app/source/main:inactive':
    'CLASS zcl_app DEFINITION.\r\n  METHOD draft.\r\n  ENDMETHOD.\r\nENDCLASS.\r\n',
  '/sap/bc/adt/oo/classes/zcl_app/includes/testclasses/source/main:active': 'CLASS ltcl_x.\r\n'
};

const handlers = (over: Record<string, unknown> = {}) => {
  const reads: string[] = [];
  const client = {
    revisions: async (url: string, include?: string) => {
      reads.push(`revisions:${url}:${include || ''}`);
      return RAW;
    },
    getObjectSource: async (url: string, options?: any) => {
      const key = options?.version ? `${url}:${options.version}` : url;
      reads.push(`source:${key}`);
      if (!(key in SOURCES)) throw new Error(`no source stubbed for ${key}`);
      return SOURCES[key];
    },
    ...over
  };
  return { handler: new RevisionHandlers(client as any), reads };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

describe('revisionNumberOf', () => {
  it('takes the number out of a content URI', () => {
    expect(revisionNumberOf(RAW[0].uri)).toBe('00090');
    expect(revisionNumberOf('/sap/bc/adt/oo/classes/zcl_app')).toBe('');
  });
});

describe('revisions', () => {
  it('addresses the object by name and type', async () => {
    const { handler, reads } = handlers();
    const result = answer(await handler.handleRevisions({ objectName: 'zcl_app', objectType: 'CLAS/OC' }));
    expect(reads[0]).toBe('revisions:/sap/bc/adt/oo/classes/zcl_app:');
    expect(result.object).toBe('ZCL_APP (CLAS/OC)');
    expect(result.revisions[0]).toMatchObject({
      revision: '00090',
      transport: 'DEVK9A3OK8',
      author: 'TESTER'
    });
  });

  it('still takes a raw object URL', async () => {
    const { handler, reads } = handlers();
    await handler.handleRevisions({ objectUrl: '/sap/bc/adt/programs/programs/zr_app_foo' });
    expect(reads[0]).toBe('revisions:/sap/bc/adt/programs/programs/zr_app_foo:');
  });

  it('says which object it wants when neither name nor url is given', async () => {
    const { handler } = handlers();
    await expect(handler.handleRevisions({})).rejects.toThrow(/Pass objectName .* or objectUrl/);
  });

  it('refuses a type it cannot address rather than inventing a URL', async () => {
    const { handler } = handlers();
    await expect(handler.handleRevisions({ objectName: 'ZAPP_DOM', objectType: 'DOMA/DD' }))
      .rejects.toThrow(/No ADT URL is known for a DOMA\/DD/);
  });

  it('caps the list and says how much it held back', async () => {
    const { handler } = handlers();
    const result = answer(await handler.handleRevisions({ objectName: 'zcl_app', limit: 2 }));
    expect(result).toMatchObject({ total: 3, returned: 2 });
    expect(result.note).toMatch(/newest 2 of 3/);
  });

  it('returns everything when limit is 0', async () => {
    const { handler } = handlers();
    const result = answer(await handler.handleRevisions({ objectName: 'zcl_app', limit: 0 }));
    expect(result.returned).toBe(3);
    expect(result.note).toBeUndefined();
  });

  it('filters by author, transport and description', async () => {
    const { handler } = handlers();
    const byAuthor = answer(await handler.handleRevisions({ objectName: 'zcl_app', author: 'abelichenko' }));
    expect(byAuthor).toMatchObject({ total: 3, matched: 1 });
    expect(byAuthor.revisions[0].revision).toBe('00088');

    const byTransport = answer(await handler.handleRevisions({ objectName: 'zcl_app', transport: 'devk9a3ok8' }));
    expect(byTransport.revisions.map((r: any) => r.revision)).toEqual(['00090']);

    const byTitle = answer(await handler.handleRevisions({ objectName: 'zcl_app', titleContains: 'копия' }));
    expect(byTitle.revisions.map((r: any) => r.revision)).toEqual(['00089']);
  });

  it('passes a class include through and reports it', async () => {
    const { handler, reads } = handlers();
    const result = answer(await handler.handleRevisions({ objectName: 'zcl_app', clsInclude: 'TestClasses' }));
    expect(reads[0]).toBe('revisions:/sap/bc/adt/oo/classes/zcl_app:testclasses');
    expect(result.clsInclude).toBe('testclasses');
  });

  it('names the includes it accepts', async () => {
    const { handler } = handlers();
    await expect(handler.handleRevisions({ objectName: 'zcl_app', clsInclude: 'body' }))
      .rejects.toThrow(/definitions, implementations, macros, testclasses, main/);
  });
});

describe('compareRevisions', () => {
  it('compares the two newest versions by default', async () => {
    const { handler } = handlers();
    const result = answer(await handler.handleCompareRevisions({ objectName: 'zcl_app' }));
    expect(result.from).toMatchObject({ kind: 'revision', revision: '00089' });
    expect(result.to).toMatchObject({ kind: 'revision', revision: '00090', transport: 'DEVK9A3OK8' });
    expect(result.summary).toMatchObject({ identical: false, linesAdded: 2, linesRemoved: 0 });
    expect(result.diff).toContain('+  METHOD new.');
    expect(result.diff).toContain('--- revision 00089 (DEVK9A3OL9)');
  });

  it('takes a revision number, padded or not', async () => {
    const { handler } = handlers();
    const result = answer(await handler.handleCompareRevisions({
      objectName: 'zcl_app', from: '88', to: '00090'
    }));
    expect(result.from.revision).toBe('00088');
    expect(result.to.revision).toBe('00090');
  });

  it('takes a transport request as a side', async () => {
    const { handler } = handlers();
    const result = answer(await handler.handleCompareRevisions({
      objectName: 'zcl_app', from: 'devk9a3nt8', to: 'latest'
    }));
    expect(result.from).toMatchObject({ revision: '00088', transport: 'DEVK9A3NT8' });
    expect(result.to.revision).toBe('00090');
  });

  // The edit that is written but not yet activated - the one comparison the
  // version history cannot show.
  it('compares the active version with the inactive one', async () => {
    const { handler, reads } = handlers();
    const result = answer(await handler.handleCompareRevisions({
      objectName: 'zcl_app', from: 'active', to: 'inactive'
    }));
    expect(reads).toContain('source:/sap/bc/adt/oo/classes/zcl_app/source/main:active');
    expect(reads).toContain('source:/sap/bc/adt/oo/classes/zcl_app/source/main:inactive');
    expect(result.from).toEqual({ kind: 'version', version: 'active' });
    expect(result.summary).toMatchObject({ linesAdded: 2, linesRemoved: 0 });
  });

  it('reads a class include from its own source url', async () => {
    const { handler, reads } = handlers();
    await handler.handleCompareRevisions({
      objectName: 'zcl_app', clsInclude: 'testclasses', from: 'active', to: 'active'
    });
    expect(reads).toContain('source:/sap/bc/adt/oo/classes/zcl_app/includes/testclasses/source/main:active');
  });

  it('reports two identical versions as identical', async () => {
    const { handler } = handlers();
    const result = answer(await handler.handleCompareRevisions({
      objectName: 'zcl_app', from: '00088', to: '00089'
    }));
    expect(result.summary).toMatchObject({ identical: true, linesAdded: 0, linesRemoved: 0 });
    expect(result.diff).toBe('');
  });

  it('refuses a side that is in no version of this object', async () => {
    const { handler } = handlers();
    await expect(handler.handleCompareRevisions({ objectName: 'zcl_app', to: 'DEVK9NOSUCH' }))
      .rejects.toThrow(/neither a revision number nor a transport/);
  });

  it('asks for explicit sides when the history is too short to default', async () => {
    const { handler } = handlers({ revisions: async () => [RAW[0]] });
    await expect(handler.handleCompareRevisions({ objectName: 'zcl_app' }))
      .rejects.toThrow(/too few to compare by default/);
  });

  // A transport release leaves a copy version with the same text, so on a busy
  // object the two newest are often identical - which must not read as "the
  // last change did nothing".
  it('explains an identical default comparison', async () => {
    const { handler } = handlers({
      getObjectSource: async () => 'CLASS zcl_app DEFINITION.\r\nENDCLASS.\r\n'
    });
    const result = answer(await handler.handleCompareRevisions({ objectName: 'zcl_app' }));
    expect(result.summary.identical).toBe(true);
    expect(result.note).toMatch(/transport release leaves a copy version/);
  });

  it('does not explain away an identical comparison the caller asked for', async () => {
    const { handler } = handlers();
    const result = answer(await handler.handleCompareRevisions({
      objectName: 'zcl_app', from: '00088', to: '00089'
    }));
    expect(result.summary.identical).toBe(true);
    expect(result.note).toBeUndefined();
  });

  it('cuts an oversized diff off and keeps the summary', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `  line ${i}`).join('\r\n');
    const { handler } = handlers({
      getObjectSource: async (url: string) => (url.endsWith('00090/content') ? long : 'CLASS zcl_app DEFINITION.')
    });
    const result = answer(await handler.handleCompareRevisions({ objectName: 'zcl_app', maxDiffChars: 1000 }));
    expect(result.diffTruncated).toBe(true);
    expect(result.diff.length).toBe(1000);
    expect(result.summary.linesAdded).toBe(400);
  });
});

/**
 * ZCL_APP has 91 versions of its main include and answers "Revision URL not
 * found for object ZCL_APP" for testclasses - which reads as if the class had
 * no history at all. Found on ECC.
 */
describe('an include with no history', () => {
  const structure = {
    includes: [
      { 'class:includeType': 'main', links: [{ rel: 'http://www.sap.com/adt/relations/versions' }] },
      { 'class:includeType': 'definitions', links: [{ rel: 'http://www.sap.com/adt/relations/versions' }] },
      { 'class:includeType': 'testclasses', links: [{ rel: 'http://www.sap.com/adt/relations/source' }] }
    ]
  };

  it('says which includes do have one', async () => {
    const { handler } = handlers({
      revisions: async () => { throw new Error('Revision URL not found for object ZCL_APP'); },
      objectStructure: async () => structure
    });
    await expect(handler.handleRevisions({ objectName: 'zcl_app', clsInclude: 'testclasses' }))
      .rejects.toThrow(/testclasses include of ZCL_APP \(CLAS\/OC\) has no version history\. These do: main, definitions\./);
  });

  it('still reports the object when the structure cannot be read either', async () => {
    const { handler } = handlers({
      revisions: async () => { throw new Error('Revision URL not found for object ZCL_APP'); },
      objectStructure: async () => { throw new Error('no structure'); }
    });
    await expect(handler.handleRevisions({ objectName: 'zcl_app' }))
      .rejects.toThrow(/has no version history/);
  });

  it('leaves any other failure alone', async () => {
    const { handler } = handlers({
      revisions: async () => { throw new Error('session expired'); }
    });
    await expect(handler.handleRevisions({ objectName: 'zcl_app' })).rejects.toThrow(/session expired/);
  });
});

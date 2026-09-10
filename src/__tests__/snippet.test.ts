import {
  buildSnippetClass,
  snippetClassName,
  snippetOutput,
  summariseDump,
  SnippetError
} from '../lib/snippet';
import { SnippetHandlers } from '../handlers/SnippetHandlers';
import { MUTATING_TOOLS } from '../lib/toolClasses';
import { lockRegistry } from '../lib/lockRegistry';

/**
 * IF_OO_ADT_CLASSRUN on this system (package SEO_ADT) declares
 *   METHODS main IMPORTING out TYPE REF TO if_oo_adt_intrnl_classrun.
 * so the wrapper implements if_oo_adt_classrun~main and the snippet writes to
 * `out`.
 */
describe('snippetClassName', () => {
  it('builds a short, dated name', () => {
    expect(snippetClassName('ZMCP_SNIP', 1788945255006)).toBe('ZMCP_SNIP_MTTVTD26');
  });

  it('refuses a name ABAP could not hold', () => {
    expect(() => snippetClassName('Z_A_VERY_LONG_PREFIX_INDEED_FOR_ABAP'))
      .toThrow(/longer than 30 characters/);
  });
});

describe('buildSnippetClass', () => {
  it('wraps the code in a class that runClass can execute', () => {
    const source = buildSnippetClass({
      className: 'zmcp_snip_test',
      code: ['DATA(lv_x) = 40 + 2.', 'out->write( lv_x ).']
    });
    expect(source.split(/\n/)).toEqual([
      'CLASS ZMCP_SNIP_TEST DEFINITION',
      '  PUBLIC',
      '  FINAL',
      '  CREATE PUBLIC .',
      '',
      '  PUBLIC SECTION.',
      '    INTERFACES if_oo_adt_classrun .',
      'ENDCLASS.',
      '',
      '',
      '',
      'CLASS ZMCP_SNIP_TEST IMPLEMENTATION.',
      '  METHOD if_oo_adt_classrun~main.',
      '    DATA(lv_x) = 40 + 2.',
      '    out->write( lv_x ).',
      '  ENDMETHOD.',
      'ENDCLASS.',
      ''
    ]);
  });

  it('puts declarations in a private section', () => {
    const source = buildSnippetClass({
      className: 'ZMCP_X',
      code: ['out->write( co_kind ).'],
      declarations: [`CONSTANTS co_kind TYPE char1 VALUE 'X'.`]
    });
    expect(source).toContain('  PRIVATE SECTION.');
    expect(source).toContain(`    CONSTANTS co_kind TYPE char1 VALUE 'X'.`);
  });

  it("keeps the caller's indentation", () => {
    const source = buildSnippetClass({
      className: 'ZMCP_X',
      code: ['LOOP AT lt_x INTO ls_x.', '  out->write( ls_x ).', 'ENDLOOP.']
    });
    expect(source).toContain('      out->write( ls_x ).');
  });

  it('insists on a name and on some code', () => {
    expect(() => buildSnippetClass({ className: '', code: ['x'] })).toThrow(/needs a name/);
    expect(() => buildSnippetClass({ className: 'ZMCP_X', code: [] })).toThrow(/Pass code/);
  });
});

describe('snippetOutput', () => {
  it('takes the console as it comes', () => {
    expect(snippetOutput('42')).toBe('42');
    expect(snippetOutput({ console: 'hello' })).toBe('hello');
    expect(snippetOutput({ output: 'hello' })).toBe('hello');
    expect(snippetOutput(undefined)).toBe('');
    expect(snippetOutput({ odd: 1 })).toBe('{"odd":1}');
  });
});

/** The header of a real dump page, as the feed serves it (ECC, trimmed). */
const DUMP_HTML = [
  '<p style="text-align:right;font-size:10px"><a href="adt://DEV/sap/bc/adt/vit/runtime/dumps/2026">Show in SAP GUI</a>',
  '<a title="Show Abortion in Code" href="adt://DEV/sap/bc/adt/oo/classes/zmcp_snip_x/source/main#start=16">Show Abortion in Code</a></p>',
  '<h4 id="HEADER">Header Information</h4><table cellspacing="3">',
  '<tr><td><b>Short Text</b></td><td> Division by 0 (type I or INT8) </td></tr>',
  '<tr><td><b>Runtime Error</b></td><td> COMPUTE_INT_ZERODIVIDE </td></tr>',
  '<tr><td><b>Exception</b></td><td> CX_SY_ZERODIVIDE </td></tr>',
  '<tr><td><b>Program</b></td><td> ZMCP_SNIP_X============CP </td></tr>',
  '<tr><td><b>Date/Time</b></td><td> 09.09.2026 12:42:07 (System) </td></tr>',
  '<tr><td><b>User</b></td><td> TESTER </td></tr></table>'
].join('');

const CREATED = {
  status: 'success',
  created: true,
  written: true,
  activated: true,
  objectUrl: '/sap/bc/adt/oo/classes/zmcp_snip_x',
  name: 'ZMCP_SNIP_X'
};

const handlers = (over: Record<string, unknown> = {}, created: Record<string, unknown> = CREATED) => {
  const calls: any[] = [];
  const client = {
    stateful: 'stateful',
    // createAndWrite runs through the registration handler, so the calls it
    // makes are stubbed rather than the handler itself.
    validateNewObject: async () => ({ success: true }),
    createObject: async () => { calls.push({ create: true }); },
    lock: async () => { calls.push({ lock: true }); return { LOCK_HANDLE: 'HANDLE' }; },
    setObjectSource: async (url: string, source: string) => { calls.push({ write: url, source }); },
    unLock: async () => { calls.push({ unlock: true }); },
    activate: async () => { calls.push({ activate: true }); return { success: true, messages: [], inactive: [] }; },
    inactiveObjects: async () => [],
    findObjectPath: async () => [],
    runClass: async (className: string) => { calls.push({ run: className }); return '42\n'; },
    deleteObject: async (url: string) => { calls.push({ delete: url }); },
    // A runtime error comes back as a bare 500; the reason is in the feed,
    // as the HTML page ST22 shows.
    dumps: async () => ({
      updated: '2026-09-09T12:00:00Z',
      dumps: [{ id: 'dump/one', text: DUMP_HTML, type: 'ABAP runtime error', author: 'TESTER' }]
    }),
    login: async () => { calls.push({ login: true }); },
    ...over
  };
  const handler = new SnippetHandlers(client as any);
  // The creation chain is proven by its own tests; here what matters is the
  // sequence around it, so it answers with a fixed result.
  (handler as any).registration = {
    handleCreateAndWrite: async (args: any) => {
      calls.push({ createAndWrite: args.name, packageName: args.packageName, source: args.source });
      return { content: [{ type: 'text', text: JSON.stringify(created) }] };
    }
  };
  return { handler, calls, client };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

beforeEach(() => lockRegistry.clear());

describe('runSnippet', () => {
  it('creates, runs, deletes, and returns what was printed', async () => {
    const { handler, calls } = handlers();
    const result = answer(await handler.handleRunSnippet({
      code: ['out->write( 42 ).'], className: 'ZMCP_SNIP_X'
    }));
    expect(calls.map(call => Object.keys(call)[0]))
      .toEqual(['createAndWrite', 'run', 'lock', 'delete', 'unlock']);
    expect(result).toMatchObject({ status: 'success', ran: true, output: '42\n' });
    expect(result.steps.map((step: any) => step.step)).toEqual(['create', 'run', 'delete']);
    // The creation report is condensed: 4,000 characters of nested steps are
    // not an answer to "what did the snippet print".
    expect(result.steps[0]).toEqual({
      step: 'create',
      created: true,
      written: true,
      activated: true,
      objectUrl: '/sap/bc/adt/oo/classes/zmcp_snip_x'
    });
  });

  it('creates it in $TMP unless told otherwise', async () => {
    const { handler, calls } = handlers();
    await handler.handleRunSnippet({ code: ['out->write( 1 ).'] });
    expect(calls[0].packageName).toBe('$TMP');
    expect(calls[0].createAndWrite).toMatch(/^ZMCP_SNIP_/);
  });

  it('leaves the class alone when asked to keep it', async () => {
    const { handler, calls } = handlers();
    const result = answer(await handler.handleRunSnippet({
      code: ['out->write( 1 ).'], className: 'ZMCP_SNIP_X', keepClass: true
    }));
    expect(calls.some(call => call.delete)).toBe(false);
    expect(result).toMatchObject({ kept: true, objectUrl: '/sap/bc/adt/oo/classes/zmcp_snip_x' });
  });

  it('shows the wrapper without touching the system on a dry run', async () => {
    const { handler, calls } = handlers();
    const result = answer(await handler.handleRunSnippet({
      code: ['out->write( 1 ).'], dryRun: true
    }));
    expect(calls).toEqual([]);
    expect(result.source).toContain('INTERFACES if_oo_adt_classrun .');
  });

  // A snippet that does not compile is the common case: the activation
  // messages are the answer, and the class must not stay behind.
  it('reports a snippet that would not activate, and removes the class', async () => {
    const { handler, calls } = handlers({}, {
      status: 'error',
      created: true,
      written: true,
      activated: false,
      steps: [{ step: 'activate', success: false, messages: [{ type: 'E', shortText: 'Field LV_Y is unknown', line: 14 }] }]
    });
    const result = answer(await handler.handleRunSnippet({
      code: ['out->write( lv_y ).'], className: 'ZMCP_SNIP_X'
    }));
    expect(result).toMatchObject({ status: 'error', ran: false });
    expect(result.source).toContain('out->write( lv_y ).');
    expect(calls.some(call => call.delete)).toBe(true);
    expect(result.steps[result.steps.length - 1]).toMatchObject({ step: 'delete', deleted: true });
    expect(result.steps[0].activationMessages).toEqual([
      { type: 'E', line: 14, text: 'Field LV_Y is unknown' }
    ]);
    expect(result.hint).toMatch(/not activated, so nothing ran/);
  });

  it('reports a dump as what the snippet did, and still deletes the class', async () => {
    const { handler, calls } = handlers({
      runClass: async () => { throw new Error('DIVIDE_BY_ZERO'); }
    });
    const result = answer(await handler.handleRunSnippet({
      code: ['DATA(lv_x) = 1 / 0.'], className: 'ZMCP_SNIP_X'
    }));
    expect(result).toMatchObject({ status: 'error', ran: false });
    expect(result.runError.error).toMatch(/DIVIDE_BY_ZERO/);
    // The dump feed carries what the bare 500 does not say.
    expect(result.runError.dump).toMatchObject({
      runtimeError: 'COMPUTE_INT_ZERODIVIDE',
      exception: 'CX_SY_ZERODIVIDE',
      shortText: 'Division by 0 (type I or INT8)',
      line: 16
    });
    expect(calls.some(call => call.delete)).toBe(true);
  });

  // A dump takes the session with it, so the delete that follows is refused
  // with a bare 400 - which is how snippet classes were left behind in $TMP.
  it('logs on again and deletes the class when the first attempt fails', async () => {
    let attempts = 0;
    const { handler, calls } = handlers({
      runClass: async () => { throw new Error('Request failed with status code 500'); },
      deleteObject: async (url: string) => {
        calls.push({ delete: url });
        if (++attempts === 1) throw new Error('Request failed with status code 400');
      }
    });
    const result = answer(await handler.handleRunSnippet({
      code: ['DATA(lv_c) = 1 / 0.'], className: 'ZMCP_SNIP_X'
    }));
    expect(calls.some(call => call.login)).toBe(true);
    expect(attempts).toBe(2);
    expect(result.steps.find((step: any) => step.step === 'delete'))
      .toMatchObject({ deleted: true, afterRelogin: true });
  });

  it('says so when the class could not be removed', async () => {
    const { handler } = handlers({
      deleteObject: async () => { throw new Error('object is locked elsewhere'); }
    });
    const result = answer(await handler.handleRunSnippet({
      code: ['out->write( 1 ).'], className: 'ZMCP_SNIP_X'
    }));
    // The run itself still succeeded, and the leftover is named.
    expect(result).toMatchObject({ status: 'success', ran: true });
    expect(result.steps.find((step: any) => step.step === 'delete'))
      .toMatchObject({
        deleted: false,
        error: expect.stringContaining('locked elsewhere'),
        hint: expect.stringContaining('deleteObject')
      });
  });

  it('insists on some code', async () => {
    const { handler } = handlers();
    await expect(handler.handleRunSnippet({})).rejects.toThrow(/Pass code/);
    await expect(handler.handleRunSnippet({ code: [] })).rejects.toThrow(/Pass code/);
  });

  it('takes the code as a JSON string too', async () => {
    const { handler, calls } = handlers();
    await handler.handleRunSnippet({ code: '["out->write( 1 )."]', className: 'ZMCP_SNIP_X' });
    expect(calls[0].source).toContain('    out->write( 1 ).');
  });

  it('counts as a writing tool: it executes code on the system', () => {
    expect(MUTATING_TOOLS.has('runSnippet')).toBe(true);
  });
});

describe('summariseDump', () => {
  it('takes six fields out of a ten-thousand-character page', () => {
    expect(summariseDump({ id: 'dump/one%20%20two', text: DUMP_HTML })).toEqual({
      shortText: 'Division by 0 (type I or INT8)',
      runtimeError: 'COMPUTE_INT_ZERODIVIDE',
      exception: 'CX_SY_ZERODIVIDE',
      program: 'ZMCP_SNIP_X============CP',
      when: '09.09.2026 12:42:07 (System)',
      user: 'TESTER',
      line: 16,
      id: 'dump/one two'
    });
  });

  it('answers nothing for no dump', () => {
    expect(summariseDump(undefined)).toBeUndefined();
  });
});

describe('SnippetError', () => {
  it('is an Error, so a handler can tell it from an ADT failure', () => {
    expect(new SnippetError('x')).toBeInstanceOf(Error);
  });
});

import { CallHandlers } from '../handlers/CallHandlers';
import { RESULT_MARKER, RESULT_END } from '../lib/asXml';

/**
 * callFunction and callMethod put together three things that already worked:
 * the signature, the generated call and runSnippet. What these tests hold in
 * place is the seam between them - that a mistake in the values is refused
 * before anything reaches the system, that the payload is read back into
 * values, and that a failure of the call is reported as a failure of the call
 * rather than of the tool.
 */

const FM_SOURCE = [
  'FUNCTION z_app_get_invoice',
  '  IMPORTING',
  '    VALUE(IV_LGNUM) TYPE LGNUM',
  '    VALUE(IV_DATE) TYPE DATS OPTIONAL',
  '  EXPORTING',
  '    VALUE(EV_COUNT) TYPE I',
  '  TABLES',
  '    ET_INVOICE STRUCTURE MARA',
  '  EXCEPTIONS',
  '    NOT_FOUND',
  '    NO_AUTHORITY.',
  '',
  '  ev_count = 1.',
  'ENDFUNCTION.'
].join('\n');

const CLASS_SOURCE = [
  'CLASS zcl_app DEFINITION PUBLIC FINAL CREATE PUBLIC .',
  '  PUBLIC SECTION.',
  '    CLASS-METHODS get_stawn',
  '      IMPORTING !iv_matnr TYPE matnr',
  '      RETURNING VALUE(rv_stawn) TYPE stawn.',
  '    METHODS do_it IMPORTING iv_a TYPE c.',
  '    METHODS if_x~run REDEFINITION.',
  'ENDCLASS.',
  'CLASS zcl_app IMPLEMENTATION.',
  'ENDCLASS.'
].join('\n');

const searchRow = {
  'adtcore:name': 'Z_APP_GET_INVOICE',
  'adtcore:type': 'FUGR/FF',
  'adtcore:uri': '/sap/bc/adt/functions/groups/zapp_invoice/fmodules/z_app_get_invoice',
  'adtcore:packageName': 'ZAPP_BASE'
};

/** A console output carrying an asXML payload the way the generated code does. */
const consoleWith = (values: string[]): string => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">',
    ' <asx:values>',
    ...values,
    ' </asx:values>',
    '</asx:abap>'
  ].join('\n');
  return `${RESULT_MARKER}\n${Buffer.from(xml, 'utf8').toString('base64')}\n${RESULT_END}`;
};

const okPayload = consoleWith([
  '<MCP_SUBRC>0</MCP_SUBRC>',
  '<MCP_EXCEPTION/>',
  '<MCP_MESSAGE/>',
  '<MCP_ROWS><item><NAME>ET_INVOICE</NAME><ROWS>2</ROWS></item></MCP_ROWS>',
  '<EV_COUNT>2</EV_COUNT>',
  '<ET_INVOICE><item><MATNR>4711</MATNR></item><item><MATNR>4712</MATNR></item></ET_INVOICE>'
]);

const handler = (over: { output?: string; run?: any; source?: string } = {}) => {
  const ran: any[] = [];
  const client = {
    stateful: 'stateless',
    searchObject: async () => [searchRow],
    getObjectSource: async (url: string) =>
      url.includes('/oo/classes/') ? (over.source ?? CLASS_SOURCE) : FM_SOURCE
  };
  const handlers = new CallHandlers(client as any);
  (handlers as any).snippets = {
    handleRunSnippet: async (args: any) => {
      ran.push(args);
      const answer = over.run ?? {
        status: 'success',
        ran: true,
        output: over.output ?? okPayload,
        steps: [{ step: 'create', activated: true }, { step: 'run', ran: true }]
      };
      return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
    }
  };
  return { handlers, ran };
};

const answer = (result: any) => JSON.parse(result.content[0].text);
const sourceOf = (ran: any[]) => (ran[0].code as string[]).join('\n');

describe('callFunction', () => {
  it('reads the signature, calls the module and returns its values by name', async () => {
    const { handlers, ran } = handler();
    const result = answer(await handlers.handleCallFunction({
      name: 'z_app_get_invoice',
      values: { IV_LGNUM: '101' }
    }));

    expect(result).toMatchObject({
      status: 'success',
      called: 'Z_APP_GET_INVOICE',
      functionGroup: 'ZAPP_INVOICE',
      ran: true,
      rolledBack: true,
      subrc: 0,
      supplied: ['IV_LGNUM'],
      values: {
        EV_COUNT: '2',
        ET_INVOICE: [{ MATNR: '4711' }, { MATNR: '4712' }]
      },
      rows: { ET_INVOICE: 2 }
    });
    expect(result.truncated).toBeUndefined();

    const generated = sourceOf(ran);
    expect(generated).toContain("CALL FUNCTION 'Z_APP_GET_INVOICE'");
    expect(generated).toContain('p_iv_lgnum = `101`.');
    expect(generated).toContain('ROLLBACK WORK.');
  });

  it('refuses an unknown parameter without sending anything to the system', async () => {
    const { handlers, ran } = handler();
    await expect(handlers.handleCallFunction({ name: 'Z_APP_GET_INVOICE', values: { IV_LGNUMM: '1' } }))
      .rejects.toThrow(/no parameter IV_LGNUMM/);
    expect(ran).toHaveLength(0);
  });

  it('refuses a call with a mandatory parameter missing', async () => {
    const { handlers, ran } = handler();
    await expect(handlers.handleCallFunction({ name: 'Z_APP_GET_INVOICE', values: {} }))
      .rejects.toThrow(/needs a value for IV_LGNUM/);
    expect(ran).toHaveLength(0);
  });

  it('refuses values that are not an object', async () => {
    const { handlers } = handler();
    await expect(handlers.handleCallFunction({ name: 'Z_APP_GET_INVOICE', values: '[1,2]' }))
      .rejects.toThrow(/must be an object/);
  });

  it('accepts values passed as a JSON string, the way some clients send them', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleCallFunction({
      name: 'Z_APP_GET_INVOICE',
      values: '{"IV_LGNUM":"101"}'
    }));
    expect(result.supplied).toEqual(['IV_LGNUM']);
  });

  it('shows what would run on a dry run and touches nothing', async () => {
    const { handlers, ran } = handler();
    const result = answer(await handlers.handleCallFunction({
      name: 'Z_APP_GET_INVOICE',
      values: { IV_LGNUM: '101' },
      dryRun: true
    }));
    expect(result).toMatchObject({ status: 'success', dryRun: true });
    expect(result.source).toContain('INTERFACES if_oo_adt_classrun');
    expect(result.source).toContain("CALL FUNCTION 'Z_APP_GET_INVOICE'");
    expect(ran).toHaveLength(0);
  });

  it('names the classic exception the module raised', async () => {
    const { handlers } = handler({
      output: consoleWith(['<MCP_SUBRC>2</MCP_SUBRC>', '<EV_COUNT>0</EV_COUNT>'])
    });
    const result = answer(await handlers.handleCallFunction({
      name: 'Z_APP_GET_INVOICE',
      values: { IV_LGNUM: '101' }
    }));
    expect(result).toMatchObject({ status: 'error', subrc: 2, exceptionRaised: 'NO_AUTHORITY' });
  });

  it('reports a class-based exception with its text', async () => {
    const { handlers } = handler({
      output: consoleWith([
        '<MCP_SUBRC>0</MCP_SUBRC>',
        '<MCP_EXCEPTION>CX_SY_ZERODIVIDE</MCP_EXCEPTION>',
        '<MCP_MESSAGE>Division by zero</MCP_MESSAGE>'
      ])
    });
    const result = answer(await handlers.handleCallFunction({
      name: 'Z_APP_GET_INVOICE',
      values: { IV_LGNUM: '101' }
    }));
    expect(result).toMatchObject({
      status: 'error',
      exceptionClass: 'CX_SY_ZERODIVIDE',
      message: 'Division by zero'
    });
  });

  it('says how many rows there are when the answer carries fewer', async () => {
    const { handlers } = handler({
      output: consoleWith([
        '<MCP_SUBRC>0</MCP_SUBRC>',
        '<MCP_ROWS><item><NAME>ET_INVOICE</NAME><ROWS>500</ROWS></item></MCP_ROWS>',
        '<ET_INVOICE><item><MATNR>1</MATNR></item></ET_INVOICE>'
      ])
    });
    const result = answer(await handlers.handleCallFunction({
      name: 'Z_APP_GET_INVOICE',
      values: { IV_LGNUM: '101' },
      maxRows: 1
    }));
    expect(result.rows).toEqual({ ET_INVOICE: 500 });
    expect(result.truncated).toEqual(['ET_INVOICE']);
    expect(result.truncationHint).toContain('Raise maxRows');
  });

  it('commits only when asked, and says so', async () => {
    const { handlers, ran } = handler();
    const result = answer(await handlers.handleCallFunction({
      name: 'Z_APP_GET_INVOICE',
      values: { IV_LGNUM: '101' },
      commit: true
    }));
    expect(result.rolledBack).toBe(false);
    expect(result.commitHint).toContain('what it changed stands');
    expect(sourceOf(ran)).toContain('COMMIT WORK AND WAIT.');
  });

  it('hands back the activation messages and the source when the call did not compile', async () => {
    const { handlers } = handler({
      run: {
        status: 'error',
        ran: false,
        steps: [{
          step: 'create',
          activated: false,
          activationMessages: [{ type: 'E', line: 12, text: 'Field MATNRR is unknown' }]
        }],
        source: 'CLASS zmcp_call DEFINITION.'
      }
    });
    const result = answer(await handlers.handleCallFunction({
      name: 'Z_APP_GET_INVOICE',
      values: { IV_LGNUM: '101' }
    }));
    expect(result).toMatchObject({ status: 'error', ran: false });
    expect(result.hint).toContain('did not compile');
    expect(result.source).toBeDefined();
    expect(result.steps[0].activationMessages[0].text).toBe('Field MATNRR is unknown');
  });

  it('keeps whatever the callee printed when there is no payload', async () => {
    const { handlers } = handler({ output: 'the module wrote this and nothing else' });
    const result = answer(await handlers.handleCallFunction({
      name: 'Z_APP_GET_INVOICE',
      values: { IV_LGNUM: '101' }
    }));
    expect(result).toMatchObject({ status: 'error', ran: true, output: 'the module wrote this and nothing else' });
    expect(result.hint).toContain('no result payload');
  });

  it('reports a damaged payload as damaged rather than throwing', async () => {
    const { handlers } = handler({
      output: `${RESULT_MARKER}${Buffer.from('<html>no</html>', 'utf8').toString('base64')}${RESULT_END}`
    });
    const result = answer(await handlers.handleCallFunction({
      name: 'Z_APP_GET_INVOICE',
      values: { IV_LGNUM: '101' }
    }));
    expect(result.status).toBe('error');
    expect(result.hint).toContain('damaged');
  });

  it('refuses a call with no name at all', async () => {
    const { handlers } = handler();
    await expect(handlers.handleCallFunction({})).rejects.toThrow(/Pass name/);
  });
});

describe('callMethod', () => {
  it('calls a static method and returns what it gave back', async () => {
    const { handlers, ran } = handler({
      output: consoleWith(['<MCP_SUBRC>0</MCP_SUBRC>', '<RV_STAWN>8471300000</RV_STAWN>'])
    });
    const result = answer(await handlers.handleCallMethod({
      className: 'zcl_app',
      methodName: 'get_stawn',
      values: { IV_MATNR: '4711' }
    }));

    expect(result).toMatchObject({
      status: 'success',
      called: 'ZCL_APP=>GET_STAWN',
      visibility: 'public',
      values: { RV_STAWN: '8471300000' }
    });
    const generated = sourceOf(ran);
    expect(generated).toContain('CALL METHOD zcl_app=>get_stawn');
    expect(generated).toContain('RECEIVING');
  });

  it('refuses an instance method and says what to use instead', async () => {
    const { handlers, ran } = handler();
    await expect(handlers.handleCallMethod({ className: 'ZCL_APP', methodName: 'DO_IT', values: { IV_A: 'X' } }))
      .rejects.toThrow(/instance method[\s\S]*runSnippet/);
    expect(ran).toHaveLength(0);
  });

  it('refuses a redefinition too, which is always an instance method', async () => {
    const { handlers } = handler();
    await expect(handlers.handleCallMethod({ className: 'ZCL_APP', methodName: 'IF_X~RUN' }))
      .rejects.toThrow(/instance method/);
  });

  it('answers an unknown method with the ones the class declares', async () => {
    const { handlers } = handler();
    await expect(handlers.handleCallMethod({ className: 'ZCL_APP', methodName: 'GET_STAWNN' }))
      .rejects.toThrow(/does not declare GET_STAWNN[\s\S]*GET_STAWN/);
  });

  it('refuses a call missing the class or the method', async () => {
    const { handlers } = handler();
    await expect(handlers.handleCallMethod({ className: 'ZCL_APP' })).rejects.toThrow(/Pass className and methodName/);
  });
});

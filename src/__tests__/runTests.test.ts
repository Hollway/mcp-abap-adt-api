import { UnitTestHandlers } from '../handlers/UnitTestHandlers';

/**
 * runTests exists because a bare unitTestRun lies by omission: against an
 * inactive object no test runs at all, and the answer to that is an empty
 * list - indistinguishable from "everything passed". These tests hold the
 * activate-first order in place and check that a failure is reported as a
 * failure rather than buried in nested alerts.
 */
const CLASS_URL = '/sap/bc/adt/oo/classes/zcl_mcp_test';

const passingRun = [{
  'adtcore:name': 'LTCL_TEST',
  alerts: [],
  testmethods: [
    { 'adtcore:name': 'FIRST', alerts: [] },
    { 'adtcore:name': 'SECOND', alerts: [] }
  ]
}];

const failingRun = [{
  'adtcore:name': 'LTCL_TEST',
  alerts: [],
  testmethods: [
    { 'adtcore:name': 'FIRST', alerts: [] },
    {
      'adtcore:name': 'SECOND',
      alerts: [{
        kind: 'failedAssertion',
        severity: 'critical',
        title: 'Critical Assertion Error: Assert equals',
        details: ['Expected 3 but was 4']
      }]
    }
  ]
}];

const handler = (over: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const client = {
    stateful: 'stateless',
    inactiveObjects: async () => { calls.push('inactiveObjects'); return []; },
    activate: async () => { calls.push('activate'); return { success: true, messages: [], inactive: [] }; },
    unitTestRun: async () => { calls.push('run'); return passingRun; },
    ...over
  };
  return { handlers: new UnitTestHandlers(client as any), calls };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

describe('runTests', () => {
  it('activates before running and summarises a clean run', async () => {
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleRunTests({ className: 'ZCL_MCP_TEST' }));

    expect(calls[0]).toBe('inactiveObjects');
    expect(calls).toContain('run');
    expect(result).toMatchObject({
      status: 'success',
      ran: true,
      objectUrl: CLASS_URL,
      methods: 2,
      passed: 2,
      failures: 0
    });
    expect(result.testClasses).toEqual(['LTCL_TEST']);
  });

  it('reports each failure with the method it came from', async () => {
    const { handlers } = handler({ unitTestRun: async () => failingRun });
    const result = answer(await handlers.handleRunTests({ className: 'ZCL_MCP_TEST' }));

    expect(result).toMatchObject({ ran: true, methods: 2, passed: 1, failures: 1 });
    expect(result.failureDetails[0]).toMatchObject({
      class: 'LTCL_TEST',
      method: 'SECOND',
      kind: 'failedAssertion',
      severity: 'critical'
    });
    expect(result.failureDetails[0].details).toEqual(['Expected 3 but was 4']);
  });

  it('skips the activation when asked to', async () => {
    const { handlers, calls } = handler();
    await handlers.handleRunTests({ className: 'ZCL_MCP_TEST', activate: false });
    expect(calls).toEqual(['run']);
  });

  it('does not run at all when the object cannot be activated', async () => {
    const { handlers, calls } = handler({
      inactiveObjects: async () => [{
        object: {
          'adtcore:uri': CLASS_URL,
          'adtcore:type': 'CLAS/OC',
          'adtcore:name': 'ZCL_MCP_TEST',
          'adtcore:parentUri': '/sap/bc/adt/packages/%24tmp',
          user: 'TESTER',
          deleted: false
        }
      }],
      activate: async () => ({
        success: false,
        messages: [{ 'adtcore:type': 'E', 'shortText': 'Syntax error' }],
        inactive: []
      })
    });
    const result = answer(await handlers.handleRunTests({ className: 'ZCL_MCP_TEST' }));

    expect(result).toMatchObject({ status: 'error', ran: false });
    expect(result.hint).toContain('no test would have run');
    expect(calls).not.toContain('run');
  });

  it('explains an empty run instead of calling it a pass', async () => {
    const { handlers } = handler({ unitTestRun: async () => [] });
    const result = answer(await handlers.handleRunTests({ className: 'ZCL_MCP_TEST' }));

    expect(result).toMatchObject({ ran: false, methods: 0, failures: 0, emptyResult: true });
    expect(result.hint).toMatch(/never means "all tests passed"|not active/);
  });

  it('needs to be told which object', async () => {
    const { handlers } = handler();
    await expect(handlers.handleRunTests({})).rejects.toThrow(/Which object/);
  });
});

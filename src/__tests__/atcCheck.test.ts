import { AtcHandlers } from '../handlers/AtcHandlers';

/**
 * A run over a standard SAP object finds nothing because it checks nothing.
 *
 * Measured live: CL_SALV_TABLE answered with zero findings and a run info
 * reading "SAP object(s) were excluded from ATC check run", while the tool
 * said "No findings at all under the system check variant" - which reads as a
 * clean bill of health for an object that was never looked at. A custom
 * class on the same system answered with 115 findings, each carrying the
 * documentationUri that atcDocumentation takes.
 */
const answer = (result: any) => JSON.parse(result.content[0].text);

const client = (infos: any[], worklist: any = { objects: [] }) => ({
  atcCustomizing: async () => ({ properties: [{ name: 'systemCheckVariant', value: 'TESTVAR' }] }),
  atcCheckVariant: async () => 'WORKLIST01',
  createAtcRun: async () => ({ id: 'RUN01', timestamp: 1789463770, infos }),
  atcWorklists: async () => worklist
});

describe('atcCheck says when the run excluded what it was asked about', () => {
  it('names the exclusion instead of calling an unchecked object clean', async () => {
    const handlers = new AtcHandlers(client([
      { type: 'FINDING_STATS', description: '0,0,0' },
      { type: 'SAP_OBJS', description: 'SAP object(s) were excluded from ATC check run' }
    ]) as any);
    const payload = answer(await handlers.handle('atcCheck', { objectName: 'CL_SALV_TABLE' }));
    expect(payload.totalFindings).toBe(0);
    expect(payload.hint).toContain('excluded the object');
    expect(payload.hint).toContain('not a clean bill of health');
  });

  it('still says plainly when a run that did check found nothing', async () => {
    const handlers = new AtcHandlers(client([{ type: 'FINDING_STATS', description: '0,0,0' }]) as any);
    const payload = answer(await handlers.handle('atcCheck', { objectName: 'ZCL_CLEAN' }));
    expect(payload.totalFindings).toBe(0);
    expect(payload.hint).toBe('No findings at all under check variant TESTVAR.');
  });
});

/**
 * What a finding has to carry to be worth anything afterwards.
 *
 * The exemption tools take a markerId, which the backend spells quickfixInfo -
 * and the report dropped it, so nothing atcCheck answered could be fed to
 * atcExemptProposal. Measured live: a finding on ZCL_MM carries findingUri and
 * documentationUri; on a system without the approval workflow quickfixInfo is
 * absent, which is why it is reported only when it is there.
 */
const worklistWith = (finding: any) => ({
  objects: [{
    name: 'ZCL_APP',
    objectTypeId: 'CLAS/OC',
    packageName: 'ZAPP',
    author: 'JSMITH',
    findings: [finding]
  }]
});

const finding = (over: Record<string, unknown> = {}) => ({
  priority: 2,
  checkTitle: '069 - Prefix Naming Conventions',
  messageTitle: 'Bad naming, expected ..., got ...',
  location: { uri: '/sap/bc/adt/oo/classes/zcl_app/source/main', range: { start: { line: 1 } } },
  uri: '/sap/bc/adt/atc/worklists/W01/findings/ZCL_APP/CLAS/AAA/001/-1',
  link: { href: '/sap/bc/adt/documentation/atc/documents/W01/findings/ZCL_APP' },
  ...over
});

describe('atcCheck reports what the other ATC tools need', () => {
  it('passes the marker id on under the name the exemption tool takes', async () => {
    const handlers = new AtcHandlers(client(
      [{ type: 'FINDING_STATS', description: '0,1,0' }],
      worklistWith(finding({ quickfixInfo: 'MARKER-1' }))
    ) as any);
    const payload = answer(await handlers.handle('atcCheck', { objectName: 'ZCL_APP' }));
    expect(payload.objects[0].findings[0]).toMatchObject({
      markerId: 'MARKER-1',
      findingUri: '/sap/bc/adt/atc/worklists/W01/findings/ZCL_APP/CLAS/AAA/001/-1'
    });
  });

  it('leaves the marker out when the system does not give one', async () => {
    const handlers = new AtcHandlers(client(
      [{ type: 'FINDING_STATS', description: '0,1,0' }],
      worklistWith(finding())
    ) as any);
    const payload = answer(await handlers.handle('atcCheck', { objectName: 'ZCL_APP' }));
    expect(payload.objects[0].findings[0]).not.toHaveProperty('markerId');
  });

  it('says in the note how to get from a finding to the tools that take it', async () => {
    const handlers = new AtcHandlers(client(
      [{ type: 'FINDING_STATS', description: '0,1,0' }],
      worklistWith(finding({ quickfixInfo: 'MARKER-1' }))
    ) as any);
    const payload = answer(await handlers.handle('atcCheck', { objectName: 'ZCL_APP' }));
    expect(payload.note).toContain('markerId');
    expect(payload.note).toContain('atcExemptProposal');
  });

  /**
   * A bare CLAS is what a caller writes by hand, and it used to be refused
   * with "atcCheck does not know the ADT URI of a CLAS" - a refusal of the
   * spelling, not of the object.
   */
  it('accepts the bare object type as well as the full one', async () => {
    const handlers = new AtcHandlers(client([{ type: 'FINDING_STATS', description: '0,0,0' }]) as any);
    const bare = answer(await handlers.handle('atcCheck', { objectName: 'ZCL_APP', objectType: 'CLAS' }));
    const full = answer(await handlers.handle('atcCheck', { objectName: 'ZCL_APP', objectType: 'CLAS/OC' }));
    expect(bare.objectUri).toBe('/sap/bc/adt/oo/classes/zcl_app');
    expect(bare.objectUri).toBe(full.objectUri);
  });

  it('still refuses a type it has no URL for, and says to pass one', async () => {
    const handlers = new AtcHandlers(client([]) as any);
    await expect(handlers.handle('atcCheck', { objectName: 'ZUI_SRVB', objectType: 'SRVB' }))
      .rejects.toThrow(/does not know the ADT URI of a SRVB/);
  });
});

/**
 * The contact of a finding is part of the exemption approval workflow. A system
 * that does not run it has no /sap/bc/adt/atc/items collection and answers 404
 * for every finding - which on its own reads as "this finding has no contact".
 */
describe('atcContactUri', () => {
  const httpError = (status: number) => {
    const error: any = new Error(`Request failed with status code ${status}`);
    error.typeID = Symbol.for('HTTP EXCEPTION');
    error.status = status;
    return error;
  };

  it('says a 404 is about the system, not about the finding', async () => {
    const handlers = new AtcHandlers({
      atcContactUri: async () => { throw httpError(404); }
    } as any);
    await expect(handlers.handle('atcContactUri', { findingUri: '/sap/bc/adt/atc/worklists/W01/findings/X' }))
      .rejects.toThrow(/exemption approval workflow/);
  });

  it('reports any other failure as the failure it is', async () => {
    const handlers = new AtcHandlers({
      atcContactUri: async () => { throw httpError(500); }
    } as any);
    await expect(handlers.handle('atcContactUri', { findingUri: '/sap/bc/adt/atc/worklists/W01/findings/X' }))
      .rejects.toThrow(/Failed to get the ATC contact for/);
  });

  it('asks for the finding rather than calling with nothing', async () => {
    const handlers = new AtcHandlers({ atcContactUri: async () => ({}) } as any);
    await expect(handlers.handle('atcContactUri', {})).rejects.toThrow(/Pass findingUri/);
  });
});

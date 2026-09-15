import { AtcHandlers } from '../handlers/AtcHandlers';

/**
 * A run over a standard SAP object finds nothing because it checks nothing.
 *
 * Measured live: CL_SALV_TABLE answered with zero findings and a run info
 * reading "SAP object(s) were excluded from ATC check run", while the tool
 * said "No findings at all under check variant ARMTEK" - which reads as a
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

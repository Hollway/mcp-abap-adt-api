import { ObjectManagementHandlers } from '../handlers/ObjectManagementHandlers';
import { activateAndVerify } from '../lib/activation';

/**
 * activateByName is the trap this file guards: on a live system it answered
 * {success: true, inactive: []} for a class that was still inactive, so the
 * caller believed new code was running while the old body executed. The
 * handler now checks the inactive list and reports what it finds.
 */
const NAME = 'ZCL_TEST';
const URL = '/sap/bc/adt/oo/classes/zcl_test';

const inactiveRow = (name: string, type = 'CLAS/OC') => ({
  object: {
    'adtcore:uri': `/sap/bc/adt/oo/classes/${name.toLowerCase()}`,
    'adtcore:type': type,
    'adtcore:name': name,
    'adtcore:parentUri': '/sap/bc/adt/packages/ztest',
    user: 'TESTER',
    deleted: false
  }
});

const handler = (over: Record<string, unknown> = {}) => {
  const client = {
    activate: async () => ({ success: true, messages: [], inactive: [] }),
    inactiveObjects: async () => [],
    ...over
  };
  return new ObjectManagementHandlers(client as any);
};

const answer = (result: any) => JSON.parse(result.content[0].text);

describe('activateByName', () => {
  it('confirms an activation the inactive list agrees with', async () => {
    const result = answer(await handler().handleActivateByName({ objectName: NAME, objectUrl: URL }));
    expect(result).toMatchObject({ success: true, verified: true, stillInactive: [] });
    expect(result.hint).toBeUndefined();
  });

  it('lowers success to false when the object stayed inactive', async () => {
    const handlers = handler({ inactiveObjects: async () => [inactiveRow(NAME)] });
    const result = answer(await handlers.handleActivateByName({ objectName: NAME, objectUrl: URL }));
    expect(result).toMatchObject({
      success: false,
      reportedSuccess: true,
      verified: false,
      stillInactive: [{ name: NAME, type: 'CLAS/OC' }]
    });
    expect(result.hint).toMatch(/activateSafe/);
  });

  it('ignores objects other than the one activated', async () => {
    const handlers = handler({ inactiveObjects: async () => [inactiveRow('ZCL_SOMETHING_ELSE')] });
    const result = answer(await handlers.handleActivateByName({ objectName: NAME, objectUrl: URL }));
    expect(result).toMatchObject({ success: true, verified: true });
  });

  it('reports the activation as unverified when the list cannot be read', async () => {
    const handlers = handler({
      inactiveObjects: async () => { throw new Error('session is dead'); }
    });
    const result = answer(await handlers.handleActivateByName({ objectName: NAME, objectUrl: URL }));
    // the activation itself succeeded, so it must not be turned into an error
    expect(result).toMatchObject({ success: true, reportedSuccess: true });
    expect(result.verified).toBeUndefined();
    expect(result.hint).toMatch(/unverified/);
  });
});

/**
 * The inactive list leaves adtcore:parentUri empty for a program, and
 * activation refuses an entry without one. Live, that turned a completed edit
 * into a failed activation over a value the system knows: the workbench path
 * of the object names its package.
 */
describe('activateAndVerify: the package the inactive list omits', () => {
  const PROGRAM = '/sap/bc/adt/programs/programs/zdev_test';
  const rowWithoutPackage = () => ({
    object: {
      'adtcore:uri': PROGRAM,
      'adtcore:type': 'PROG/P',
      'adtcore:name': 'ZDEV_TEST',
      'adtcore:parentUri': '',
      user: 'TESTER',
      deleted: false
    }
  });

  const client = (over: Record<string, unknown> = {}) => {
    let activated: any[] = [];
    let rounds = 0;
    const stub = {
      inactiveObjects: async () => (rounds === 0 ? [rowWithoutPackage()] : []),
      findObjectPath: async () => [
        { 'adtcore:type': 'DEVC/K', 'adtcore:name': '$TMP' },
        { 'adtcore:type': 'PROG/P', 'adtcore:name': 'ZDEV_TEST' }
      ],
      activate: async (objects: any[]) => {
        activated = objects;
        rounds += 1;
        return { success: true, messages: [], inactive: [] };
      },
      ...over
    };
    return { stub, sent: () => activated };
  };

  it('looks the package up and encodes it for the URI', async () => {
    const { stub, sent } = client();
    const outcome = await activateAndVerify(stub as any, { objectUrl: PROGRAM });
    expect(outcome.success).toBe(true);
    expect(sent()[0]['adtcore:parentUri']).toBe('/sap/bc/adt/packages/%24tmp');
  });

  it('prefers the parentUri the caller passed', async () => {
    const { stub, sent } = client();
    await activateAndVerify(stub as any, {
      objectUrl: PROGRAM,
      parentUri: '/sap/bc/adt/packages/zapp_base'
    });
    expect(sent()[0]['adtcore:parentUri']).toBe('/sap/bc/adt/packages/zapp_base');
  });

  it('still says what to pass when the lookup finds no package', async () => {
    const { stub } = client({ findObjectPath: async () => [] });
    await expect(activateAndVerify(stub as any, { objectUrl: PROGRAM }))
      .rejects.toThrow(/parentUri=\/sap\/bc\/adt\/packages/);
  });

  it('survives a lookup that fails outright', async () => {
    const { stub } = client({
      findObjectPath: async () => { throw new Error('no path for this object'); }
    });
    await expect(activateAndVerify(stub as any, { objectUrl: PROGRAM }))
      .rejects.toThrow(/could not be looked up/);
  });
});

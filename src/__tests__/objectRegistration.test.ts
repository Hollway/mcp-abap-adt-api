import { ObjectRegistrationHandlers } from '../handlers/ObjectRegistrationHandlers';

/**
 * createObject cannot create a report include: abap-adt-api leaves the
 * reference to the main program out of the creation document, and the backend
 * answers 400 or 500 - confirmed on separate days with brand-new names. The
 * handler refuses the call instead of letting that error look like a package
 * or naming problem.
 */
const handler = (over: Record<string, unknown> = {}) => {
  const calls: any[] = [];
  const client = {
    createObject: async (...args: any[]) => { calls.push(args); return { name: 'X' }; },
    ...over
  };
  return { handlers: new ObjectRegistrationHandlers(client as any), calls };
};

describe('createObject', () => {
  it('refuses PROG/I and names the tool that works', async () => {
    const { handlers, calls } = handler();
    await expect(handlers.handleCreateObject({
      objtype: 'PROG/I',
      name: 'ZR_APP_FOO_F01',
      parentName: 'ZR_APP_FOO',
      description: 'Forms',
      parentPath: '/sap/bc/adt/packages/zapp_base'
    })).rejects.toThrow(/createInclude[\s\S]*ZR_APP_FOO/);
    expect(calls).toHaveLength(0);
  });

  it('recognises the type whatever the case', async () => {
    const { handlers } = handler();
    await expect(handlers.handleCreateObject({ objtype: ' prog/i ', name: 'Z1' }))
      .rejects.toThrow(/createInclude/);
  });

  it('passes every other type through', async () => {
    const { handlers, calls } = handler();
    await handlers.handleCreateObject({
      objtype: 'CLAS/OC',
      name: 'ZCL_TEST',
      parentName: 'ZTEST',
      description: 'Test',
      parentPath: '/sap/bc/adt/packages/ztest'
    });
    expect(calls[0][0]).toBe('CLAS/OC');
  });
});

import { AtcHandlers } from '../handlers/AtcHandlers';
import { ServiceBindingHandlers } from '../handlers/ServiceBindingHandlers';

/**
 * Three refusals a live run over the writing tools produced, none of which
 * said what had actually happened.
 *
 * atcRequestExemption came back as "Cannot read properties of undefined
 * (reading 'rangeOfFindings')": the library destructures the proposal two
 * levels down, so anything that is not the object atcExemptProposal answered
 * with is a TypeError dressed as a transport error.
 *
 * atcChangeContact and the service binding publishers answered 404 for a
 * collection the system does not serve at all - which reads as a fact about
 * the item or the binding that was named.
 */
const missing = (resource: string) => {
  const error: any = new Error(`Resource ${resource} does not exist.`);
  error.typeID = Symbol.for('ADT EXCEPTION');
  error.type = 'ExceptionResourceNotFound';
  error.message = `Resource ${resource} does not exist.`;
  error.localizedMessage = `Resource ${resource} does not exist.`;
  error.err = 404;
  return error;
};

const httpError = (status: number) => {
  const error: any = new Error(`Request failed with status code ${status}`);
  error.typeID = Symbol.for('HTTP EXCEPTION');
  error.status = status;
  return error;
};

describe('atcRequestExemption', () => {
  const handlers = (over: Record<string, unknown> = {}) =>
    new AtcHandlers({ atcRequestExemption: async () => ({ status: 'sent' }), ...over } as any);

  it('names the object it needs instead of reading a field of undefined', async () => {
    await expect(handlers().handle('atcRequestExemption', { proposal: { markerId: 'M1' } }))
      .rejects.toThrow(/atcExemptProposal/);
  });

  it('says which part of the proposal is missing when the shape is nearly right', async () => {
    await expect(handlers().handle('atcRequestExemption', {
      proposal: { finding: { quickfixInfo: 'M1' }, restriction: { enabled: true } }
    })).rejects.toThrow(/rangeOfFindings/);
  });

  it('sends a proposal that has what the request is built from', async () => {
    const proposal = {
      finding: { quickfixInfo: 'M1' },
      restriction: { enabled: true, rangeOfFindings: { enabled: true } }
    };
    const result = await handlers().handle('atcRequestExemption', { proposal });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 'success' });
  });
});

describe('atcChangeContact', () => {
  it('says a 404 is the system having no approval workflow', async () => {
    const handlers = new AtcHandlers({
      atcChangeContact: async () => { throw httpError(404); }
    } as any);
    await expect(handlers.handle('atcChangeContact', { itemUri: '/sap/bc/adt/atc/items/x', userId: 'JSMITH' }))
      .rejects.toThrow(/exemption approval workflow/);
  });

  it('names the item and the user for any other failure', async () => {
    const handlers = new AtcHandlers({
      atcChangeContact: async () => { throw httpError(500); }
    } as any);
    await expect(handlers.handle('atcChangeContact', { itemUri: '/sap/bc/adt/atc/items/x', userId: 'JSMITH' }))
      .rejects.toThrow(/Failed to make JSMITH the ATC contact/);
  });

  it('asks for both the item and the user', async () => {
    const handlers = new AtcHandlers({ atcChangeContact: async () => ({}) } as any);
    await expect(handlers.handle('atcChangeContact', { itemUri: '/sap/bc/adt/atc/items/x' }))
      .rejects.toThrow(/Pass itemUri/);
  });
});

describe('service binding publishing', () => {
  it('says the system serves no OData publishing at all', async () => {
    const handlers = new ServiceBindingHandlers({
      publishServiceBinding: async () => { throw missing('/sap/bc/adt/businessservices/odatav2/publishjobs'); }
    } as any);
    await expect(handlers.handle('publishServiceBinding', { name: 'ZUI_BINDING', version: '0001' }))
      .rejects.toThrow(/not served by this system/);
  });

  it('says the same for unpublishing', async () => {
    const handlers = new ServiceBindingHandlers({
      unPublishServiceBinding: async () => { throw missing('/sap/bc/adt/businessservices/odatav2/unpublishjobs'); }
    } as any);
    await expect(handlers.handle('unPublishServiceBinding', { name: 'ZUI_BINDING', version: '0001' }))
      .rejects.toThrow(/not served by this system/);
  });

  it('names the binding when the failure is about the binding', async () => {
    const handlers = new ServiceBindingHandlers({
      publishServiceBinding: async () => { throw httpError(500); }
    } as any);
    await expect(handlers.handle('publishServiceBinding', { name: 'ZUI_BINDING', version: '0001' }))
      .rejects.toThrow(/Failed to publish the service binding ZUI_BINDING/);
  });
});

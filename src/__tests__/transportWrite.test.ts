import { TransportHandlers } from '../handlers/TransportHandlers';
import { requestArgument } from '../lib/transportHygiene';

/**
 * Two things a live run over the writing transport tools turned up.
 *
 * The family had grown two names for one parameter - transportNumber in the
 * tools wrapping the library, transport in the ones written here - and
 * transportReadiness answered a call that used the other one with '"undefined"
 * is not a transport request number', which reads as a complaint about the
 * value rather than about the spelling.
 *
 * And adding a user to a request answers with three tm: fields whose number is
 * the NEW task, not the request: DEVK9A3P84 plus a user answered DEVK9A3P86,
 * and the next call then found two open tasks to choose between with nothing
 * having said that a second one had appeared.
 */
const answer = (result: any) => JSON.parse(result.content[0].text);

describe('requestArgument', () => {
  it('takes the number under either name the family uses', () => {
    expect(requestArgument({ transport: 'DEVK900123' })).toBe('DEVK900123');
    expect(requestArgument({ transportNumber: 'DEVK900123' })).toBe('DEVK900123');
  });

  it('prefers the name the schema declares when both are there', () => {
    expect(requestArgument({ transport: 'DEVK900123', transportNumber: 'DEVK900999' })).toBe('DEVK900123');
  });

  it('answers undefined when neither is given, so the caller still gets the refusal', () => {
    expect(requestArgument({})).toBeUndefined();
  });
});

describe('transportAddUser', () => {
  const client = (over: Record<string, unknown> = {}) => ({
    transportAddUser: async () => ({
      'tm:targetuser': 'JSMITH',
      'tm:useraction': 'tasks',
      'tm:number': 'DEVK900456'
    }),
    ...over
  });

  it('says that the user got a task, and which one', async () => {
    const handlers = new TransportHandlers(client() as any);
    const payload = answer(await handlers.handle('transportAddUser', {
      transportNumber: 'DEVK900123', user: 'jsmith'
    }));
    expect(payload).toMatchObject({
      status: 'success',
      request: 'DEVK900123',
      user: 'JSMITH',
      taskCreated: 'DEVK900456'
    });
    expect(payload.note).toContain('Write to the task');
  });

  it('takes the request under the other name too', async () => {
    const handlers = new TransportHandlers(client() as any);
    const payload = answer(await handlers.handle('transportAddUser', {
      transport: 'DEVK900123', user: 'JSMITH'
    }));
    expect(payload.request).toBe('DEVK900123');
  });

  it('does not invent a task when the backend answers with the request itself', async () => {
    const handlers = new TransportHandlers(client({
      transportAddUser: async () => ({ 'tm:targetuser': 'JSMITH', 'tm:number': 'DEVK900123' })
    }) as any);
    const payload = answer(await handlers.handle('transportAddUser', {
      transportNumber: 'DEVK900123', user: 'JSMITH'
    }));
    expect(payload).not.toHaveProperty('taskCreated');
    expect(payload.note).toContain('was added to request');
  });

  it('asks for both the request and the user rather than calling with half of it', async () => {
    const handlers = new TransportHandlers(client() as any);
    await expect(handlers.handle('transportAddUser', { transportNumber: 'DEVK900123' }))
      .rejects.toThrow(/Pass the request/);
  });

  it('names the request and the user when the backend refuses', async () => {
    const handlers = new TransportHandlers(client({
      transportAddUser: async () => { throw new Error('not the owner'); }
    }) as any);
    await expect(handlers.handle('transportAddUser', { transportNumber: 'DEVK900123', user: 'JSMITH' }))
      .rejects.toThrow(/Failed to add JSMITH to transport DEVK900123/);
  });
});

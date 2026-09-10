import { TransportHandlers } from '../handlers/TransportHandlers';

/**
 * transportDetails has to survive a backend that answers the per-request
 * endpoint with the caller's whole transport list - which is what this system
 * does, and what made the library's own parse return an empty request. The
 * lookup then happens in the list, and a task number resolves to its request.
 */
const REQUEST = {
  'tm:number': 'DEVK9A3OOT',
  'tm:owner': 'TESTER',
  'tm:desc': 'TASK-1003',
  'tm:status': 'R',
  objects: [
    { 'tm:pgmid': 'LIMU', 'tm:type': 'CPRI', 'tm:name': 'ZCL_APP_X', 'tm:obj_info': 'Class' }
  ],
  tasks: [{
    'tm:number': 'DEVK9A3OOU',
    'tm:owner': 'TESTER',
    'tm:desc': 'Development/Correction',
    'tm:status': 'R',
    objects: [
      { 'tm:pgmid': 'LIMU', 'tm:type': 'METH', 'tm:name': 'ZCL_APP_X====METH', 'tm:obj_info': 'Method' }
    ]
  }]
};

const LIST = {
  workbench: [{ 'tm:name': 'QAS', 'tm:desc': 'QA', modifiable: [], released: [REQUEST] }],
  customizing: []
};

const handler = (over: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const client = {
    username: 'TESTER',
    // What this system does: the number is ignored and nothing parses out.
    transportDetails: async () => { calls.push('transportDetails'); return { links: [], objects: [], tasks: [] } as any; },
    userTransports: async () => { calls.push('userTransports'); return LIST as any; },
    ...over
  };
  return { handlers: new TransportHandlers(client as any), calls };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

describe('transportDetails', () => {
  it('falls back to the transport list when the endpoint answers with a list', async () => {
    const { handlers, calls } = handler();
    const result = answer(await handlers.handleTransportDetails({ transportNumber: 'DEVK9A3OOT' }));

    expect(calls).toEqual(['transportDetails', 'userTransports']);
    expect(result).toMatchObject({
      found: true,
      number: 'DEVK9A3OOT',
      owner: 'TESTER',
      transportStatus: 'R',
      statusMeaning: 'released',
      taskCount: 1,
      objectCount: 2
    });
    // Objects of the request itself, then those recorded under each task.
    expect(result.objects[0]).toMatchObject({ pgmid: 'LIMU', type: 'CPRI', name: 'ZCL_APP_X' });
    expect(result.objects[1]).toMatchObject({ name: 'ZCL_APP_X====METH', task: 'DEVK9A3OOU' });
  });

  it('resolves a task number to the request holding it, and says so', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTransportDetails({ transportNumber: 'devk9a3oou' }));
    expect(result.number).toBe('DEVK9A3OOT');
    expect(result.via).toContain('is a task of DEVK9A3OOT');
  });

  it('uses the endpoint answer when it does parse into the right request', async () => {
    const seen: string[] = [];
    const { handlers } = handler({
      transportDetails: async () => { seen.push('transportDetails'); return REQUEST as any; },
      userTransports: async () => { seen.push('userTransports'); return LIST as any; }
    });
    const result = answer(await handlers.handleTransportDetails({ transportNumber: 'DEVK9A3OOT' }));
    expect(seen).toEqual(['transportDetails']);
    expect(result).toMatchObject({ found: true, via: 'transportDetails', objectCount: 2 });
  });

  it('says the request was not found instead of reporting it as empty', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTransportDetails({ transportNumber: 'DEVK9XXXXXX' }));
    expect(result).toMatchObject({ found: false, searchedOwner: 'TESTER' });
    expect(result.hint).toContain('runQuery on E071');
  });

  it('searches another user list when asked', async () => {
    let asked = '';
    const { handlers } = handler({
      userTransports: async (user: string) => { asked = user; return LIST as any; }
    });
    await handlers.handleTransportDetails({ transportNumber: 'DEVK9A3OOT', owner: 'pprudnikov' });
    expect(asked).toBe('PPRUDNIKOV');
  });

  it('leaves out the object list and the tasks when told to', async () => {
    const { handlers } = handler();
    const result = answer(await handlers.handleTransportDetails({
      transportNumber: 'DEVK9A3OOT',
      includeObjects: false,
      includeTasks: false
    }));
    expect(result.objectCount).toBe(2);
    expect(result.objects).toBeUndefined();
    expect(result.tasks).toBeUndefined();
  });
});

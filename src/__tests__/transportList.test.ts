import { TransportHandlers } from '../handlers/TransportHandlers';

/**
 * userTransports is the one place where a filter mistake is expensive and
 * invisible: the raw answer runs past 400k characters, so nobody reads it to
 * notice that a request went missing. The backend is stubbed here because the
 * read-only system available for smoke tests has no transports of its own.
 */
const payload = {
  workbench: [
    {
      'tm:name': 'DEVK',
      'tm:desc': 'Development',
      modifiable: [
        {
          'tm:number': 'DEVK9A3OMW',
          'tm:owner': 'TESTER',
          'tm:desc': 'TASK-1004 pck_guid',
          'tm:status': 'D',
          'tm:uri': '/x',
          links: [],
          objects: [],
          tasks: [
            {
              'tm:number': 'DEVK9A3OMX',
              'tm:owner': 'TESTER',
              'tm:desc': 'Development/Correction',
              'tm:status': 'D',
              'tm:uri': '/y',
              links: [],
              objects: []
            }
          ]
        },
        {
          'tm:number': 'DEVK9A3OK4',
          'tm:owner': 'OTHERUSER',
          'tm:desc': 'TASK-1005 history',
          'tm:status': 'D',
          'tm:uri': '/x',
          links: [],
          objects: [],
          tasks: []
        }
      ],
      released: [
        {
          'tm:number': 'DEVK9A1KEQ',
          'tm:owner': 'TESTER',
          'tm:desc': 'ZTRK_ZB review',
          'tm:status': 'R',
          'tm:uri': '/x',
          links: [],
          objects: [],
          tasks: []
        }
      ]
    }
  ],
  customizing: []
} as any;

const handlers = () => new TransportHandlers({
  userTransports: async () => payload
} as any);

const parse = async (args: any) => {
  const result = await handlers().handleUserTransports({ user: 'TESTER', ...args });
  return JSON.parse(result.content[0].text);
};

describe('userTransports', () => {
  it('flattens targets and buckets into one list', async () => {
    const answer = await parse({});
    expect(answer.count).toBe(3);
    expect(answer.requests.map((r: any) => r.number)).toEqual([
      'DEVK9A3OMW', 'DEVK9A3OK4', 'DEVK9A1KEQ'
    ]);
    expect(answer.requests[0]).toMatchObject({
      number: 'DEVK9A3OMW',
      description: 'TASK-1004 pck_guid',
      owner: 'TESTER',
      status: 'D',
      state: 'modifiable',
      category: 'workbench',
      target: 'DEVK'
    });
  });

  it('leaves the tasks out unless asked', async () => {
    expect((await parse({})).requests[0].tasks).toBeUndefined();
    expect((await parse({ includeTasks: true })).requests[0].tasks).toEqual([
      {
        number: 'DEVK9A3OMX',
        owner: 'TESTER',
        description: 'Development/Correction',
        status: 'D'
      }
    ]);
  });

  it('filters by status, owner, number and description', async () => {
    expect((await parse({ status: 'R' })).requests.map((r: any) => r.number)).toEqual(['DEVK9A1KEQ']);
    expect((await parse({ status: 'D' })).count).toBe(2);
    expect((await parse({ owner: 'tester' })).count).toBe(2);
    expect((await parse({ numberLike: 'A3O' })).count).toBe(2);
    expect((await parse({ descriptionLike: 'task-1005' })).requests.map((r: any) => r.number))
      .toEqual(['DEVK9A3OK4']);
    expect((await parse({ status: 'D', owner: 'TESTER', numberLike: 'OMW' })).count).toBe(1);
  });

  it('returns the untouched structure with raw', async () => {
    const answer = await parse({ raw: true });
    expect(answer.transports).toEqual(payload);
    expect(answer.requests).toBeUndefined();
  });

  it('asks for targets unless told otherwise', async () => {
    const seen: any[] = [];
    const handler = new TransportHandlers({
      userTransports: async (user: string, targets?: boolean) => {
        seen.push({ user, targets });
        return payload;
      }
    } as any);
    await handler.handleUserTransports({ user: 'X' });
    await handler.handleUserTransports({ user: 'X', targets: false });
    expect(seen).toEqual([{ user: 'X', targets: true }, { user: 'X', targets: false }]);
  });
});

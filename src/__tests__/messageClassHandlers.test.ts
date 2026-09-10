import { MessageClassHandlers } from '../handlers/MessageClassHandlers';
import { lockRegistry } from '../lib/lockRegistry';

/**
 * What these tests hold in place is everything the live backend forced:
 * the read before the write (the PUT replaces the class header, so a write
 * without the current description would empty it), the lock taken and given
 * back by the tool itself, the read-back that proves the upsert did something,
 * and the empty validation answer that must not read as a refusal.
 */
const classDocument = (messages: Array<{ no: string; text?: string; self?: boolean; documented?: boolean }>, description = 'Probe class') =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<mc:messageClass adtcore:responsible="TESTER" adtcore:masterLanguage="RU"' +
  ' adtcore:name="ZDEV_MCP_MSG" adtcore:type="MSAG/N" adtcore:version="active"' +
  ` adtcore:description="${description}" adtcore:language="RU"` +
  ' xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core">' +
  '<adtcore:packageRef adtcore:type="DEVC/K" adtcore:name="$TMP"/>' +
  messages.map(m =>
    `<mc:messages mc:msgno="${m.no}"${m.text === undefined ? '' : ` mc:msgtext="${m.text}"`}` +
    ` mc:selfexplainatory="${m.self === false ? 'false' : 'true'}"` +
    ` mc:documented="${m.documented ? 'true' : 'false'}" adtcore:name=""/>`).join('') +
  '</mc:messageClass>';

interface Harness {
  handlers: MessageClassHandlers;
  calls: string[];
  requests: any[];
}

/**
 * `documents` is the queue of class documents the backend answers with, one
 * per GET; the last one is repeated once the queue runs dry.
 */
const harness = (documents: string[], over: Record<string, unknown> = {}): Harness => {
  const calls: string[] = [];
  const requests: any[] = [];
  const queue = [...documents];
  let last = documents[documents.length - 1];

  const request = async (url: string, config: any) => {
    const method = String(config?.method || 'GET').toUpperCase();
    requests.push({ url, ...config });
    calls.push(`${method} ${url}`);
    if (method === 'GET' && url.endsWith('/longtext')) {
      return { body: '<h1>Cause</h1><p>Because.</p>', headers: { 'content-type': 'text/html' } };
    }
    if (method === 'GET') {
      if (queue.length) last = queue.shift() as string;
      return { body: last, headers: { 'content-type': 'application/vnd.sap.adt.mc.messageclass+xml' } };
    }
    return { body: '', headers: {} };
  };

  const client: any = {
    stateful: 'stateless',
    language: 'RU',
    username: 'TESTER',
    httpClient: { request },
    lock: async () => { calls.push('lock'); return { LOCK_HANDLE: 'HANDLE' }; },
    unLock: async () => { calls.push('unlock'); },
    validateNewObject: async () => { calls.push('validate'); return { success: false }; },
    createObject: async () => { calls.push('create'); },
    ...over
  };
  if (!('statelessClone' in over)) client.statelessClone = client;
  return { handlers: new MessageClassHandlers(client), calls, requests };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

beforeEach(() => lockRegistry.clear());

describe('getMessages', () => {
  it('returns the messages of the class with its header', async () => {
    const { handlers } = harness([classDocument([
      { no: '001', text: 'Data not found' },
      { no: '042', text: 'Value &amp;1 rejected', self: false, documented: true }
    ])]);
    const result = answer(await handlers.handleGetMessages({ className: 'ZDEV_MCP_MSG' }));

    expect(result.status).toBe('success');
    expect(result.className).toBe('ZDEV_MCP_MSG');
    expect(result.description).toBe('Probe class');
    expect(result.packageName).toBe('$TMP');
    expect(result.totalMessages).toBe(2);
    expect(result.messages.map((m: any) => m.number)).toEqual(['001', '042']);
    expect(result.messages[1].text).toBe('Value &1 rejected');
  });

  it('filters by an explicit list and says which numbers are not there', async () => {
    const { handlers } = harness([classDocument([{ no: '001', text: 'One' }])]);
    const result = answer(await handlers.handleGetMessages({
      className: 'ZDEV_MCP_MSG',
      numbers: ['1', '999']
    }));

    expect(result.messages.map((m: any) => m.number)).toEqual(['001']);
    expect(result.notFound).toEqual(['999']);
  });

  it('filters by range and by text', async () => {
    const document = classDocument([
      { no: '001', text: 'alpha' },
      { no: '050', text: 'beta' },
      { no: '100', text: 'gamma' }
    ]);
    const range = answer(await harness([document]).handlers
      .handleGetMessages({ className: 'ZDEV_MCP_MSG', fromNumber: '2', toNumber: '99' }));
    expect(range.messages.map((m: any) => m.number)).toEqual(['050']);

    const search = answer(await harness([document]).handlers
      .handleGetMessages({ className: 'ZDEV_MCP_MSG', search: 'GAM' }));
    expect(search.messages.map((m: any) => m.number)).toEqual(['100']);
  });

  // Class 00 of a standard system has 875 messages; answering with all of them
  // is how a response limit gets hit on a question nobody asked.
  it('caps the answer and says it was cut', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ no: String(i + 1).padStart(3, '0'), text: `m${i}` }));
    const { handlers } = harness([classDocument(many)]);
    const result = answer(await handlers.handleGetMessages({ className: 'ZDEV_MCP_MSG', maxMessages: 5 }));

    expect(result.messages).toHaveLength(5);
    expect(result.matched).toBe(30);
    expect(result.truncated).toBe(true);
  });

  it('reads through the stateless clone', async () => {
    const calls: string[] = [];
    const stateless = {
      httpClient: {
        request: async (url: string) => { calls.push(`clone ${url}`); return { body: classDocument([]), headers: {} }; }
      }
    };
    const { handlers } = harness([classDocument([])], { statelessClone: stateless });
    await handlers.handleGetMessages({ className: 'ZDEV_MCP_MSG' });
    expect(calls).toEqual(['clone /sap/bc/adt/messageclass/zdev_mcp_msg']);
  });
});

describe('getMessageLongtext', () => {
  it('asks for the language explicitly and hands back the html', async () => {
    const { handlers, requests } = harness([classDocument([])]);
    const result = answer(await handlers.handleGetMessageLongtext({
      className: 'ZDEV_MCP_MSG', number: '1', language: 'e'
    }));

    expect(requests[0].url).toBe('/sap/bc/adt/messageclass/zdev_mcp_msg/messages/001/longtext');
    expect(requests[0].qs).toEqual({ language: 'E' });
    expect(result.longtext).toContain('Because.');
  });

  it('defaults to the logon language', async () => {
    const { handlers, requests } = harness([classDocument([])]);
    await handlers.handleGetMessageLongtext({ className: 'ZDEV_MCP_MSG', number: '1' });
    expect(requests[0].qs).toEqual({ language: 'RU' });
  });
});

describe('setMessages', () => {
  it('reads, locks, writes only the messages given, reads back and unlocks', async () => {
    const before = classDocument([{ no: '001', text: 'Data not found' }]);
    const after = classDocument([
      { no: '001', text: 'Data not found' },
      { no: '042', text: 'Brand new' }
    ]);
    const { handlers, calls, requests } = harness([before, after]);

    const result = answer(await handlers.handleSetMessages({
      className: 'ZDEV_MCP_MSG',
      messages: [{ number: '42', text: 'Brand new' }]
    }));

    expect(calls).toEqual([
      'GET /sap/bc/adt/messageclass/zdev_mcp_msg',
      'lock',
      'PUT /sap/bc/adt/messageclass/zdev_mcp_msg',
      'GET /sap/bc/adt/messageclass/zdev_mcp_msg',
      'unlock'
    ]);
    expect(result.status).toBe('success');
    expect(result.added).toEqual(['042']);
    expect(result.totalMessages).toBe(2);

    const put = requests.find(r => r.method === 'PUT');
    expect(put.qs).toEqual({ lockHandle: 'HANDLE' });
    expect(put.headers['Content-Type']).toBe('application/vnd.sap.adt.mc.messageclass+xml');
    // Only the message asked for - the backend upserts, and sending the whole
    // class back would mean shipping 875 messages to change one.
    expect(put.body).toContain('mc:msgno="042"');
    expect(put.body).not.toContain('mc:msgno="001"');
  });

  // The write replaces the class header. Losing the description on every
  // message change is the kind of damage nobody notices for months.
  it('carries the current description into the write', async () => {
    const { handlers, requests } = harness([classDocument([{ no: '001', text: 'One' }], 'Important class')]);
    await handlers.handleSetMessages({
      className: 'ZDEV_MCP_MSG',
      messages: [{ number: '001', text: 'Two' }]
    });
    const put = requests.find(r => r.method === 'PUT');
    expect(put.body).toContain('adtcore:description="Important class"');
    expect(put.body).toContain('adtcore:masterLanguage="RU"');
  });

  it('writes a new description when one is given', async () => {
    const { handlers, requests } = harness([classDocument([{ no: '001', text: 'One' }], 'Old')]);
    await handlers.handleSetMessages({
      className: 'ZDEV_MCP_MSG',
      messages: [{ number: '001', text: 'One' }],
      description: 'New'
    });
    expect(requests.find(r => r.method === 'PUT').body).toContain('adtcore:description="New"');
  });

  it('reports a message the class did not come back with', async () => {
    const unchanged = classDocument([{ no: '001', text: 'One' }]);
    const { handlers } = harness([unchanged, unchanged]);
    const result = answer(await handlers.handleSetMessages({
      className: 'ZDEV_MCP_MSG',
      messages: [{ number: '042', text: 'Never lands' }]
    }));

    expect(result.status).toBe('error');
    expect(result.written).toBe(false);
    expect(result.notWritten).toEqual(['042']);
  });

  it('leaves a lock this process already held in place', async () => {
    lockRegistry.remember('/sap/bc/adt/messageclass/zdev_mcp_msg', 'OUTER', undefined);
    const before = classDocument([]);
    const after = classDocument([{ no: '001', text: 'One' }]);
    const { handlers, calls } = harness([before, after]);

    const result = answer(await handlers.handleSetMessages({
      className: 'ZDEV_MCP_MSG',
      messages: [{ number: '001', text: 'One' }]
    }));

    expect(calls).not.toContain('lock');
    expect(calls).not.toContain('unlock');
    expect(result.status).toBe('success');
    expect(result.steps.find((s: any) => s.step === 'lock').reused).toBe(true);
  });

  it('says nothing was written when the PUT is refused', async () => {
    const { handlers, calls } = harness([classDocument([])], {
      httpClient: {
        request: async (url: string, config: any) => {
          const method = String(config?.method || 'GET').toUpperCase();
          if (method === 'PUT') throw new Error('End of element messageClass expected');
          return { body: classDocument([]), headers: {} };
        }
      }
    });
    const result = answer(await handlers.handleSetMessages({
      className: 'ZDEV_MCP_MSG',
      messages: [{ number: '001', text: 'One' }]
    }));

    expect(result.status).toBe('error');
    expect(result.written).toBe(false);
    // The lock it took has to come off even when the write failed.
    expect(calls).toContain('unlock');
  });

  it('refuses to change a transported class without a request', async () => {
    const inPackage = classDocument([{ no: '001', text: 'One' }]).replace('adtcore:name="$TMP"', 'adtcore:name="ZAPP_BASE"');
    const { handlers } = harness([inPackage]);
    await expect(handlers.handleSetMessages({
      className: 'ZDEV_MCP_MSG',
      messages: [{ number: '001', text: 'Two' }]
    })).rejects.toThrow(/transport request/);
  });

  it('passes the transport as corrNr', async () => {
    const inPackage = classDocument([{ no: '001', text: 'One' }]).replace('adtcore:name="$TMP"', 'adtcore:name="ZAPP_BASE"');
    const { handlers, requests } = harness([inPackage, inPackage]);
    await handlers.handleSetMessages({
      className: 'ZDEV_MCP_MSG',
      messages: [{ number: '001', text: 'One' }],
      transport: 'DEVK9A3OOT'
    });
    expect(requests.find(r => r.method === 'PUT').qs).toEqual({ lockHandle: 'HANDLE', corrNr: 'DEVK9A3OOT' });
  });

  it('refuses an empty message list', async () => {
    const { handlers } = harness([classDocument([])]);
    await expect(handlers.handleSetMessages({ className: 'ZDEV_MCP_MSG', messages: [] }))
      .rejects.toThrow(/Pass messages/);
  });
});

describe('createMessageClass', () => {
  // The message class validation endpoint answers 200 with an empty body, and
  // abap-adt-api reports that as success:false. Gating on it would make every
  // message class uncreatable.
  it('treats a validation answer with no verdict as no objection', async () => {
    const { handlers, calls } = harness([classDocument([]), classDocument([{ no: '001', text: 'One' }])]);
    const result = answer(await handlers.handleCreateMessageClass({
      name: 'ZDEV_MCP_MSG',
      packageName: '$TMP',
      description: 'Probe class',
      messages: [{ number: '001', text: 'One' }]
    }));

    expect(calls.slice(0, 2)).toEqual(['validate', 'create']);
    expect(result.status).toBe('success');
    expect(result.created).toBe(true);
    expect(result.added).toEqual(['001']);
    expect(result.steps[0].note).toMatch(/no objection/);
  });

  it('stops when the backend actually objects', async () => {
    const { handlers, calls } = harness([classDocument([])], {
      validateNewObject: async () => ({ success: false, SEVERITY: 'WARNING', SHORT_TEXT: 'Name is already taken.' })
    });
    const result = answer(await handlers.handleCreateMessageClass({
      name: 'ZDEV_MCP_MSG', packageName: '$TMP', description: 'Probe'
    }));

    expect(result.status).toBe('error');
    expect(result.created).toBe(false);
    expect(calls).not.toContain('create');
    expect(result.hint).toMatch(/already taken/);
  });

  it('creates an empty class when no messages are given', async () => {
    const { handlers, calls } = harness([classDocument([])]);
    const result = answer(await handlers.handleCreateMessageClass({
      name: 'ZDEV_MCP_MSG', packageName: '$TMP', description: 'Probe'
    }));

    expect(result.status).toBe('success');
    expect(result.totalMessages).toBe(0);
    expect(calls).not.toContain('lock');
  });

  it('creates in the logon language, not in EN', async () => {
    const created: any[] = [];
    const { handlers } = harness([classDocument([])], {
      createObject: async (options: any) => { created.push(options); }
    });
    await handlers.handleCreateMessageClass({
      name: 'ZDEV_MCP_MSG', packageName: '$TMP', description: 'Probe'
    });
    expect(created[0].language).toBe('RU');
    expect(created[0].masterLanguage).toBe('RU');
  });

  it('refuses a package other than $TMP without a transport', async () => {
    const { handlers } = harness([classDocument([])]);
    await expect(handlers.handleCreateMessageClass({
      name: 'ZDEV_MCP_MSG', packageName: 'ZAPP_BASE', description: 'Probe'
    })).rejects.toThrow(/transport request/);
  });

  it('validates and stops on a dry run', async () => {
    const { handlers, calls } = harness([classDocument([])]);
    const result = answer(await handlers.handleCreateMessageClass({
      name: 'ZDEV_MCP_MSG', packageName: '$TMP', description: 'Probe', dryRun: true
    }));

    expect(result.dryRun).toBe(true);
    expect(result.created).toBe(false);
    expect(calls).toEqual(['validate']);
  });
});

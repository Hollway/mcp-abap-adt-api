import {
  parseMessageClass,
  buildMessageClassDocument,
  prepareMessages,
  missingAfterWrite,
  normaliseNumber,
  escapeXmlAttribute,
  messageClassUrl,
  messageUrl,
  messageLongtextUrl,
  MAX_MESSAGE_TEXT
} from '../lib/messageClass';

/** Shortened, but attribute for attribute what the ERP backend answers. */
const CLASS_XML =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<mc:messageClass adtcore:responsible="TESTER" adtcore:masterLanguage="RU"' +
  ' adtcore:masterSystem="DEV" adtcore:name="ZAPP_NOCOND" adtcore:type="MSAG/N"' +
  ' adtcore:version="active" adtcore:description="Status of goods"' +
  ' adtcore:language="RU" xmlns:mc="http://www.sap.com/adt/MessageClass"' +
  ' xmlns:adtcore="http://www.sap.com/adt/core">' +
  '<atom:link href="/sap/bc/adt/classifications?uri=x" rel="classifications"' +
  ' xmlns:atom="http://www.w3.org/2005/Atom"/>' +
  '<adtcore:packageRef adtcore:uri="/sap/bc/adt/vit/wb/x" adtcore:type="DEVC/K"' +
  ' adtcore:name="ZAPP_NOCOND"/>' +
  '<mc:messages mc:msgno="002" mc:msgtext="Value &amp;1 is not allowed for &amp;2"' +
  ' mc:selfexplainatory="false" mc:documented="true" adtcore:name="">' +
  '<atom:link href="/sap/bc/adt/messageclass/zapp_nocond/messages/002"' +
  ' rel="messages" xmlns:atom="http://www.w3.org/2005/Atom"/>' +
  '</mc:messages>' +
  '<mc:messages mc:msgno="001" mc:msgtext="Data not found" mc:selfexplainatory="true"' +
  ' mc:documented="false" adtcore:name=""/>' +
  '</mc:messageClass>';

describe('parseMessageClass', () => {
  it('reads the header, the package and every message', () => {
    const parsed = parseMessageClass(CLASS_XML);
    expect(parsed.name).toBe('ZAPP_NOCOND');
    expect(parsed.description).toBe('Status of goods');
    expect(parsed.masterLanguage).toBe('RU');
    expect(parsed.responsible).toBe('TESTER');
    expect(parsed.packageName).toBe('ZAPP_NOCOND');
    expect(parsed.version).toBe('active');
    expect(parsed.messages).toHaveLength(2);
  });

  it('sorts by number, whatever order the backend used', () => {
    expect(parseMessageClass(CLASS_XML).messages.map(m => m.number)).toEqual(['001', '002']);
  });

  it('unescapes the placeholders in the text', () => {
    const message = parseMessageClass(CLASS_XML).messages.find(m => m.number === '002');
    expect(message!.text).toBe('Value &1 is not allowed for &2');
    expect(message!.selfExplanatory).toBe(false);
    expect(message!.documented).toBe(true);
  });

  // Message 000 of the standard class 00 has no msgtext attribute at all. A
  // message with no text still exists, and losing it would misreport the class.
  it('keeps a message whose text attribute is absent', () => {
    const xml = '<mc:messageClass adtcore:name="00" adtcore:description="d">' +
      '<mc:messages mc:msgno="000" mc:selfexplainatory="true" mc:documented="false"/>' +
      '</mc:messageClass>';
    const parsed = parseMessageClass(xml);
    expect(parsed.messages).toEqual([
      { number: '000', text: '', selfExplanatory: true, documented: false }
    ]);
  });

  it('refuses an answer that is not a message class', () => {
    expect(() => parseMessageClass('<html>not found</html>'))
      .toThrow(/not a message class document/);
  });
});

describe('buildMessageClassDocument', () => {
  it('escapes the ampersands of a placeholder text', () => {
    const document = buildMessageClassDocument({
      name: 'zdev_mcp_msg',
      description: 'Probe',
      masterLanguage: 'RU',
      messages: [{ number: '42', text: 'Value &1 is not allowed for &2', selfExplanatory: false }]
    });
    expect(document).toContain('mc:msgtext="Value &amp;1 is not allowed for &amp;2"');
    // The live backend rejects the whole document over one bare ampersand.
    expect(document).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('pads the number and upper-cases the name', () => {
    const document = buildMessageClassDocument({
      name: 'zdev_mcp_msg',
      description: 'Probe',
      masterLanguage: 'RU',
      messages: [{ number: 7 as unknown as string, text: 'Seven', selfExplanatory: true }]
    });
    expect(document).toContain('adtcore:name="ZDEV_MCP_MSG"');
    expect(document).toContain('mc:msgno="007"');
  });

  // documented is derived by the backend from whether a long text exists, and
  // no long text can be written over ADT - sending it would be a lie.
  it('never writes the documented flag', () => {
    const document = buildMessageClassDocument({
      name: 'ZX',
      description: 'd',
      masterLanguage: 'EN',
      messages: [{ number: '001', text: 't', selfExplanatory: true, documented: true }]
    });
    expect(document).not.toContain('documented');
  });

  it('falls back to the master language when no language is given', () => {
    const document = buildMessageClassDocument({
      name: 'ZX', description: 'd', masterLanguage: 'RU', messages: []
    });
    expect(document).toContain('adtcore:language="RU"');
  });
});

describe('prepareMessages', () => {
  const existing = [
    { number: '001', text: 'Data not found', selfExplanatory: true },
    { number: '002', text: 'Value &1 rejected', selfExplanatory: false }
  ];

  it('says which messages are added, changed and unchanged', () => {
    const prepared = prepareMessages(existing, [
      { number: '001', text: 'Data not found' },
      { number: '002', text: 'Value &1 refused' },
      { number: 42, text: 'Brand new' }
    ]);
    expect(prepared.map(m => [m.number, m.action])).toEqual([
      ['001', 'unchanged'],
      ['002', 'changed'],
      ['042', 'added']
    ]);
  });

  // The whole reason to read before writing: a caller changing a text must not
  // silently flip the self-explanatory flag of a documented message.
  it('keeps the current flag when the caller does not mention it', () => {
    const [message] = prepareMessages(existing, [{ number: '002', text: 'New text' }]);
    expect(message.selfExplanatory).toBe(false);
  });

  it('defaults a brand new message to self-explanatory', () => {
    const [message] = prepareMessages(existing, [{ number: '900', text: 'New' }]);
    expect(message.selfExplanatory).toBe(true);
  });

  it('keeps the current text when only the flag is being changed', () => {
    const [message] = prepareMessages(existing, [{ number: '001', selfExplanatory: false }]);
    expect(message.text).toBe('Data not found');
    expect(message.action).toBe('changed');
  });

  it('truncates to what T100 holds and reports the original length', () => {
    const long = 'x'.repeat(MAX_MESSAGE_TEXT + 10);
    const [message] = prepareMessages(existing, [{ number: '003', text: long }]);
    expect(message.text).toHaveLength(MAX_MESSAGE_TEXT);
    expect(message.truncatedFrom).toBe(MAX_MESSAGE_TEXT + 10);
  });

  it('refuses a new message with no text', () => {
    expect(() => prepareMessages(existing, [{ number: '500' }]))
      .toThrow(/needs a text/);
  });

  it('refuses the same number twice', () => {
    expect(() => prepareMessages(existing, [{ number: '1', text: 'a' }, { number: '001', text: 'b' }]))
      .toThrow(/listed twice/);
  });
});

describe('missingAfterWrite', () => {
  it('reports a message the system did not come back with', () => {
    const written = prepareMessages([], [{ number: '001', text: 'One' }, { number: '002', text: 'Two' }]);
    const missing = missingAfterWrite(written, [
      { number: '001', text: 'One', selfExplanatory: true }
    ]);
    expect(missing).toEqual(['002']);
  });

  it('reports a message whose text came back different', () => {
    const written = prepareMessages([], [{ number: '001', text: 'One' }]);
    const missing = missingAfterWrite(written, [
      { number: '001', text: 'Something else', selfExplanatory: true }
    ]);
    expect(missing).toEqual(['001']);
  });

  it('is empty when everything landed', () => {
    const written = prepareMessages([], [{ number: '001', text: 'One' }]);
    expect(missingAfterWrite(written, [{ number: '001', text: 'One', selfExplanatory: true }])).toEqual([]);
  });
});

describe('numbers, escaping and urls', () => {
  it('pads a number to three digits', () => {
    expect(normaliseNumber(1)).toBe('001');
    expect(normaliseNumber('42')).toBe('042');
    expect(normaliseNumber('000')).toBe('000');
  });

  it('refuses anything that is not one to three digits', () => {
    expect(() => normaliseNumber('1234')).toThrow(/one to three digits/);
    expect(() => normaliseNumber('abc')).toThrow(/one to three digits/);
    expect(() => normaliseNumber('')).toThrow(/one to three digits/);
  });

  it('escapes every character XML cares about', () => {
    expect(escapeXmlAttribute(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('builds the urls the backend serves', () => {
    expect(messageClassUrl(' ZAPP_NOCOND ')).toBe('/sap/bc/adt/messageclass/zapp_nocond');
    expect(messageUrl('ZAPP_NOCOND', 1)).toBe('/sap/bc/adt/messageclass/zapp_nocond/messages/001');
    expect(messageLongtextUrl('ZAPP_NOCOND', '42'))
      .toBe('/sap/bc/adt/messageclass/zapp_nocond/messages/042/longtext');
  });
});

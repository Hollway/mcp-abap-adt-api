import {
  parseAsXmlValues,
  unescapeXml,
  decodeResultPayload,
  AsXmlError,
  RESULT_MARKER,
  RESULT_END
} from '../lib/asXml';

const payload = (...values: string[]) => [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">',
  ' <asx:values>',
  ...values.map(line => `  ${line}`),
  ' </asx:values>',
  '</asx:abap>'
].join('\n');

describe('unescapeXml', () => {
  it('reads the named entities the serialiser writes', () => {
    expect(unescapeXml('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(`a & b <c> "d" 'e'`);
  });

  it('reads numeric references, decimal and hex', () => {
    expect(unescapeXml('tab&#9;here')).toBe('tab\there');
    expect(unescapeXml('tab&#x9;here')).toBe('tab\there');
  });

  it('leaves something that only looks like an entity alone', () => {
    expect(unescapeXml('100&more;')).toBe('100&more;');
  });
});

describe('parseAsXmlValues', () => {
  it('reads an elementary value as its text', () => {
    expect(parseAsXmlValues(payload('<EV_COUNT>3</EV_COUNT>'))).toEqual({ EV_COUNT: '3' });
  });

  it('reads a structure as an object', () => {
    const xml = payload('<ES_HEAD><WERKS>1000</WERKS><MATNR>4711</MATNR></ES_HEAD>');
    expect(parseAsXmlValues(xml)).toEqual({ ES_HEAD: { WERKS: '1000', MATNR: '4711' } });
  });

  it('reads repeated item children as a table', () => {
    const xml = payload('<ET_ITEMS><item><MATNR>1</MATNR></item><item><MATNR>2</MATNR></item></ET_ITEMS>');
    expect(parseAsXmlValues(xml)).toEqual({ ET_ITEMS: [{ MATNR: '1' }, { MATNR: '2' }] });
  });

  it('reads a table of one row as a table, not as a structure', () => {
    const xml = payload('<ET_ITEMS><item><MATNR>1</MATNR></item></ET_ITEMS>');
    expect(parseAsXmlValues(xml)).toEqual({ ET_ITEMS: [{ MATNR: '1' }] });
  });

  it('reads a table of elementary rows', () => {
    const xml = payload('<ET_NAMES><item>A</item><item>B</item></ET_NAMES>');
    expect(parseAsXmlValues(xml)).toEqual({ ET_NAMES: ['A', 'B'] });
  });

  it('reads an empty table as an empty value and an empty field as an empty string', () => {
    const xml = payload('<ET_ITEMS/>', '<EV_TEXT></EV_TEXT>');
    expect(parseAsXmlValues(xml)).toEqual({ ET_ITEMS: '', EV_TEXT: '' });
  });

  it('reads a table nested inside a structure', () => {
    const xml = payload('<ES_DOC><ID>7</ID><ITEMS><item><POS>10</POS></item></ITEMS></ES_DOC>');
    expect(parseAsXmlValues(xml)).toEqual({ ES_DOC: { ID: '7', ITEMS: [{ POS: '10' }] } });
  });

  it('keeps a component actually called ITEM a component', () => {
    const xml = payload('<ES_ROW><ITEM>10</ITEM><PLANT>1000</PLANT></ES_ROW>');
    expect(parseAsXmlValues(xml)).toEqual({ ES_ROW: { ITEM: '10', PLANT: '1000' } });
  });

  it('unescapes a value that carried markup', () => {
    const xml = payload('<EV_TEXT>a &amp; b &lt;/EV_TEXT&gt;</EV_TEXT>');
    expect(parseAsXmlValues(xml)).toEqual({ EV_TEXT: 'a & b </EV_TEXT>' });
  });

  it('keeps the blanks inside a value', () => {
    expect(parseAsXmlValues(payload('<EV_TEXT>  two  words  </EV_TEXT>'))).toEqual({ EV_TEXT: '  two  words  ' });
  });

  it('reads a payload whose wrapper carries no namespace prefix', () => {
    const xml = '<abap><values><EV_A>1</EV_A></values></abap>';
    expect(parseAsXmlValues(xml)).toEqual({ EV_A: '1' });
  });

  it('skips a comment and a CDATA section', () => {
    const xml = payload('<!-- written by id -->', '<EV_T><![CDATA[a<b]]></EV_T>');
    expect(parseAsXmlValues(xml)).toEqual({ EV_T: 'a<b' });
  });

  it('refuses something that is not an asXML result', () => {
    expect(() => parseAsXmlValues('<html><body>error</body></html>')).toThrow(AsXmlError);
    expect(() => parseAsXmlValues('')).toThrow(/empty/);
  });

  it('refuses a payload that ends in the middle', () => {
    expect(() => parseAsXmlValues('<abap><values><EV_A>1')).toThrow(AsXmlError);
  });

  it('refuses mismatched tags rather than guessing', () => {
    expect(() => parseAsXmlValues('<abap><values><EV_A>1</EV_B></values></abap>')).toThrow(/EV_A/);
  });
});

describe('decodeResultPayload', () => {
  const encoded = Buffer.from('<abap><values><EV_A>1</EV_A></values></abap>', 'utf8').toString('base64');

  it('takes the payload from between the markers', () => {
    const console_ = `something the callee printed\n${RESULT_MARKER}\n${encoded}\n${RESULT_END}\n`;
    expect(decodeResultPayload(console_)).toContain('<EV_A>1</EV_A>');
  });

  it('survives a console that broke the payload across lines', () => {
    const broken = encoded.replace(/(.{8})/g, '$1\n  ');
    expect(decodeResultPayload(`${RESULT_MARKER}\n${broken}\n${RESULT_END}`)).toContain('<EV_A>1</EV_A>');
  });

  it('reads a payload whose end marker never arrived', () => {
    expect(decodeResultPayload(`${RESULT_MARKER}\n${encoded}`)).toContain('<EV_A>1</EV_A>');
  });

  it('reads nothing when there is no marker at all', () => {
    expect(decodeResultPayload('just output')).toBeUndefined();
    expect(decodeResultPayload(`${RESULT_MARKER}${RESULT_END}`)).toBeUndefined();
    expect(decodeResultPayload('')).toBeUndefined();
  });

  it('decodes a payload carrying non-ASCII text', () => {
    const russian = Buffer.from('<abap><values><EV_T>Позиция</EV_T></values></abap>', 'utf8').toString('base64');
    expect(decodeResultPayload(`${RESULT_MARKER}${russian}${RESULT_END}`)).toContain('Позиция');
  });
});

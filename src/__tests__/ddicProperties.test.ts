import {
  mergeDomain,
  mergeDataElement,
  typeChoiceError,
  domainUrl,
  dataElementUrl,
  ddicNameOf
} from '../lib/ddicProperties';

const DOMAIN = {
  metaData: {
    name: 'ZAPP_STATUS',
    description: 'Status',
    language: 'EN',
    masterLanguage: 'EN',
    masterSystem: 'DEV',
    responsible: 'TESTER',
    packageName: 'ZAPP_BASE'
  },
  properties: {
    typeInformation: { datatype: 'CHAR', length: 4, decimals: 0 },
    outputInformation: {
      length: 4,
      style: '',
      conversionExit: 'ALPHA',
      signExists: false,
      lowercase: false,
      ampmFormat: false
    },
    valueInformation: {
      valueTableRef: 'ZAPP_STATUS_T',
      appendExists: false,
      fixValues: [{ low: 'A', text: 'Active' }]
    }
  }
};

const ELEMENT = {
  metaData: {
    name: 'ZAPP_STATUS',
    description: 'Status',
    language: 'EN',
    masterLanguage: 'EN',
    masterSystem: 'DEV',
    responsible: 'TESTER',
    packageName: 'ZAPP_BASE'
  },
  properties: {
    typeName: 'ZAPP_STATUS',
    dataType: 'CHAR',
    dataTypeLength: 4,
    dataTypeDecimals: 0,
    fieldLabels: {
      shortFieldLabel: 'Status',
      mediumFieldLabel: 'Status',
      longFieldLabel: 'Delivery status',
      headingFieldLabel: 'Delivery status'
    },
    searchHelp: 'ZAPP_SH',
    searchHelpParameter: 'STATUS',
    setGetParameter: '',
    defaultComponentName: '',
    deactivateInputHistory: false,
    changeDocument: true,
    leftToRightDirection: false,
    deactivateBIDIFiltering: false
  }
};

describe('domain merge', () => {
  it('keeps every field the patch does not mention', () => {
    const { properties, metaData } = mergeDomain(DOMAIN, { length: 6 });
    expect(properties.typeInformation).toEqual({ datatype: 'CHAR', length: 6, decimals: 0 });
    expect(properties.outputInformation.conversionExit).toBe('ALPHA');
    expect(properties.valueInformation).toBe(DOMAIN.properties.valueInformation);
    expect(metaData).toEqual(DOMAIN.metaData);
  });

  it('replaces the fixed values only when they are passed', () => {
    expect(mergeDomain(DOMAIN, {}).properties.valueInformation?.fixValues)
      .toEqual([{ low: 'A', text: 'Active' }]);
    expect(mergeDomain(DOMAIN, { fixValues: [] }).properties.valueInformation?.fixValues)
      .toEqual([]);
    expect(mergeDomain(DOMAIN, { fixValues: [{ low: 'B', text: 'Blocked' }] })
      .properties.valueInformation?.fixValues)
      .toEqual([{ low: 'B', text: 'Blocked' }]);
  });

  it('keeps the value table when only the fixed values change, and the other way round', () => {
    expect(mergeDomain(DOMAIN, { fixValues: [] }).properties.valueInformation?.valueTableRef)
      .toBe('ZAPP_STATUS_T');
    expect(mergeDomain(DOMAIN, { valueTable: 'ZOTHER' }).properties.valueInformation?.fixValues)
      .toEqual([{ low: 'A', text: 'Active' }]);
  });

  it('upper-cases the data type and takes the output length from the type length', () => {
    const empty = {
      metaData: { ...DOMAIN.metaData, description: '' },
      properties: {
        typeInformation: { datatype: '', length: 0, decimals: 0 },
        outputInformation: {
          length: 0,
          signExists: false,
          lowercase: false,
          ampmFormat: false
        }
      }
    };
    const { properties } = mergeDomain(empty, { datatype: 'numc', length: 8 });
    expect(properties.typeInformation.datatype).toBe('NUMC');
    expect(properties.outputInformation.length).toBe(8);
    expect(properties.valueInformation).toBeUndefined();
  });

  it('accepts false as a value rather than treating it as absent', () => {
    const on = mergeDomain(DOMAIN, { lowercase: true }).properties.outputInformation;
    expect(on.lowercase).toBe(true);
    const off = mergeDomain(
      { ...DOMAIN, properties: { ...DOMAIN.properties, outputInformation: { ...DOMAIN.properties.outputInformation, lowercase: true } } },
      { lowercase: false }
    ).properties.outputInformation;
    expect(off.lowercase).toBe(false);
  });
});

describe('data element merge', () => {
  it('keeps every field the patch does not mention', () => {
    const { state } = mergeDataElement(ELEMENT, { description: 'Delivery status' });
    expect(state.properties).toEqual(ELEMENT.properties);
    expect(state.metaData.description).toBe('Delivery status');
  });

  it('switching to a built-in type clears the domain', () => {
    const { state } = mergeDataElement(ELEMENT, { dataType: 'dec', length: 13, decimals: 2 });
    expect(state.properties.typeName).toBe('');
    expect(state.properties.dataType).toBe('DEC');
    expect(state.properties.dataTypeLength).toBe(13);
    expect(state.properties.dataTypeDecimals).toBe(2);
  });

  it('naming a domain clears the built-in type, which the domain supplies', () => {
    const predefined = {
      ...ELEMENT,
      properties: { ...ELEMENT.properties, typeName: '', dataType: 'CHAR', dataTypeLength: 10 }
    };
    const { state } = mergeDataElement(predefined, { domain: 'zapp_other' });
    expect(state.properties.typeName).toBe('ZAPP_OTHER');
    expect(state.properties.dataType).toBe('');
    expect(state.properties.dataTypeLength).toBe(0);
  });

  it('refuses a domain and a built-in type at once', () => {
    expect(typeChoiceError({ domain: 'ZD', dataType: 'CHAR' })).toMatch(/either from a domain/);
    expect(typeChoiceError({ domain: 'ZD' })).toBeUndefined();
    expect(typeChoiceError({ dataType: 'CHAR' })).toBeUndefined();
  });

  it('fills all four labels from one label and reports what it cut', () => {
    const { state, truncated } = mergeDataElement(ELEMENT, { label: 'Status of the inbound delivery' });
    expect(state.properties.fieldLabels.shortFieldLabel).toBe('Status of');
    expect(state.properties.fieldLabels.mediumFieldLabel).toBe('Status of the inboun');
    expect(state.properties.fieldLabels.longFieldLabel).toBe('Status of the inbound delivery');
    expect(state.properties.fieldLabels.headingFieldLabel).toBe('Status of the inbound delivery');
    expect(truncated.map(t => t.label)).toEqual(['short', 'medium']);
    expect(truncated[0]).toEqual({ label: 'short', limit: 10, written: 'Status of' });
  });

  it('a specific label wins over the blanket one and short labels are left alone', () => {
    const { state, truncated } = mergeDataElement(ELEMENT, { label: 'Status', shortLabel: 'Stat' });
    expect(state.properties.fieldLabels.shortFieldLabel).toBe('Stat');
    expect(state.properties.fieldLabels.longFieldLabel).toBe('Status');
    expect(truncated).toEqual([]);
  });
});

describe('urls', () => {
  it('builds the object url from a name in any case', () => {
    expect(domainUrl('ZAPP_Status')).toBe('/sap/bc/adt/ddic/domains/zapp_status');
    expect(dataElementUrl(' ZAPP_STATUS ')).toBe('/sap/bc/adt/ddic/dataelements/zapp_status');
    expect(domainUrl('/BOFU/NAME')).toBe('/sap/bc/adt/ddic/domains/%2Fbofu%2Fname');
  });

  it('reads the name back out of a url', () => {
    expect(ddicNameOf('/sap/bc/adt/ddic/domains/zapp_status')).toBe('ZAPP_STATUS');
    expect(ddicNameOf('/sap/bc/adt/ddic/dataelements/%2Fbofu%2Fname')).toBe('/BOFU/NAME');
  });
});

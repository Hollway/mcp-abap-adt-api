import { ObjectDescriptionHandlers } from '../handlers/ObjectDescriptionHandlers';
import { lockRegistry } from '../lib/lockRegistry';
import {
  descriptionTarget,
  checkedDescription,
  parseDescriptionDocument,
  withDescription,
  DescriptionError
} from '../lib/objectDescription';

/**
 * The document is the one GET answered with, as EUD served it for a class: the
 * root element carries the description, the package is a child element, and
 * the rest (includes, links, syntax configuration) has to come back untouched
 * because UPDATE_METADATA reads more than the description out of it.
 */
const classDocument = (description: string, pkg = 'ZAPP') =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<class:abapClass class:final="true" class:visibility="public" abapsource:fixPointArithmetic="true"' +
  ' adtcore:masterLanguage="RU" adtcore:name="ZCL_APP_VACATION" adtcore:type="CLAS/OC" adtcore:version="active"' +
  ` adtcore:description="${description}" adtcore:descriptionTextLimit="60" adtcore:language="RU"` +
  ' xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core">' +
  `<adtcore:packageRef adtcore:uri="/sap/bc/adt/vit/wb/object_type/devck/object_name/${pkg}" adtcore:type="DEVC/K" adtcore:name="${pkg}"/>` +
  '<class:include class:includeType="main" abapsource:sourceUri="source/main" adtcore:name="" adtcore:description="not this one"/>' +
  '</class:abapClass>';

const inactiveRecord = (name: string, uri: string) => ({
  object: { 'adtcore:name': name, 'adtcore:type': 'CLAS/OC', 'adtcore:uri': uri, 'adtcore:parentUri': '/sap/bc/adt/packages/zapp' }
});

const URL = '/sap/bc/adt/oo/classes/zcl_app_vacation';

interface Harness {
  handlers: ObjectDescriptionHandlers;
  calls: string[];
  puts: any[];
}

/**
 * `documents` answers the GETs in turn, the last one repeated; `inactive`
 * answers inactiveObjects in turn the same way.
 */
const harness = (documents: string[], inactive: any[][] = [[]], over: Record<string, unknown> = {}): Harness => {
  const calls: string[] = [];
  const puts: any[] = [];
  const docs = [...documents];
  let lastDoc = documents[documents.length - 1];
  const lists = [...inactive];
  let lastList = inactive[inactive.length - 1];

  const client: any = {
    stateful: 'stateless',
    language: 'RU',
    httpClient: {
      request: async (url: string, config: any) => {
        const method = String(config?.method || 'GET').toUpperCase();
        calls.push(`${method} ${url}`);
        if (method === 'PUT') {
          puts.push({ url, ...config });
          return { body: '', headers: {} };
        }
        if (docs.length) lastDoc = docs.shift() as string;
        return { body: lastDoc, headers: { 'content-type': 'application/vnd.sap.adt.oo.classes.v2+xml; charset=utf-8' } };
      }
    },
    inactiveObjects: async () => {
      calls.push('inactive');
      if (lists.length) lastList = lists.shift() as any[];
      return lastList;
    },
    activate: async () => { calls.push('activate'); return { success: true, messages: [] }; },
    lock: async () => { calls.push('lock'); return { LOCK_HANDLE: 'HANDLE' }; },
    unLock: async () => { calls.push('unlock'); },
    ...over
  };
  client.statelessClone = client;
  return { handlers: new ObjectDescriptionHandlers(client), calls, puts };
};

const answer = (result: any) => JSON.parse(result.content[0].text);

beforeEach(() => lockRegistry.clear());

describe('descriptionTarget', () => {
  it('tells a class from an interface by the name', () => {
    expect(descriptionTarget('zcl_app').objectUrl).toBe('/sap/bc/adt/oo/classes/zcl_app');
    expect(descriptionTarget('ZCX_APP_FAILED').type).toBe('CLAS');
    expect(descriptionTarget('ZIF_APP_REPOSITORY')).toMatchObject({
      type: 'INTF',
      adtType: 'INTF/OI',
      objectUrl: '/sap/bc/adt/oo/interfaces/zif_app_repository'
    });
    expect(descriptionTarget('/ABC/CL_THING').type).toBe('CLAS');
  });

  it('asks for the type when the name does not say it, and takes it when given', () => {
    expect(() => descriptionTarget('ZAPP_HELPER')).toThrow(/objectType/);
    expect(descriptionTarget('ZAPP_HELPER', 'INTF/OI').type).toBe('INTF');
    expect(() => descriptionTarget('ZAPP_HELPER', 'PROG')).toThrow(/only CLAS and INTF/);
  });
});

describe('checkedDescription', () => {
  it('trims and refuses what the backend refuses', () => {
    expect(checkedDescription('  ZB:  отпуск   из вебхука ')).toBe('ZB: отпуск из вебхука');
    expect(() => checkedDescription('   ')).toThrow(DescriptionError);
    expect(() => checkedDescription('x'.repeat(61))).toThrow(/61 characters/);
    expect(checkedDescription('x'.repeat(60))).toHaveLength(60);
  });
});

describe('the metadata document', () => {
  it('reads the description of the root element, not of an include', () => {
    expect(parseDescriptionDocument(classDocument('Old &amp; tired'))).toEqual({
      description: 'Old & tired',
      packageName: 'ZAPP',
      masterLanguage: 'RU',
      language: 'RU',
      version: 'active'
    });
  });

  it('replaces only the description of the root element', () => {
    const before = classDocument('Old text');
    const after = withDescription(before, 'New "quoted" <text>');
    expect(after).toContain('adtcore:description="New &quot;quoted&quot; &lt;text&gt;"');
    expect(after).toContain('adtcore:description="not this one"');
    expect(after.replace('New &quot;quoted&quot; &lt;text&gt;', 'Old text')).toBe(before);
  });
});

describe('setObjectDescription', () => {
  it('writes the document read with the new description, then activates and reads it back', async () => {
    const { handlers, calls, puts } = harness(
      [classDocument('Old text'), classDocument('ZB: new text')],
      [[], [inactiveRecord('ZCL_APP_VACATION', URL)], []]
    );
    const result = answer(await handlers.handle('setObjectDescription', {
      name: 'ZCL_APP_VACATION', description: 'ZB: new text', transport: 'devk900123'
    }));

    expect(result).toMatchObject({
      status: 'success', written: true, activated: true, before: 'Old text', after: 'ZB: new text', packageName: 'ZAPP'
    });
    expect(calls).toEqual([
      `GET ${URL}`, 'inactive', 'lock', `PUT ${URL}`, 'unlock', 'inactive', 'activate', 'inactive', `GET ${URL}`
    ]);
    expect(puts[0].qs).toEqual({ lockHandle: 'HANDLE', corrNr: 'DEVK900123' });
    expect(puts[0].headers['Content-Type']).toBe('application/vnd.sap.adt.oo.classes.v2+xml');
    expect(puts[0].body).toBe(withDescription(classDocument('Old text'), 'ZB: new text'));
    expect(lockRegistry.count()).toBe(0);
  });

  it('writes nothing when the description is already the text', async () => {
    const { handlers, calls } = harness([classDocument('Same text')]);
    const result = answer(await handlers.handle('setObjectDescription', { name: 'ZCL_APP_VACATION', description: 'Same text' }));
    expect(result).toMatchObject({ status: 'success', written: false });
    expect(calls).toEqual([`GET ${URL}`]);
  });

  it('needs a transport outside a local package', async () => {
    const { handlers, calls } = harness([classDocument('Old text')]);
    await expect(handlers.handle('setObjectDescription', { name: 'ZCL_APP_VACATION', description: 'New' }))
      .rejects.toThrow(/transport request/);
    expect(calls).not.toContain('lock');

    const local = harness([classDocument('Old text', '$TMP'), classDocument('New', '$TMP')], [[], [inactiveRecord('ZCL_APP_VACATION', URL)], []]);
    const result = answer(await local.handlers.handle('setObjectDescription', { name: 'ZCL_APP_VACATION', description: 'New' }));
    expect(result.status).toBe('success');
    expect(local.puts[0].qs).toEqual({ lockHandle: 'HANDLE' });
  });

  it('refuses an object with inactive changes before it locks anything', async () => {
    const { handlers, calls } = harness(
      [classDocument('Old text')],
      [[inactiveRecord('ZCL_APP_VACATION', `${URL}/source/main`)]]
    );
    const result = answer(await handlers.handle('setObjectDescription', {
      name: 'ZCL_APP_VACATION', description: 'New', transport: 'DEVK900123'
    }));
    expect(result).toMatchObject({ status: 'error', written: false });
    expect(result.inactive).toEqual([{ name: 'ZCL_APP_VACATION', type: 'CLAS/OC' }]);
    expect(calls).not.toContain('lock');
  });

  it('skips the inactive check and the activation with activate false', async () => {
    const { handlers, calls } = harness([classDocument('Old text'), classDocument('New')]);
    const result = answer(await handlers.handle('setObjectDescription', {
      name: 'ZCL_APP_VACATION', description: 'New', transport: 'DEVK900123', activate: false
    }));
    expect(result).toMatchObject({ status: 'success', written: true, activated: false });
    expect(calls).toEqual([`GET ${URL}`, 'lock', `PUT ${URL}`, 'unlock', `GET ${URL}`]);
  });

  it('stops at the check on a dry run', async () => {
    const { handlers, calls } = harness([classDocument('Old text')]);
    const result = answer(await handlers.handle('setObjectDescription', {
      name: 'ZCL_APP_VACATION', description: 'New', transport: 'DEVK900123', dryRun: true
    }));
    expect(result).toMatchObject({ status: 'success', dryRun: true, written: false });
    expect(calls).toEqual([`GET ${URL}`, 'inactive']);
  });

  it('gives the lock back and reports when the backend refuses the write', async () => {
    const { handlers, calls } = harness([classDocument('Old text')], [[]], {
      httpClient: {
        request: async (url: string, config: any) => {
          const method = String(config?.method || 'GET').toUpperCase();
          calls.push(`${method} ${url}`);
          if (method === 'PUT') throw new Error('Description is too long');
          return { body: classDocument('Old text'), headers: {} };
        }
      }
    });
    const result = answer(await handlers.handle('setObjectDescription', {
      name: 'ZCL_APP_VACATION', description: 'New', transport: 'DEVK900123'
    }));
    expect(result).toMatchObject({ status: 'error', written: false });
    expect(calls).toContain('unlock');
    expect(lockRegistry.count()).toBe(0);
  });

  it('says so when the text reads back unchanged', async () => {
    const { handlers } = harness([classDocument('Old text')], [[], [inactiveRecord('ZCL_APP_VACATION', URL)], []]);
    const result = answer(await handlers.handle('setObjectDescription', {
      name: 'ZCL_APP_VACATION', description: 'New', transport: 'DEVK900123'
    }));
    expect(result).toMatchObject({ status: 'error', written: false, readBack: 'Old text' });
  });

  describe('with a component', () => {
    const source = (text: string) => [
      'CLASS zcl_app_vacation DEFINITION PUBLIC FINAL CREATE PUBLIC.',
      '  PUBLIC SECTION.',
      ...(text ? [`    "! <p class="shorttext synchronized" lang="ru">${text}</p>`] : []),
      '    METHODS run IMPORTING iv_id TYPE i.',
      'ENDCLASS.',
      'CLASS zcl_app_vacation IMPLEMENTATION.',
      '  METHOD run.',
      '  ENDMETHOD.',
      'ENDCLASS.'
    ].join('\r\n');

    const componentHarness = (current: string, fromTables: string, pkg = 'ZAPP') => {
      const h = harness([classDocument('Class text', pkg)], [[]], {
        getObjectSource: async () => current
      });
      const client = (h.handlers as any).adtclient;
      const plainRequest = client.httpClient.request;
      client.httpClient.request = async (url: string, config: any) => {
        if (url.endsWith('/source/main?withAbapDocFromShortTexts=true')) {
          h.calls.push(`GET ${url}`);
          return { body: fromTables, headers: {} };
        }
        return plainRequest(url, config);
      };
      const edit = jest.fn(async (_args: any) => ({ status: 'success', activated: true, steps: [] }));
      (h.handlers as any).editor.editObjectCore = edit;
      return { ...h, edit };
    };

    it('writes the ABAP Doc through editObject and checks the texts the tables give back', async () => {
      const { handlers, edit } = componentHarness(source(''), source('Запуск'));
      const result = answer(await handlers.handle('setObjectDescription', {
        name: 'ZCL_APP_VACATION', component: 'run', description: 'Запуск', parameters: { iv_id: 'Номер' }, transport: 'DEVK900123'
      }));
      expect(edit).toHaveBeenCalledTimes(1);
      const args = edit.mock.calls[0][0];
      expect(args).toMatchObject({ objectSourceUrl: `${URL}/source/main`, transport: 'DEVK900123', activate: true });
      expect(args.edits[0].insertion).toContain('lang="ru">Запуск</p>');
      // The texts read back carry the method text but not the parameter one.
      expect(result).toMatchObject({ status: 'error', written: true, component: 'RUN', after: 'Запуск' });
    });

    it('answers success when the tables give the texts back', async () => {
      const back = source('Запуск').replace('    METHODS run', '    "! @parameter iv_id | <p class="shorttext synchronized" lang="ru">Номер</p>\r\n    METHODS run');
      const { handlers } = componentHarness(source(''), back);
      const result = answer(await handlers.handle('setObjectDescription', {
        name: 'ZCL_APP_VACATION', component: 'run', description: 'Запуск', parameters: { iv_id: 'Номер' }, transport: 'DEVK900123'
      }));
      expect(result).toMatchObject({ status: 'success', written: true });
    });

    it('writes nothing when the ABAP Doc already says it, and needs a transport otherwise', async () => {
      const same = componentHarness(source('Запуск'), source('Запуск'));
      const result = answer(await same.handlers.handle('setObjectDescription', {
        name: 'ZCL_APP_VACATION', component: 'run', description: 'Запуск'
      }));
      expect(result).toMatchObject({ status: 'success', written: false });
      expect(same.edit).not.toHaveBeenCalled();

      const other = componentHarness(source(''), source(''));
      await expect(other.handlers.handle('setObjectDescription', {
        name: 'ZCL_APP_VACATION', component: 'run', description: 'Запуск'
      })).rejects.toThrow(/transport request/);
      expect(other.edit).not.toHaveBeenCalled();
    });
  });

  it('notes a master language other than the logon language', async () => {
    const doc = classDocument('Old text').replace('adtcore:masterLanguage="RU"', 'adtcore:masterLanguage="EN"');
    const { handlers } = harness([doc]);
    const result = answer(await handlers.handle('setObjectDescription', {
      name: 'ZCL_APP_VACATION', description: 'New', transport: 'DEVK900123', dryRun: true
    }));
    expect(result.note).toMatch(/master language .* EN/);
  });
});

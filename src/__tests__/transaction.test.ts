import {
  createTransactionSnippet,
  deleteTransactionSnippet,
  programFits,
  screenSql,
  transactionCode,
  transactionSpec
} from '../lib/transaction';
import { DdifError, parseDdifPrint } from '../lib/ddifWrite';

/**
 * A transaction is a TSTC row with its text and GUI flags, written by the SE93
 * modules. What is held here: what the insert does not check is checked
 * before it, nothing is committed until the row is proven, and a code outside
 * the customer namespace is never created.
 */
const report = {
  transaction: 'zapp_report',
  program: 'zapp_report_prog',
  shortText: 'Application report',
  packageName: '$TMP'
};

describe('transactionCode', () => {
  it('takes a customer code and refuses SAP namespace for a new one', () => {
    expect(transactionCode('zapp_report', true)).toBe('ZAPP_REPORT');
    expect(transactionCode('/ABC/TCODE', true)).toBe('/ABC/TCODE');
    expect(() => transactionCode('SE93', true)).toThrow(/customer namespace/);
    expect(transactionCode('SE93')).toBe('SE93');
  });

  it('holds the 20 characters of TSTC and refuses what no statement should carry', () => {
    expect(() => transactionCode('Z' + 'X'.repeat(20))).toThrow(/20/);
    expect(() => transactionCode("Z'; DELETE")).toThrow(DdifError);
  });
});

describe('transactionSpec', () => {
  it('makes a report transaction start on screen 1000 whatever is passed', () => {
    expect(transactionSpec({ ...report, screen: '0100' })).toMatchObject({ kind: 'report', screen: '1000', program: 'ZAPP_REPORT_PROG' });
  });

  it('pads a dialog screen and refuses a variant on it', () => {
    expect(transactionSpec({ ...report, type: 'dialog', screen: '100' }).screen).toBe('0100');
    expect(() => transactionSpec({ ...report, type: 'dialog', screen: '100', variant: 'V1' })).toThrow(/variant/);
  });

  it('wants a title that fits TSTCT and a language that is one', () => {
    expect(() => transactionSpec({ ...report, shortText: '' })).toThrow(/shortText/);
    expect(() => transactionSpec({ ...report, shortText: 'X'.repeat(37) })).toThrow(/36/);
    expect(() => transactionSpec({ ...report, language: 'RUS' })).toThrow(/language/);
  });

  it('turns both GUI flags on unless told otherwise', () => {
    expect(transactionSpec(report)).toMatchObject({ wingui: true, html: true });
    expect(transactionSpec({ ...report, html: false })).toMatchObject({ wingui: true, html: false });
  });
});

describe('the checks before the insert', () => {
  it('lets a report transaction start only an executable program', () => {
    expect(programFits('report', '1')).toBe(true);
    expect(programFits('report', 'M')).toBe(false);
    expect(programFits('dialog', 'M')).toBe(true);
    expect(programFits('dialog', 'I')).toBe(false);
  });

  it('looks the screen up by program and number', () => {
    expect(screenSql('ZAPP_REPORT_PROG', '1000')).toBe("SELECT prog, dnum FROM d020s WHERE prog = 'ZAPP_REPORT_PROG' AND dnum = '1000'");
  });
});

describe('createTransactionSnippet', () => {
  it('inserts a report transaction, proves the TSTC row, then commits', () => {
    const text = createTransactionSnippet(transactionSpec({ ...report, variant: 'DEFAULT' })).code.join('\n');
    const order = ["CALL FUNCTION 'RPY_TRANSACTION_INSERT'", 'SELECT COUNT(*) FROM tstc', 'COMMIT WORK AND WAIT.'];
    let at = -1;
    for (const marker of order) {
      const next = text.indexOf(marker, at + 1);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(text).toContain("transaction_type = 'R'");
    expect(text).toContain("dynpro = '1000'");
    expect(text).toContain("variant = 'DEFAULT'");
    expect(text).toContain("wingui_enabled = 'X' html_enabled = 'X'");
    expect(text).toContain('language = lv_langu');
  });

  it('passes the request outside a $ package and needs one there', () => {
    const spec = { ...transactionSpec({ ...report, packageName: 'ZAPP' }), request: 'DEVK900123' };
    expect(createTransactionSnippet(spec).code.join('\n')).toContain("transport_number = 'DEVK900123'");
    expect(() => createTransactionSnippet({ ...spec, request: undefined })).toThrow(/transport request/);
  });

  it('names the refusal of the module by its exception', () => {
    const { exceptions } = createTransactionSnippet(transactionSpec(report));
    expect(parseDdifPrint('STEP~#~insert~#~2~#~0~#~SEUK~#~071~#~exists', exceptions).steps[0].exception).toBe('ALREADY_EXIST');
  });
});

describe('deleteTransactionSnippet', () => {
  it('deletes, proves TSTC empty, removes the directory entry of a local one, commits', () => {
    const text = deleteTransactionSnippet({ code: 'ZAPP_REPORT', packageName: '$TMP' }).code.join('\n');
    const order = ["CALL FUNCTION 'RPY_TRANSACTION_DELETE'", 'SELECT COUNT(*) FROM tstc', "CALL FUNCTION 'TR_TADIR_INTERFACE'", 'COMMIT WORK AND WAIT.'];
    let at = -1;
    for (const marker of order) {
      const next = text.indexOf(marker, at + 1);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
  });

  it('records a transportable one through the module and leaves TADIR to the transport', () => {
    const text = deleteTransactionSnippet({ code: 'ZAPP_REPORT', packageName: 'ZAPP', request: 'DEVK900123' }).code.join('\n');
    expect(text).toContain("transport_number = 'DEVK900123'");
    expect(text).not.toContain('TR_TADIR_INTERFACE');
    expect(() => deleteTransactionSnippet({ code: 'ZAPP_REPORT', packageName: 'ZAPP' })).toThrow(/transport request/);
  });

  it('keeps the misspelled exception of the module', () => {
    const { exceptions } = deleteTransactionSnippet({ code: 'ZAPP_REPORT', packageName: '$TMP' });
    expect(parseDdifPrint('STEP~#~delete~#~1~#~0~#~~#~~#~', exceptions).steps[0].exception).toBe('NOT_EXCECUTED');
  });
});

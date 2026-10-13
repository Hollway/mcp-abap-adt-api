import {
  DdifError,
  OTHERS_SUBRC,
  activationVerdict,
  correctionStep,
  ddicObjectName,
  failedStep,
  packageName,
  parseDdifPrint,
  recordedSql,
  requestFrom,
  stepLines,
  textLiteral,
  wholeNumber
} from '../lib/ddifWrite';
import { domainDdifSnippet } from '../lib/domainDdif';
import { MAX_QUERY_CHARS } from '../lib/queryLimits';

/**
 * The DDIF path writes dictionary objects on a live system, and the three
 * things that went wrong when it was done by hand are held here:
 *
 *  - sy-subrc read after out->write is always 0, so a failed step passed;
 *  - RS_CORR_INSERT with a task number answers TK 886 and the write still
 *    goes through, with no directory entry and nothing in any request;
 *  - a step that failed did not stop the next one from running.
 */
describe('ddicObjectName', () => {
  it('upper-cases and accepts customer and namespaced names', () => {
    expect(ddicObjectName(' zapp_status ', 'domain')).toBe('ZAPP_STATUS');
    expect(ddicObjectName('/ABC/STATUS', 'domain')).toBe('/ABC/STATUS');
  });

  it('refuses what would need escaping, and what is too long', () => {
    expect(() => ddicObjectName("Z'X", 'domain')).toThrow(DdifError);
    expect(() => ddicObjectName('1ABC', 'domain')).toThrow(DdifError);
    expect(() => ddicObjectName('', 'domain')).toThrow(/Which domain/);
    expect(() => ddicObjectName('Z'.repeat(31), 'domain')).toThrow(/30/);
    expect(() => ddicObjectName('ZTABLE_NAME_TOO_LONG', 'table', 16)).toThrow(/16/);
  });
});

describe('packageName', () => {
  it('takes $ packages and dictionary-style names', () => {
    expect(packageName('$tmp')).toBe('$TMP');
    expect(packageName('zapp_core')).toBe('ZAPP_CORE');
    expect(() => packageName('')).toThrow(/Which package/);
    expect(() => packageName('$T MP')).toThrow(DdifError);
  });
});

describe('textLiteral and wholeNumber', () => {
  it('doubles quotes and refuses a text that does not fit rather than cutting it', () => {
    expect(textLiteral("Bob's", 'text', 60)).toBe("'Bob''s'");
    expect(() => textLiteral('x'.repeat(61), 'description', 60)).toThrow(/61 characters/);
    expect(() => textLiteral('a\nb', 'description', 60)).toThrow(/line break/);
  });

  it('takes whole numbers in bounds only', () => {
    expect(wholeNumber('12', 'length', 1, 100)).toBe(12);
    expect(() => wholeNumber(1.5, 'length', 1, 100)).toThrow(/whole number/);
    expect(() => wholeNumber(0, 'length', 1, 100)).toThrow(/1 to 100/);
  });
});

describe('stepLines', () => {
  const lines = stepLines({
    step: 'put',
    call: ["CALL FUNCTION 'DDIF_DOMA_PUT'", "  EXPORTING name = 'Z'"],
    exceptions: ['DOMA_NOT_FOUND', 'PUT_FAILURE']
  });

  it('keeps sy-subrc before anything can reset it', () => {
    const call = lines.findIndex(line => line.includes('EXCEPTIONS'));
    expect(lines[call + 1]).toBe('lv_subrc = sy-subrc.');
    const write = lines.findIndex(line => line.startsWith('out->write'));
    expect(write).toBeGreaterThan(call + 1);
    expect(lines[write]).toContain('{ lv_subrc }');
  });

  it('numbers the exceptions in order and maps OTHERS apart', () => {
    expect(lines.find(line => line.includes('EXCEPTIONS'))).toBe(
      `  EXCEPTIONS doma_not_found = 1 put_failure = 2 OTHERS = ${OTHERS_SUBRC}.`
    );
  });

  it('stops on a failure, and on an activation rc above 4 when asked', () => {
    expect(lines).toContain('IF lv_subrc <> 0.');
    const activation = stepLines({ step: 'activate', call: ['CALL FUNCTION \'X\''], rc: true });
    expect(activation).toContain('IF lv_subrc <> 0 OR lv_rc > 4.');
    expect(activation[0]).toBe('CLEAR lv_rc.');
    const goOn = stepLines({ step: 'x', call: ['CALL FUNCTION \'X\''], continueOnFailure: true });
    expect(goOn.join('\n')).not.toContain('RETURN');
  });
});

describe('correctionStep', () => {
  it('hands over the request and lets the module pick the caller task', () => {
    const step = correctionStep({ objectType: 'DOMA', name: 'ZX', packageName: 'ZPKG', request: 'devk900123', mode: 'I' });
    const text = step.call.join('\n');
    expect(text).toContain("object = 'DOMAZX'");
    expect(text).toContain("korrnum = 'DEVK900123'");
    // With it the entry lands on the request header, owned by nobody.
    expect(text).not.toContain('use_korrnum_immediatedly');
    expect(text).toContain('IMPORTING korrnum = lv_korrnum ordernum = lv_ordernum');
    expect(text).toContain("mode = 'I'");
    expect(text).toContain("suppress_dialog = 'X'");
  });

  it('goes without a request in a $ package, and refuses one missing elsewhere', () => {
    const local = correctionStep({ objectType: 'DOMA', name: 'ZX', packageName: '$TMP', mode: 'I' });
    expect(local.call.join('\n')).not.toContain("korrnum = '");
    expect(() => correctionStep({ objectType: 'DOMA', name: 'ZX', packageName: 'ZPKG', mode: 'I' }))
      .toThrow(/transport request/);
  });
});

describe('requestFrom', () => {
  const request = { TRKORR: 'DEVK900100', STRKORR: '', TRSTATUS: 'D', TRFUNCTION: 'K' };

  it('takes an open workbench request as it is', () => {
    expect(requestFrom('devk900100', request)).toEqual({ request: 'DEVK900100' });
  });

  it('lifts a task to its request - a task answers TK 886', () => {
    const task = { TRKORR: 'DEVK900101', STRKORR: 'DEVK900100', TRSTATUS: 'D', TRFUNCTION: 'S' };
    expect(requestFrom('DEVK900101', task, request)).toEqual({ request: 'DEVK900100', fromTask: 'DEVK900101' });
  });

  it('refuses what cannot take the object', () => {
    expect(() => requestFrom('DEVK900100', undefined)).toThrow(/does not exist/);
    expect(() => requestFrom('DEVK900100', { ...request, TRSTATUS: 'R' })).toThrow(/not modifiable/);
    expect(() => requestFrom('DEVK900100', { ...request, TRFUNCTION: 'W' })).toThrow(/workbench/);
    expect(() => requestFrom('DEVK900101', { STRKORR: 'DEVK900100', TRSTATUS: 'D' })).toThrow(/could not be read/);
  });
});

describe('parseDdifPrint', () => {
  const output = [
    'STEP~#~transport~#~0~#~0~#~~#~003~#~',
    '',
    'INFO~#~korrnum~#~DEVK900100',
    'STEP~#~put~#~0~#~0~#~~#~003~#~',
    'STEP~#~activate~#~0~#~8~#~D0~#~322~#~Activation errors',
    ''
  ].join('\n');

  it('reads steps, judges them by subrc and rc, and ignores the empty-ID noise message', () => {
    const print = parseDdifPrint(output, { put: ['DOMA_NOT_FOUND'] });
    expect(print.steps.map(step => [step.step, step.ok])).toEqual([
      ['transport', true],
      ['put', true],
      ['activate', false]
    ]);
    expect(print.steps[0].message).toBeUndefined();
    expect(print.steps[2]).toMatchObject({ rc: 8, message: 'Activation errors', messageId: 'D0', messageNumber: '322' });
    expect(print.info).toEqual({ korrnum: 'DEVK900100' });
    expect(failedStep(print)?.step).toBe('activate');
  });

  it('keeps a message only where it explains a failure', () => {
    const print = parseDdifPrint([
      'STEP~#~transport~#~0~#~0~#~SCTS_CTO_CUST_SYNC~#~003~#~Sync',
      'STEP~#~activate~#~0~#~0~#~D0~#~322~#~Closing phase 004 ****',
      'STEP~#~put~#~4~#~0~#~SCTS_CTO_CUST_SYNC~#~003~#~Sync'
    ].join('\n'));
    expect(print.steps.map(step => step.message)).toEqual([undefined, undefined, undefined]);
  });

  it('names the exception a subrc stands for', () => {
    const print = parseDdifPrint(
      `STEP~#~put~#~2~#~0~#~~#~000~#~\nSTEP~#~transport~#~${OTHERS_SUBRC}~#~0~#~TK~#~886~#~Wrong`,
      { put: ['DOMA_NOT_FOUND', 'NAME_INCONSISTENT'] }
    );
    expect(print.steps[0].exception).toBe('NAME_INCONSISTENT');
    expect(print.steps[1].exception).toBe('OTHERS');
  });
});

describe('activationVerdict', () => {
  it('reads 4 as active and 8 as not', () => {
    expect(activationVerdict(4)).toMatch(/warnings/);
    expect(activationVerdict(8)).toMatch(/Not activated/);
  });
});

describe('the read-back queries', () => {
  it('stay under the query endpoint limit with the longest name', () => {
    expect(recordedSql('DOMA', 'Z'.repeat(30)).length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
  });
});

describe('domainDdifSnippet', () => {
  const base = {
    name: 'zmcp_status',
    description: 'Status',
    packageName: 'ZPKG',
    request: 'DEVK900100',
    datatype: 'char',
    length: 2
  };

  it('registers, writes, activates - in that order', () => {
    const { code } = domainDdifSnippet(base);
    const text = code.join('\n');
    const at = (needle: string) => text.indexOf(needle);
    expect(at("'RS_CORR_INSERT'")).toBeGreaterThan(-1);
    expect(at("'RS_CORR_INSERT'")).toBeLessThan(at("'DDIF_DOMA_PUT'"));
    expect(at("'DDIF_DOMA_PUT'")).toBeLessThan(at("'DDIF_DOMA_ACTIVATE'"));
    expect(text).toContain("ls_dd01v-datatype = 'CHAR'.");
    expect(text).toContain('ls_dd01v-leng = 2.');
    expect(text).toContain('ls_dd01v-outputlen = 2.');
    expect(text).toContain("object = 'DOMAZMCP_STATUS'");
  });

  it('writes fixed values with their positions and sets the flag', () => {
    const { code } = domainDdifSnippet({ ...base, fixValues: [{ low: 'A', text: 'Alpha' }, { low: '1', high: '9', text: 'Digit' }] });
    const text = code.join('\n');
    expect(text).toContain("ls_dd01v-valexi = 'X'.");
    expect(text).toContain("valpos = '0001'");
    expect(text).toContain("valpos = '0002'");
    expect(text).toContain("domvalue_h = '9'");
    expect(text).toContain('TABLES dd07v_tab = lt_dd07v');
  });

  it('leaves the activation out when asked', () => {
    expect(domainDdifSnippet({ ...base, activate: false }).code.join('\n')).not.toContain('DDIF_DOMA_ACTIVATE');
  });

  it('refuses what would be cut or makes no sense', () => {
    expect(() => domainDdifSnippet({ ...base, fixValues: [{ low: 'TOO_LONG_VALUE' }] })).toThrow(/holds 10/);
    expect(() => domainDdifSnippet({ ...base, fixValues: [{ low: '' }] })).toThrow(/no low value/);
    expect(() => domainDdifSnippet({ ...base, datatype: 'CH AR' })).toThrow(/data type/);
    expect(() => domainDdifSnippet({ ...base, conversionExit: 'TOOLONG' })).toThrow(/conversion exit/);
    expect(() => domainDdifSnippet({ ...base, length: 0 })).toThrow(/length/);
  });
});

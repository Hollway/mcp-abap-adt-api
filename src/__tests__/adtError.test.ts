import { AdtErrorException, adtException } from 'abap-adt-api';
import {
  describeAdtError,
  errorPayload,
  isSessionFailure,
  wrapAdtError,
  AdtToolError
} from '../lib/adtError';

/**
 * The distinction these tests protect: a dead ADT session and a real SAP
 * rejection both surface as an HTTP 400, and the server retries the first while
 * it must never retry the second. What separates them is whether the backend
 * sent an exc:exception document - the library turns a body-less failure into
 * an AdtErrorException with an empty type via simpleError().
 */
describe('describeAdtError', () => {
  it('keeps the SAP diagnosis of a real rejection', () => {
    const err = new AdtErrorException(
      400,
      { 'T100KEY-ID': 'SEUC', 'T100KEY-NO': '007' },
      'ExceptionInvalidParameter',
      'Wrong type',
      undefined,
      'com.sap.adt',
      'Недопустимый тип'
    );
    const info = describeAdtError(err);
    expect(info).toMatchObject({
      status: 400,
      adtType: 'ExceptionInvalidParameter',
      t100: 'SEUC-007',
      localizedMessage: 'Недопустимый тип',
      namespace: 'com.sap.adt',
      sapMessage: 'Wrong type',
      diagnostic: 'sap'
    });
    expect(info.error).toBe('Недопустимый тип');
  });

  it('marks an undiagnosed HTTP failure as transport', () => {
    const info = describeAdtError(adtException('Error 400:Bad Request', 400));
    expect(info.diagnostic).toBe('transport');
    expect(info.status).toBe(400);
    expect(info.adtType).toBeUndefined();
  });

  it('falls back to the message of a plain error', () => {
    expect(describeAdtError(new Error('boom'))).toMatchObject({
      error: 'boom',
      diagnostic: 'transport'
    });
  });
});

describe('wrapAdtError', () => {
  it('prefixes the label and keeps the original as cause', () => {
    const original = new AdtErrorException(404, {}, 'ExceptionResourceNotFound', 'missing');
    const wrapped = wrapAdtError(original, 'Failed to get object source');
    expect(wrapped).toBeInstanceOf(AdtToolError);
    expect(wrapped.info.error).toBe('Failed to get object source: missing');
    expect(wrapped.message).toContain('Failed to get object source: missing');
    expect(wrapped.cause).toBe(original);
  });

  it('rethrows an McpError from argument validation untouched', () => {
    const { McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');
    const invalid = new McpError(ErrorCode.InvalidParams, 'version must be one of ...');
    expect(() => wrapAdtError(invalid, 'Failed to get object source')).toThrow(invalid);
  });
});

describe('errorPayload', () => {
  it('omits empty fields and never duplicates the message', () => {
    const payload = errorPayload(
      wrapAdtError(new AdtErrorException(404, {}, 'ExceptionResourceNotFound', 'missing'), 'Failed')
    );
    expect(payload).toEqual({
      error: 'Failed: missing',
      diagnostic: 'sap',
      status: 404,
      adtType: 'ExceptionResourceNotFound',
      sapMessage: 'missing'
    });
  });
});

describe('isSessionFailure', () => {
  const cases: [string, unknown, boolean][] = [
    ['undiagnosed 400', adtException('Error 400:Bad Request', 400), true],
    ['undiagnosed 403', adtException('Error 403:Forbidden', 403), true],
    ['SAP 400 with a type', new AdtErrorException(400, {}, 'ExceptionInvalidParameter', 'no'), false],
    ['SAP 404', new AdtErrorException(404, {}, 'ExceptionResourceNotFound', 'no'), false],
    ['SAP 403 authorization', new AdtErrorException(403, {}, 'ExceptionAuthorization', 'no'), false],
    ['undiagnosed 500', adtException('Error 500:Internal', 500), false],
    ['plain error', new Error('boom'), false]
  ];

  it.each(cases)('%s -> %s', (_label, error, expected) => {
    expect(isSessionFailure(wrapAdtError(error, 'test'))).toBe(expected);
    // the same verdict must hold for the unwrapped exception
    expect(isSessionFailure(error)).toBe(expected);
  });
});

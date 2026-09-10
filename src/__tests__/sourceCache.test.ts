import { sourceCache, sourceCacheKey } from '../lib/sourceCache';

/**
 * The cache exists so a syntax check can reuse the source last read or written
 * instead of making the model re-send it. That is safe while the object is
 * there; the one event that turns a stale entry into a wrong answer is the
 * object being deleted, so forgetUnder has to reach every key that belongs to
 * it - the plain source URL, the versions kept under their own keys, and the
 * includes of a class, which hang below the class URL.
 */
const CLASS = '/sap/bc/adt/oo/classes/zdev_mcp_cls';

beforeEach(() => sourceCache.clear());

describe('sourceCacheKey', () => {
  it('keeps the working version on the plain url', () => {
    expect(sourceCacheKey(`${CLASS}/source/main`)).toBe(`${CLASS}/source/main`);
    expect(sourceCacheKey(`${CLASS}/source/main`, 'inactive')).toBe(`${CLASS}/source/main`);
  });

  it('stores an explicitly requested version apart, so it cannot shadow the working one', () => {
    expect(sourceCacheKey(`${CLASS}/source/main`, 'active'))
      .toBe(`${CLASS}/source/main?version=active`);
  });
});

describe('sourceCache.forgetUnder', () => {
  it('drops the source, the versions and the class includes of one object', () => {
    sourceCache.set(`${CLASS}/source/main`, 'CLASS zdev_mcp_cls DEFINITION.');
    sourceCache.set(sourceCacheKey(`${CLASS}/source/main`, 'active'), 'active text');
    sourceCache.set(`${CLASS}/includes/testclasses/source/main`, 'CLASS ltcl_test.');
    sourceCache.set(CLASS, 'the object url itself');

    expect(sourceCache.forgetUnder(CLASS)).toBe(4);
    expect(sourceCache.has(`${CLASS}/source/main`)).toBe(false);
    expect(sourceCache.has(`${CLASS}/includes/testclasses/source/main`)).toBe(false);
  });

  // A name that merely starts with the same characters is a different object.
  it('leaves an object whose name only shares a prefix', () => {
    sourceCache.set('/sap/bc/adt/oo/classes/zdev_mcp_cls_helper/source/main', 'other class');
    expect(sourceCache.forgetUnder(CLASS)).toBe(0);
    expect(sourceCache.has('/sap/bc/adt/oo/classes/zdev_mcp_cls_helper/source/main')).toBe(true);
  });

  it('tolerates a trailing slash and an empty url', () => {
    sourceCache.set(`${CLASS}/source/main`, 'text');
    expect(sourceCache.forgetUnder(`${CLASS}/`)).toBe(1);
    expect(sourceCache.forgetUnder('')).toBe(0);
    expect(sourceCache.forgetUnder(undefined as any)).toBe(0);
  });

  it('deletes one entry on its own too', () => {
    sourceCache.set(`${CLASS}/source/main`, 'text');
    sourceCache.delete(`${CLASS}/source/main`);
    expect(sourceCache.get(`${CLASS}/source/main`)).toBeUndefined();
  });
});

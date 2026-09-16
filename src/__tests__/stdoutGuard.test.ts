import { protectStdout } from '../lib/stdoutGuard';

/**
 * Over stdio, stdout carries the protocol: a dependency that prints there
 * breaks the conversation. abap-adt-api prints its change-package refactoring
 * with a plain console.log, and the workaround used to be a swap of
 * console.log around that one call - which only ever covered that one call.
 */
describe('protectStdout', () => {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    debug: console.debug,
    error: console.error
  };

  afterEach(() => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.debug = original.debug;
    console.error = original.error;
  });

  const spyConsole = () => {
    const written: string[] = [];
    const fake = {
      log: () => { written.push('stdout'); },
      info: () => { written.push('stdout'); },
      warn: () => { written.push('stdout'); },
      debug: () => { written.push('stdout'); },
      error: (...parts: unknown[]) => { written.push(`stderr:${parts.join(' ')}`); }
    } as unknown as Console;
    return { fake, written };
  };

  it('sends every level console prints to stderr', () => {
    const { fake, written } = spyConsole();
    const restore = protectStdout(fake);

    fake.log('changePackageRefactoring here', '{}');
    fake.info('info');
    fake.warn('warn');
    fake.debug('debug');

    expect(written).toEqual([
      'stderr:changePackageRefactoring here {}',
      'stderr:info',
      'stderr:warn',
      'stderr:debug'
    ]);
    restore();
  });

  it('leaves console.error alone - it was already on stderr', () => {
    const { fake, written } = spyConsole();
    const restore = protectStdout(fake);
    fake.error('boom');
    expect(written).toEqual(['stderr:boom']);
    restore();
  });

  it('puts the original methods back when restored', () => {
    const { fake, written } = spyConsole();
    const restore = protectStdout(fake);
    restore();
    fake.log('after');
    expect(written).toEqual(['stdout']);
  });
});

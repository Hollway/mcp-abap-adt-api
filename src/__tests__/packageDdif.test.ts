import { packageDdifSnippet, packageRowSql } from '../lib/packageDdif';

/**
 * The package fallback runs SE21's own API in a throwaway class. What is held
 * here: the component and layer are fixed (HOME and Z* for a transportable
 * package, LOCAL and none for a $ one), the request is handed to save - which
 * picks the caller's task - and the lock comes off even when save fails.
 */
describe('packageDdifSnippet', () => {
  it('builds a transportable package with HOME and Z* and saves it into the request', () => {
    const snippet = packageDdifSnippet({
      name: 'zapp_core',
      description: 'Core',
      superPackage: 'zapp',
      request: 'DEVK900100'
    });
    const text = snippet.code.join('\n');
    expect(snippet.softwareComponent).toBe('HOME');
    expect(snippet.transportLayer).toBe('Z*');
    expect(text).toContain("ls_package-devclass = 'ZAPP_CORE'.");
    expect(text).toContain("ls_package-dlvunit = 'HOME'.");
    expect(text).toContain("ls_package-pdevclass = 'Z*'.");
    expect(text).toContain("ls_package-parentcl = 'ZAPP'.");
    expect(text).toContain('ls_package-korrflag = abap_true.');
    expect(text).toContain("i_transport_request = 'DEVK900100'");
  });

  it('builds a local package without layer or request', () => {
    const snippet = packageDdifSnippet({ name: '$zapp_tmp', description: 'Scratch', request: 'DEVK900100' });
    const text = snippet.code.join('\n');
    expect(snippet.softwareComponent).toBe('LOCAL');
    expect(snippet.transportLayer).toBeUndefined();
    expect(text).not.toContain('pdevclass');
    expect(text).not.toContain('i_transport_request');
    expect(text).toContain('ls_package-korrflag = abap_false.');
  });

  it('releases the lock even after a failed save, but stops after a failed create', () => {
    const text = packageDdifSnippet({ name: 'ZAPP', description: 'App', request: 'DEVK900100' }).code.join('\n');
    const create = text.indexOf('create_new_package');
    const save = text.indexOf('lo_package->save');
    const unlock = text.indexOf('lo_package->set_changeable');
    expect(create).toBeLessThan(save);
    expect(save).toBeLessThan(unlock);
    const between = (from: number, to: number) => text.slice(from, to);
    expect(between(create, save)).toContain('RETURN');
    expect(between(save, unlock)).not.toContain('RETURN');
  });

  it('refuses a description that does not fit, and a name that is not one', () => {
    expect(() => packageDdifSnippet({ name: 'ZAPP', description: 'x'.repeat(61) })).toThrow(/60/);
    expect(() => packageDdifSnippet({ name: "Z'APP", description: 'App' })).toThrow(/package name/);
  });

  it('reads the row back by the checked name', () => {
    expect(packageRowSql('zapp')).toContain("devclass = 'ZAPP'");
  });
});

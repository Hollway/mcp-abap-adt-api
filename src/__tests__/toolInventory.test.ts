import { AbapAdtServer } from '../index';
import { TOOL_PRESETS } from '../lib/toolFilter';
import { serverVersion } from '../lib/serverConfig';

/**
 * A preset is a list of group and tool names written by hand, and a name that
 * matches nothing narrows the server silently: the tools simply are not there,
 * and the only sign of it is a session that cannot do what the preset promised.
 * So every token of every preset is checked against the tools this server
 * really serves - which is also what the server now reports about the free-form
 * lists beside them.
 */
const server = () => new AbapAdtServer({ baseUrl: 'https://example.invalid' } as any);

const tools = (instance: any): string[] => instance.exposedTools().map((tool: any) => tool.name);

describe('tool presets', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  const clear = () => {
    delete process.env.SAP_TOOLS_PROFILE;
    delete process.env.SAP_TOOLS_INCLUDE;
    delete process.env.SAP_TOOLS_EXCLUDE;
    delete process.env.SAP_READONLY;
    delete process.env.SAP_READONLY_ALLOW;
  };

  it.each(Object.keys(TOOL_PRESETS))('%s names only groups and tools that exist', name => {
    clear();
    process.env.SAP_TOOLS_PROFILE = name;
    const instance = server() as any;
    expect(instance.unknownTokens()).toEqual([]);
    // And it has to serve something, or the preset is a way to switch the
    // server off by accident.
    expect(tools(instance).length).toBeGreaterThan(5);
  });

  it('serves the graph tools under the graph preset and leaves the writes out', () => {
    clear();
    process.env.SAP_TOOLS_PROFILE = 'graph';
    const served = tools(server() as any);
    for (const name of ['abapGraph', 'callsFrom', 'impactOf', 'abapPath', 'usageReferences', 'getObjectSource']) {
      expect(served).toContain(name);
    }
    for (const name of ['setObjectSource', 'deleteObject', 'activateSafe', 'addMethod']) {
      expect(served).not.toContain(name);
    }
    expect(served).toContain('healthcheck');
  });

  it('serves the checks under the atc preset', () => {
    clear();
    process.env.SAP_TOOLS_PROFILE = 'atc';
    const served = tools(server() as any);
    expect(served).toContain('atcCheck');
    expect(served).toContain('atcWorklists');
    expect(served).not.toContain('abapGraph');
  });

  it('names a token that matches nothing, in whichever list it was written', () => {
    clear();
    process.env.SAP_TOOLS_INCLUDE = 'source,sources';
    process.env.SAP_TOOLS_EXCLUDE = 'debuger';
    process.env.SAP_READONLY_ALLOW = 'lock,locks';
    expect((server() as any).unknownTokens()).toEqual(['debuger', 'locks', 'sources']);
  });

  it('reports the version of the package it was built from', () => {
    // The literal in the constructor said 1.0.0 while the package was at
    // 1.3.0, so the one place a client can ask which build it is talking to
    // gave a number nobody had shipped.
    const version = serverVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version).not.toBe('0.0.0');
    expect(version).toBe(require('../../package.json').version);
  });
});

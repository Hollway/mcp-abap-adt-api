import { buildGraph, functionModulesOf } from '../lib/abapGraph';
import type { ScannedObject } from '../lib/abapGraph';
import type { CallKind, CallSite } from '../lib/abapCalls';

const call = (target: string, kind: CallKind, line = 1, member?: string): CallSite => ({
  target,
  kind,
  line,
  statement: `${target}${member ? `=>${member}( )` : ''}`,
  ...(member ? { member } : {})
});

/**
 * A package as they really are: a class that calls a helper twice and itself
 * once, a helper that calls a function module by its own name rather than by
 * the name of the group that holds it, the group calling back into the class,
 * and one object nothing touches.
 */
const PACKAGE: ScannedObject[] = [
  {
    name: 'ZCL_A',
    objectType: 'CLAS/OC',
    packageName: 'ZAPP',
    calls: [
      call('ZCL_B', 'method', 10, 'ADD'),
      call('ZCL_B', 'method', 12, 'SAVE'),
      call('ZCL_A', 'method', 14, 'OWN'),
      call('ZORDERS', 'table', 20)
    ]
  },
  {
    name: 'ZCL_B',
    objectType: 'CLAS/OC',
    packageName: 'ZAPP',
    calls: [call('Z_APP_SAVE', 'function', 5)]
  },
  {
    name: 'ZAPP_FG',
    objectType: 'FUGR/F',
    packageName: 'ZAPP',
    provides: ['Z_APP_SAVE'],
    calls: [call('ZCL_A', 'method', 7, 'RUN')]
  },
  {
    name: 'ZCL_LONELY',
    objectType: 'CLAS/OC',
    packageName: 'ZAPP',
    calls: []
  }
];

describe('buildGraph', () => {
  const graph = buildGraph(PACKAGE);

  it('matches a function module to the group that defines it', () => {
    const edge = graph.edges.find(e => e.from === 'ZCL_B');
    expect(edge).toMatchObject({ to: 'ZAPP_FG', kinds: ['function'], calls: 1 });
    expect(graph.outside.some(entry => entry.target === 'Z_APP_SAVE')).toBe(false);
  });

  it('counts the calls between two objects as one edge', () => {
    const edge = graph.edges.find(e => e.from === 'ZCL_A' && e.to === 'ZCL_B');
    expect(edge?.calls).toBe(2);
    expect(graph.edges).toHaveLength(3);
  });

  it('keeps a call an object makes to itself off the graph and on the object', () => {
    expect(graph.edges.some(edge => edge.from === edge.to)).toBe(false);
    expect(graph.nodes.find(node => node.name === 'ZCL_A')?.selfCalls).toBe(1);
  });

  it('names the objects nothing inside the package reaches, and the one nothing touches at all', () => {
    // Every object here is called by another except the lonely one, which is
    // why it is an orphan rather than an entry point: an entry point calls.
    expect(graph.orphans).toEqual(['ZCL_LONELY']);
    expect(graph.entryPoints).toEqual([]);
    expect(graph.hubs[0].callsIn).toBeGreaterThan(0);
  });

  it('finds the circle the calls run in, reported from its smallest name', () => {
    expect(graph.cycles).toHaveLength(1);
    expect([...graph.cycles[0]].sort()).toEqual(['ZAPP_FG', 'ZCL_A', 'ZCL_B']);
    expect(graph.cycles[0][0]).toBe('ZAPP_FG');
  });

  it('reports what the package as a whole depends on outside itself', () => {
    expect(graph.outside).toEqual([
      { target: 'ZORDERS', kinds: ['table'], calls: 1, from: ['ZCL_A'] }
    ]);
  });

  it('names an entry point when one object starts the work and is called by none', () => {
    const chain = buildGraph([
      { name: 'ZR_REPORT', objectType: 'PROG/P', packageName: 'ZAPP', calls: [call('ZCL_A', 'method', 3)] },
      { name: 'ZCL_A', objectType: 'CLAS/OC', packageName: 'ZAPP', calls: [] }
    ]);
    expect(chain.entryPoints).toEqual(['ZR_REPORT']);
    expect(chain.cycles).toEqual([]);
  });

  it('quotes the statements behind an edge only when asked', () => {
    expect(graph.edges[0].places).toBeUndefined();
    const withPlaces = buildGraph(PACKAGE, { places: true, maxPlacesPerEdge: 1 });
    const edge = withPlaces.edges.find(e => e.from === 'ZCL_A' && e.to === 'ZCL_B');
    expect(edge?.places).toHaveLength(1);
    expect(edge?.morePlaces).toBe(1);
  });

  it('counts the edges it did not list, and still counts every one of them on the nodes', () => {
    const small = buildGraph(PACKAGE, { maxEdges: 1 });
    expect(small.edges).toHaveLength(1);
    expect(small.edgesHidden).toBe(2);
    // The degree of an object is a fact about the package, not about how much
    // of it fitted in the answer.
    expect(small.nodes.find(node => node.name === 'ZCL_A')?.callsIn).toBe(1);
  });

  it('answers for a package of one object without inventing a graph', () => {
    const alone = buildGraph([{ name: 'ZCL_A', objectType: 'CLAS/OC', packageName: 'ZAPP', calls: [] }]);
    expect(alone).toMatchObject({ edges: [], entryPoints: [], orphans: ['ZCL_A'], cycles: [] });
  });
});

describe('functionModulesOf', () => {
  it('reads the modules a group defines, and not the one named in a comment', () => {
    const include = [
      'FUNCTION z_app_save.',
      '* FUNCTION z_app_ghost.',
      '  WRITE \'x\'.',
      'ENDFUNCTION.'
    ].join('\n');
    expect(functionModulesOf([{ source: include }])).toEqual(['Z_APP_SAVE']);
  });
});

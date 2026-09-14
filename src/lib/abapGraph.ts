/**
 * The call graph of a whole package, assembled from what each object calls.
 *
 * callsFrom answers for one object. Asked for every object of a package, the
 * answers stop being a list and become a shape: which objects nothing inside
 * the package calls (the ways in), which one everything calls (the piece that
 * cannot be changed cheaply), which are connected to nothing, and where the
 * calls run in a circle.
 *
 * The matching is by name, because a name is all a source holds. A function
 * module is the one target whose name is not the name of any object in the
 * package list - it belongs to a group - so a group says which modules it
 * defines and those names are matched to it.
 *
 * Everything here is pure: the objects arrive already read and scanned.
 */

import type { CallKind, CallSite } from './abapCalls';
import { outlineSource } from './sourceScan';

/** One object of the package, with what its source was found to call. */
export interface ScannedObject {
  name: string;
  objectType: string;
  packageName: string;
  /** Other names this object answers to: the function modules a group defines. */
  provides?: string[];
  calls: CallSite[];
  /** Calls in this object that could not be named at all. */
  unresolved?: number;
}

export interface GraphNode {
  name: string;
  objectType: string;
  package: string;
  /** Objects of this package it calls, and objects of this package that call it. */
  callsOut: number;
  callsIn: number;
  /** Call sites that reach the object itself. */
  selfCalls?: number;
}

export interface GraphPlace {
  line: number;
  member?: string;
  statement: string;
  source?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kinds: CallKind[];
  calls: number;
  places?: GraphPlace[];
  morePlaces?: number;
}

/** A target outside the package, which is a dependency of the package as a whole. */
export interface OutsideTarget {
  target: string;
  kinds: CallKind[];
  calls: number;
  from: string[];
  fromHidden?: number;
}

export interface GraphOptions {
  /** Quote the statements behind each edge. Off by default: a package of forty objects is long enough without them. */
  places?: boolean;
  maxPlacesPerEdge?: number;
  maxStatementChars?: number;
  maxEdges?: number;
  maxOutside?: number;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  edgesHidden: number;
  /** Objects nothing inside the package calls: where work enters it. */
  entryPoints: string[];
  /** Most called inside the package, heaviest first. */
  hubs: Array<{ name: string; callsIn: number }>;
  /** Called by nothing and calling nothing, inside the package. */
  orphans: string[];
  /** Call circles inside the package, shortest first. */
  cycles: string[][];
  outside: OutsideTarget[];
  outsideHidden: number;
}

const MAX_CYCLES = 10;
const MAX_HUBS = 5;
const MAX_FROM = 5;

/** The graph of one package, from the objects that were read. */
export function buildGraph(objects: ScannedObject[], options: GraphOptions = {}): GraphResult {
  const maxEdges = Math.max(1, Number(options.maxEdges) || 300);
  const maxOutside = Math.max(1, Number(options.maxOutside) || 50);
  const maxPlaces = Math.max(1, Number(options.maxPlacesPerEdge) || 3);
  const maxChars = Math.max(40, Number(options.maxStatementChars) || 160);
  const shorten = (text: string): string => (text.length > maxChars ? `${text.slice(0, maxChars)}…` : text);

  // Every name that resolves to an object of this package: its own, and the
  // function modules a group defines.
  const owner = new Map<string, string>();
  for (const object of objects) {
    const name = object.name.toUpperCase();
    owner.set(name, name);
    for (const provided of object.provides || []) {
      const alias = provided.toUpperCase();
      if (!owner.has(alias)) owner.set(alias, name);
    }
  }

  const nodes = new Map<string, GraphNode>();
  for (const object of objects) {
    nodes.set(object.name.toUpperCase(), {
      name: object.name.toUpperCase(),
      objectType: object.objectType,
      package: object.packageName,
      callsOut: 0,
      callsIn: 0
    });
  }

  const inside = new Map<string, { edge: GraphEdge; kinds: Set<CallKind>; places: GraphPlace[] }>();
  const outside = new Map<string, { target: string; kinds: Set<CallKind>; calls: number; from: Set<string> }>();

  for (const object of objects) {
    const from = object.name.toUpperCase();
    const node = nodes.get(from)!;
    for (const call of object.calls) {
      const to = owner.get(call.target.toUpperCase());
      if (!to) {
        let entry = outside.get(call.target.toUpperCase());
        if (!entry) {
          entry = { target: call.target.toUpperCase(), kinds: new Set(), calls: 0, from: new Set() };
          outside.set(entry.target, entry);
        }
        entry.kinds.add(call.kind);
        entry.calls += 1;
        entry.from.add(from);
        continue;
      }
      // A call an object makes to itself says nothing about the package: it is
      // counted on the object and left out of the graph.
      if (to === from) {
        node.selfCalls = (node.selfCalls || 0) + 1;
        continue;
      }
      const key = `${from}|${to}`;
      let entry = inside.get(key);
      if (!entry) {
        entry = { edge: { from, to, kinds: [], calls: 0 }, kinds: new Set(), places: [] };
        inside.set(key, entry);
      }
      entry.kinds.add(call.kind);
      entry.edge.calls += 1;
      entry.places.push({
        line: call.line,
        ...(call.member ? { member: call.member } : {}),
        statement: shorten(call.statement),
        ...(call.source ? { source: call.source } : {})
      });
    }
  }

  const allEdges = [...inside.values()].map(entry => {
    const edge = entry.edge;
    edge.kinds = [...entry.kinds].sort();
    if (options.places) {
      edge.places = entry.places.slice(0, maxPlaces);
      if (entry.places.length > maxPlaces) edge.morePlaces = entry.places.length - maxPlaces;
    }
    return edge;
  }).sort((a, b) => b.calls - a.calls || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // Counted over every edge, not only the ones listed: a node's degree is a
  // fact about the package, not about how much of it fitted in the answer.
  const reaches = new Map<string, Set<string>>();
  for (const edge of allEdges) {
    nodes.get(edge.from)!.callsOut += 1;
    nodes.get(edge.to)!.callsIn += 1;
    const targets = reaches.get(edge.from) || new Set<string>();
    targets.add(edge.to);
    reaches.set(edge.from, targets);
  }

  const listed = allEdges.slice(0, maxEdges);
  const nodeList = [...nodes.values()].sort((a, b) =>
    b.callsIn - a.callsIn || b.callsOut - a.callsOut || a.name.localeCompare(b.name));

  const entryPoints = nodeList.filter(node => node.callsIn === 0 && node.callsOut > 0).map(node => node.name).sort();
  const orphans = nodeList.filter(node => node.callsIn === 0 && node.callsOut === 0).map(node => node.name).sort();
  const hubs = nodeList.filter(node => node.callsIn > 0).slice(0, MAX_HUBS)
    .map(node => ({ name: node.name, callsIn: node.callsIn }));

  const outsideList = [...outside.values()]
    .sort((a, b) => b.calls - a.calls || a.target.localeCompare(b.target))
    .map(entry => {
      const from = [...entry.from].sort();
      return {
        target: entry.target,
        kinds: [...entry.kinds].sort(),
        calls: entry.calls,
        from: from.slice(0, MAX_FROM),
        ...(from.length > MAX_FROM ? { fromHidden: from.length - MAX_FROM } : {})
      };
    });

  return {
    nodes: nodeList,
    edges: listed,
    edgesHidden: Math.max(0, allEdges.length - listed.length),
    entryPoints,
    hubs,
    orphans,
    cycles: findCycles(reaches),
    outside: outsideList.slice(0, maxOutside),
    outsideHidden: Math.max(0, outsideList.length - maxOutside)
  };
}

/**
 * Call circles inside the package.
 *
 * Depth-first, keeping the path walked: an edge back into it is a circle, and
 * the path from that point on is the circle itself. Every circle is reported
 * from its smallest name, so the same one found from two starting points is
 * recognised as one rather than listed twice.
 */
function findCycles(reaches: Map<string, Set<string>>): string[][] {
  const found = new Map<string, string[]>();
  const onPath = new Map<string, number>();
  const path: string[] = [];
  const done = new Set<string>();

  const walk = (name: string): void => {
    if (found.size >= MAX_CYCLES) return;
    onPath.set(name, path.length);
    path.push(name);
    for (const next of reaches.get(name) || []) {
      const at = onPath.get(next);
      if (at !== undefined) {
        const cycle = path.slice(at);
        const start = cycle.indexOf([...cycle].sort()[0]);
        const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
        const key = rotated.join('>');
        if (!found.has(key)) found.set(key, rotated);
        continue;
      }
      if (!done.has(next)) walk(next);
    }
    path.pop();
    onPath.delete(name);
    done.add(name);
  };

  for (const name of reaches.keys()) if (!done.has(name)) walk(name);
  return [...found.values()].sort((a, b) => a.length - b.length || a[0].localeCompare(b[0])).slice(0, MAX_CYCLES);
}

/**
 * The function modules a function group defines, which is how a call reaches
 * it: CALL FUNCTION names the module, and the package list names the group.
 * Read through the outline, so a module named in a comment is not one.
 */
export function functionModulesOf(sources: Array<{ source: string }>): string[] {
  const names = new Set<string>();
  for (const { source } of sources) {
    for (const entry of outlineSource(source)) {
      if (entry.kind === 'FUNCTION') names.add(entry.name.toUpperCase());
    }
  }
  return [...names];
}

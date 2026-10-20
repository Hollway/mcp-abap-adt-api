/**
 * Questions to the graph: what a name is, who reaches it, what it reaches,
 * what is described in given words, and which code uses several things at
 * once - the last two being how existing logic is found before it is written
 * again.
 *
 * Everything here reads the local file only. Code is fetched by the handler,
 * for the few places an answer points at.
 */
import { ftsQuery, isCustomerName, searchTerms } from './names';
import type { GraphStore, EdgeRow } from './store';

export type NodeKind =
  | 'class' | 'interface' | 'method' | 'component' | 'function' | 'functionGroup' | 'program' | 'include'
  | 'table' | 'type' | 'other' | 'external';

/** One thing the graph can be asked about. */
export interface GraphNode {
  /** How it is written in an answer: ZCL_X=>METH, Z_FM, ZR_REPORT. */
  label: string;
  kind: NodeKind;
  /** The owner as the index records it: class, interface, function group, program or include. */
  object: string;
  objectType: string;
  member?: string;
  /** For a function module: its own name, which is what calls to it are recorded under. */
  functionName?: string;
  package?: string;
  text?: string;
}

export interface ResolvedNames {
  matched: GraphNode[];
  ambiguous: { name: string; candidates: GraphNode[] }[];
  unknown: string[];
}

const OBJECT_KINDS: Record<string, NodeKind> = {
  CLAS: 'class', INTF: 'interface', FUGR: 'functionGroup', PROG: 'program',
  TABL: 'table', VIEW: 'table', DDLS: 'table', TTYP: 'type', DTEL: 'type'
};
/** How much a search hit of each kind is worth when the words match equally: code before data. */
const KIND_WEIGHT: Partial<Record<NodeKind, number>> = {
  class: 3, interface: 3, method: 3, function: 3, program: 2, include: 2, functionGroup: 2, table: 1, type: 1, component: 0, other: 0
};
const OBJECT_PREFERENCE = ['CLAS', 'INTF', 'PROG', 'FUGR', 'TABL', 'DDLS', 'VIEW', 'TTYP', 'DTEL', 'TRAN', 'MSAG'];

export class GraphExplorer {
  constructor(private readonly store: GraphStore, private readonly languages: string[]) {}

  private text(object: string, member?: string | null): string | undefined {
    return this.store.textOf(object, member, this.languages);
  }

  /** A node for an owner and member as the edges name them. */
  nodeOf(objectType: string, object: string, member?: string | null): GraphNode {
    if (objectType === 'FUGR' && member) {
      return {
        label: member, kind: 'function', object, objectType, member, functionName: member,
        package: this.store.packageOf(object), text: this.text(object, member)
      };
    }
    if (member) {
      // An attribute, a constant or an interface method nobody implements here:
      // known from its text only, so it is a component, not a method.
      const component = this.store.membersNamed(member, object).some(row => row.kind === 'component')
        && !this.store.edgesTo(object, member).some(edge => edge.kind === 'method');
      return {
        label: `${object}=>${member}`, kind: component ? 'component' : 'method', object, objectType, member,
        package: this.store.packageOf(object), text: this.text(object, member)
      };
    }
    const kind: NodeKind = objectType === 'PROG' && this.store.mastersOf(object).length > 0
      ? 'include'
      : OBJECT_KINDS[objectType] || 'other';
    return { label: object, kind, object, objectType, package: this.store.packageOf(object), text: this.text(object) };
  }

  /**
   * Names as the caller wrote them: ZCL_X=>METH or ZCL_X->METH, ZIF_X~METH,
   * a class, program, table or function module, or a bare method name when
   * it is unique. A name the graph has no definition for but that is
   * referenced - a standard class, BAPI_PO_CREATE1 - is still answerable for
   * who uses it.
   */
  resolve(names: string[]): ResolvedNames {
    const result: ResolvedNames = { matched: [], ambiguous: [], unknown: [] };
    for (const raw of names) {
      const name = raw.trim().toUpperCase().replace(/\s+/g, '');
      if (!name) continue;

      const arrow = /^(.+?)(=>|->)(.+)$/.exec(name);
      const tilde = name.indexOf('~');
      const split = arrow
        ? { object: arrow[1], member: arrow[3] }
        : tilde > 0 ? { object: name.slice(0, tilde), member: name.slice(tilde + 1) } : undefined;
      if (split) {
        const { object, member } = split;
        const known = this.store.objectsNamed([object]);
        const objectType = known.find(row => row.type === 'CLAS' || row.type === 'INTF')?.type || 'CLAS';
        const node = this.nodeOf(objectType, object, member);
        if (known.length > 0 || this.store.usageCount(object, member) > 0 || this.store.membersNamed(member, object).length > 0) {
          result.matched.push(node);
        } else {
          result.unknown.push(raw);
        }
        continue;
      }

      const objects = this.store.objectsNamed([name])
        .sort((a, b) => OBJECT_PREFERENCE.indexOf(a.type) - OBJECT_PREFERENCE.indexOf(b.type));
      if (objects.length > 0) {
        result.matched.push(this.nodeOf(objects[0].type, objects[0].name));
        continue;
      }
      const members = this.store.membersNamed(name);
      const functions = members.filter(member => member.kind === 'function');
      if (functions.length === 1) {
        result.matched.push(this.nodeOf('FUGR', functions[0].object, functions[0].member));
        continue;
      }
      if (members.length === 1) {
        result.matched.push(this.nodeOf(members[0].objectType, members[0].object, members[0].member));
        continue;
      }
      if (members.length > 1) {
        result.ambiguous.push({ name: raw, candidates: members.slice(0, 15).map(member => this.nodeOf(member.objectType, member.object, member.member)) });
        continue;
      }
      if (this.store.usageCount(name) > 0) {
        result.matched.push({ label: name, kind: 'external', object: name, objectType: '' });
        continue;
      }
      result.unknown.push(raw);
    }
    return result;
  }

  /** The edges that point at a node. A function module is recorded under its own name. */
  private edgesInto(node: GraphNode): EdgeRow[] {
    if (node.kind === 'function') return this.store.edgesTo(node.functionName!);
    if (node.member) return this.store.edgesTo(node.object, node.member);
    return this.store.edgesTo(node.object);
  }

  /** The edges a node makes. A program speaks through its includes too. */
  private edgesOutOf(node: GraphNode): EdgeRow[] {
    if (node.member) return this.store.edgesFrom(node.object, node.member);
    const edges = this.store.edgesFrom(node.object);
    if (node.objectType === 'PROG') {
      for (const include of this.store.includesOf(node.object)) edges.push(...this.store.edgesFrom(include));
    }
    return edges;
  }

  /**
   * Who reaches a node, one entry per calling method, function module or
   * program include, with the kinds of reference and the members used.
   */
  callers(node: GraphNode, options: CallerOptions = {}): CallerEntry[] {
    const kinds = options.kinds;
    const byCaller = new Map<string, CallerEntry>();
    for (const edge of this.edgesInto(node)) {
      if (kinds && !kinds.includes(edge.kind)) continue;
      if (!options.includeDeclarations && edge.srcPart === 'definition') continue;
      // For a whole object, its own code calling itself is not who uses it.
      if (!node.member && edge.srcObj === node.object) continue;
      const key = `${edge.srcType}:${edge.srcObj}:${edge.srcMember || ''}`;
      let entry = byCaller.get(key);
      if (!entry) {
        const caller = this.nodeOf(edge.srcType, edge.srcObj, edge.srcMember);
        entry = {
          ...caller,
          part: edge.srcPart,
          include: edge.include,
          kinds: [],
          uses: [],
          references: 0
        };
        if (caller.kind === 'include') entry.programs = this.store.mastersOf(edge.srcObj).slice(0, 5);
        byCaller.set(key, entry);
      }
      entry.references += 1;
      if (!entry.kinds.includes(edge.kind)) entry.kinds.push(edge.kind);
      if (!node.member && edge.dstMember && !entry.uses.includes(edge.dstMember)) entry.uses.push(edge.dstMember);
    }
    return [...byCaller.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  /** What a node reaches, one entry per target. */
  callees(node: GraphNode, options: CalleeOptions = {}): { entries: CalleeEntry[]; standardHidden: number } {
    const kinds = options.kinds;
    const byTarget = new Map<string, CalleeEntry>();
    let standardHidden = 0;
    const standardSeen = new Set<string>();
    for (const edge of this.edgesOutOf(node)) {
      if (kinds && !kinds.includes(edge.kind)) continue;
      if (!options.includeDeclarations && edge.srcPart === 'definition') continue;
      // A method calling a sibling is worth showing; the object pointing at itself as a whole is not.
      if (!edge.dstMember && edge.dstObj === node.object) continue;
      const key = `${edge.kind}:${edge.dstObj}:${edge.dstMember || ''}`;
      if (options.onlyCustom !== false && !isCustomerName(edge.dstObj)) {
        if (!standardSeen.has(key)) {
          standardSeen.add(key);
          standardHidden += 1;
        }
        continue;
      }
      let entry = byTarget.get(key);
      if (!entry) {
        const label = edge.kind === 'perform' ? `FORM ${edge.dstMember}${edge.dstObj ? ` IN ${edge.dstObj}` : ''}`
          : edge.kind === 'message' ? (edge.dstMember ? `${edge.dstObj}/${edge.dstMember}` : edge.dstObj)
            : edge.dstMember ? `${edge.dstObj}=>${edge.dstMember}` : edge.dstObj;
        entry = {
          label,
          kind: edge.kind,
          object: edge.dstObj,
          member: edge.dstMember || undefined,
          text: this.targetText(edge),
          package: this.store.packageOf(edge.dstObj),
          from: [],
          references: 0
        };
        byTarget.set(key, entry);
      }
      entry.references += 1;
      const from = edge.srcMember || edge.include;
      if (!node.member && !entry.from.includes(from)) entry.from.push(from);
    }
    // DATA lo TYPE REF TO zcl_x says nothing a call of zcl_x=>m does not.
    const called = new Set([...byTarget.values()].filter(entry => entry.kind === 'method').map(entry => entry.object));
    for (const [key, entry] of byTarget) {
      if (entry.kind === 'type' && !entry.member && called.has(entry.object)) byTarget.delete(key);
    }
    const entries = [...byTarget.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
    return { entries, standardHidden };
  }

  private targetText(edge: EdgeRow): string | undefined {
    if (edge.kind === 'function') {
      const owner = this.store.membersNamed(edge.dstObj).find(member => member.kind === 'function');
      return owner ? this.text(owner.object, owner.member) : undefined;
    }
    return this.text(edge.dstObj, edge.kind === 'perform' || edge.kind === 'message' ? null : edge.dstMember);
  }

  /**
   * Breadth-first over callers or callees, up to a depth and a node budget.
   * Each entry beyond the first level says which node it was reached through.
   */
  walk(start: GraphNode, direction: 'callers' | 'callees', depth: number, maxNodes: number, options: CallerOptions & CalleeOptions = {}): WalkEntry[] {
    const seen = new Set<string>([nodeKey(start)]);
    const out: WalkEntry[] = [];
    let level: GraphNode[] = [start];
    for (let d = 1; d <= depth && level.length > 0 && out.length < maxNodes; d++) {
      const next: GraphNode[] = [];
      for (const node of level) {
        const found: GraphNode[] = direction === 'callers'
          ? this.callers(node, options)
          : this.callees(node, options).entries.map(entry => this.calleeNode(entry)).filter((n): n is GraphNode => !!n);
        for (const reached of found) {
          const key = nodeKey(reached);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ depth: d, via: node.label, node: reached });
          next.push(reached);
          if (out.length >= maxNodes) break;
        }
        if (out.length >= maxNodes) break;
      }
      level = next;
    }
    return out;
  }

  /** A callee as a node to walk on from - only what the graph has the code of. */
  private calleeNode(entry: CalleeEntry): GraphNode | undefined {
    if (entry.kind === 'function') {
      const owner = this.store.membersNamed(entry.object).find(member => member.kind === 'function');
      return owner ? this.nodeOf('FUGR', owner.object, owner.member) : undefined;
    }
    if (entry.kind === 'submit') return this.nodeOf('PROG', entry.object);
    if (entry.kind === 'method' && entry.member) {
      const type = this.store.objectsNamed([entry.object]).find(row => row.type === 'CLAS' || row.type === 'INTF')?.type;
      return type ? this.nodeOf(type, entry.object, entry.member) : undefined;
    }
    return undefined;
  }

  /**
   * Objects and members named or described in the given words, best first.
   *
   * Every word must match the start of a word in the name or the text; when
   * nothing matches all of them, any will do, and the answer says so. Then the
   * order is what a person looking for existing logic wants rather than what
   * bm25 prefers - it favours short documents, which put a dozen attributes
   * called "Company code" over the class that computes one: more of the words
   * matched first, then code (classes, methods, function modules, programs)
   * before data (tables, attributes), then what the code base uses most.
   */
  search(text: string, limit: number): { mode: 'all' | 'any'; hits: SearchEntry[] } {
    const stems = searchTerms(text);
    for (const mode of ['all', 'any'] as const) {
      const query = ftsQuery(text, mode);
      if (!query) return { mode, hits: [] };
      const raw = this.store.search(query, Math.max(limit * 8, 100));
      if (raw.length === 0) continue;
      const seen = new Set<string>();
      const scored: { entry: SearchEntry; matched: number; weight: number; rank: number }[] = [];
      for (const hit of raw) {
        const key = `${hit.object}:${hit.member || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const node = this.nodeOf(hit.objectType, hit.object, hit.member);
        const usedBy = node.kind === 'function'
          ? this.store.usageCount(node.functionName!)
          : this.store.usageCount(hit.object, hit.member);
        const words = hit.words.split(' ');
        const matched = stems.filter(stem => words.some(word => word.startsWith(stem))).length;
        scored.push({ entry: { ...node, usedBy }, matched, weight: KIND_WEIGHT[node.kind] ?? 1, rank: hit.rank });
      }
      scored.sort((a, b) =>
        b.matched - a.matched || b.weight - a.weight || b.entry.usedBy - a.entry.usedBy || a.rank - b.rank);
      return { mode, hits: scored.slice(0, limit).map(item => item.entry) };
    }
    return { mode: 'any', hits: [] };
  }

  /**
   * Callers that reach every one of the nodes - code that already does
   * something with all of them, which is where a piece of logic built on
   * them is most likely to exist already.
   */
  sharedCallers(nodes: GraphNode[], options: CallerOptions = {}): CallerEntry[] {
    if (nodes.length < 2) return [];
    let shared: Map<string, CallerEntry> | undefined;
    for (const node of nodes) {
      const entries = new Map(this.callers(node, options).map(entry => [nodeKey(entry), entry]));
      if (!shared) {
        shared = entries;
        continue;
      }
      for (const key of [...shared.keys()]) if (!entries.has(key)) shared.delete(key);
    }
    return [...(shared?.values() || [])];
  }
}

export interface CallerOptions {
  kinds?: string[];
  /** References from class definition sections (CU/CO/CI): ALIASES, INTERFACES, REDEFINITION. Off by default. */
  includeDeclarations?: boolean;
}

export interface CalleeOptions {
  kinds?: string[];
  includeDeclarations?: boolean;
  /** Leave standard targets out, counting them. Default true. */
  onlyCustom?: boolean;
}

export interface CallerEntry extends GraphNode {
  part: string;
  include: string;
  kinds: string[];
  /** Members of the target object used, when the question was about the whole object. */
  uses: string[];
  references: number;
  /** For a program include: the programs it is part of. */
  programs?: string[];
}

export interface CalleeEntry {
  label: string;
  kind: string;
  object: string;
  member?: string;
  text?: string;
  package?: string;
  /** Members of the asking object that make the reference, for a whole-object question. */
  from: string[];
  references: number;
}

export interface WalkEntry {
  depth: number;
  via: string;
  node: GraphNode;
}

export interface SearchEntry extends GraphNode {
  usedBy: number;
}

export const nodeKey = (node: { objectType: string; object: string; member?: string | null }): string =>
  `${node.objectType}:${node.object}:${node.member || ''}`;



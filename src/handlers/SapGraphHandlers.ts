import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ADTClient } from 'abap-adt-api';
import { BaseHandler } from './BaseHandler';
import { QueryHandlers } from './QueryHandlers';
import type { ToolDefinition } from '../types/tools';
import { sourceCache } from '../lib/sourceCache';
import { languageKey } from '../lib/sapGraph/names';
import type { RowSource, SyncResult } from '../lib/sapGraph/sync';
import {
  graphFileFor, graphStore, graphPrefixes, graphMaxAgeMinutes, startLoad, loadJob, foreignLoad, waitFor, LoadJob, LoadInfo
} from '../lib/sapGraph';
import { GraphExplorer, GraphNode, CallerEntry, WalkEntry } from '../lib/sapGraph/explore';
import { sourceUrlOf, methodBlock, blocksNaming, CodeBlock } from '../lib/sapGraph/source';
import { tableAccess } from '../lib/sapGraph/tableAccess';

const DEFAULT_MAX_RESULTS = 40;
const DEFAULT_MAX_SOURCES = 5;
const DEFAULT_MAX_SCAN = 80;
const MAX_DEPTH = 4;
const AUTO_REFRESH_WAIT_SECONDS = 20;
/** Nodes a walk of several levels may visit before it stops. */
const WALK_BUDGET = 300;

/**
 * A graph of the customer code of one system, kept on disk between calls.
 *
 * impactOf, abapPath and abapGraph work the graph out again on every call,
 * by reading sources; this one is loaded once from the where-used index SAP
 * maintains anyway (WBCROSSGT, CROSS) and kept current by reloading what
 * changed. A question then costs a lookup in a local file plus the code of
 * the few places the answer points at - not every source on the way.
 */
export class SapGraphHandlers extends BaseHandler {
  private readonly queries: QueryHandlers;

  constructor(client: ADTClient) {
    super(client);
    this.queries = new QueryHandlers(client);
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'sapGraphSync',
        description: 'Load or refresh the local graph of the customer code (Z*/Y*) of this system, built from the where-used index SAP keeps itself (WBCROSSGT, CROSS) plus TADIR, TMDIR, TFDIR, D010INC and the short texts - the graph sapGraphExplore answers from. mode full reads everything (some 0.9 million references on a large ERP system, a few minutes); delta reloads only the objects with an include changed since the last load (REPOSRC), whole; status only reports. The load runs in the background and the answer comes back after wait seconds with its progress - call again with mode status to see it finish. One load at a time per system, across every chat: a second one is told who is loading. Reads SAP only; writes a file under SAP_GRAPH_DIR (default ~/.abap-graph). Objects deleted in SAP leave the graph only with the next full load.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['delta', 'full', 'status'],
              description: 'delta (default; a full load when there is no graph yet), full, or status.'
            },
            wait: {
              type: 'number',
              description: 'Seconds to wait for the load before answering with its progress. Default 25; 0 answers at once.'
            }
          }
        }
      },
      {
        name: 'sapGraphExplore',
        description: 'Ask the local SAP code graph (load it with sapGraphSync first) - the cheap first step of understanding code: who calls a method, function module, class, report or uses a table type; what it calls in turn, several levels deep; which objects and methods are described in given words (searching names and short texts, Russian or English - how to find logic that already exists before writing it again); and which code uses several things at once (usesAll - existing code built on the same pieces). Answers with the graph and the code of only the places it points at: the asked method or function module itself and the blocks of the first callers that make the reference, not whole sources. Grouped per calling method / function module / program include. Built from the where-used index of SAP, so it sees active code only, not dynamic calls (CALL METHOD (name), CALL FUNCTION lv_fm), and tells what a place does with a database table only when asked with tableAccess (who writes, who reads it). A graph older than SAP_GRAPH_MAX_AGE_MIN minutes (default 60) is brought up to date first.',
        inputSchema: {
          type: 'object',
          properties: {
            names: {
              type: 'array',
              items: { type: 'string' },
              description: 'What to ask about: ZCL_X=>METHOD (or ->), ZIF_X~METHOD, ZCL_X, Z_FUNCTION_MODULE, ZR_REPORT, ZTABLE, a unique bare method name, or a standard name the code calls (BAPI_PO_CREATE1, CL_GUI_ALV_GRID) to find who uses it.'
            },
            search: {
              type: 'string',
              description: 'Words to find in names and short texts, e.g. "балансовая единица завод" or "price list". Every word matches as the start of a word; ё and е are the same.'
            },
            usesAll: {
              type: 'array',
              items: { type: 'string' },
              description: 'Names (as in names) the code must use all of: answers the methods, function modules and includes that reach every one of them.'
            },
            direction: {
              type: 'string',
              enum: ['callers', 'callees', 'both'],
              description: 'callers (who reaches it, default), callees (what it reaches) or both.'
            },
            depth: {
              type: 'number',
              description: `Levels to follow, 1 to ${MAX_DEPTH}. Default 1. Beyond the first level each entry names the node it was reached through.`
            },
            kinds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Reference kinds to keep: method, function, perform, submit, transaction, event, type, data, message, typeKey. Default: all.'
            },
            includeDeclarations: {
              type: 'boolean',
              description: 'Also count references from class definition sections (ALIASES, INTERFACES, REDEFINITION). Default false.'
            },
            onlyCustom: {
              type: 'boolean',
              description: 'Callees: leave standard targets out and count them. Default true.'
            },
            withSource: {
              type: 'boolean',
              description: 'Attach the code of the asked method/function module and of the first callers. Default true.'
            },
            maxSources: {
              type: 'number',
              description: `Callers whose code is attached. Default ${DEFAULT_MAX_SOURCES}.`
            },
            maxResults: {
              type: 'number',
              description: `Entries per list. Default ${DEFAULT_MAX_RESULTS}.`
            },
            refresh: {
              type: 'boolean',
              description: 'Bring an old graph up to date before answering. Default true.'
            },
            tableAccess: {
              type: 'array',
              items: { type: 'string' },
              description: 'Database tables (customer or standard, e.g. ZPRICES, EKKO) to answer who writes them (INSERT, UPDATE, MODIFY, DELETE - with the statement and line), who reads them (SELECT, JOIN) and who only uses them as a type. The places come from the where-used index, then only those places are read and scanned; what was scanned is kept until the include changes, so asking again is free and goes on where the last call stopped.'
            },
            maxScan: {
              type: 'number',
              description: `tableAccess: places to read and scan in this call, per table. Default ${DEFAULT_MAX_SCAN}; the answer says how many are left.`
            }
          }
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'sapGraphSync':
        return this.answer(await this.syncCore(args));
      case 'sapGraphExplore':
        return this.answer(await this.exploreCore(args));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown graph tool: ${toolName}`);
    }
  }

  private get file(): string {
    return graphFileFor(this.adtclient.baseUrl, this.adtclient.client);
  }

  private languages(): string[] {
    return [...new Set([languageKey(this.adtclient.language), 'E'])];
  }

  /** Rows of a SELECT through the bridge's own query path, without a JSON round trip. */
  private rowSource(): RowSource {
    return {
      rows: async (sqlQuery: string, rowNumber: number) => {
        const payload: any = await this.queries.runQueryCore({ sqlQuery, rowNumber });
        const values = payload?.result?.values;
        return Array.isArray(values) ? values : [];
      }
    };
  }

  private graphState(): Record<string, unknown> {
    const store = graphStore(this.file);
    const lastSyncAt = store.meta('lastSyncAt');
    return {
      file: this.file,
      fullSyncAt: store.meta('fullSyncAt'),
      lastSyncAt,
      ageMinutes: lastSyncAt ? Math.round((Date.now() - Date.parse(lastSyncAt)) / 60000) : undefined,
      newestChange: store.meta('newestChange'),
      counts: store.counts()
    };
  }

  private describeLoad(info: LoadInfo, job?: LoadJob): Record<string, unknown> {
    return {
      mode: info.mode,
      pid: info.pid,
      phase: info.phase,
      rowsRead: info.rows,
      queries: info.queries,
      startedAt: info.startedAt,
      runningSeconds: Math.round((Date.now() - Date.parse(info.startedAt)) / 1000),
      ...(job?.finishedAt ? { finishedAt: job.finishedAt } : {}),
      ...(job?.error ? { error: job.error } : {}),
      ...(job?.result ? { result: summarized(job.result) } : {})
    };
  }

  async syncCore(args: any): Promise<Record<string, unknown>> {
    const mode = String(args?.mode || 'delta').toLowerCase();
    if (!['delta', 'full', 'status'].includes(mode)) {
      throw new McpError(ErrorCode.InvalidParams, `mode must be delta, full or status, not '${args?.mode}'.`);
    }
    const file = this.file;
    const store = graphStore(file);

    if (mode === 'status') {
      const job = loadJob(file);
      const foreign = foreignLoad(file);
      return {
        status: 'success',
        graph: this.graphState(),
        ...(job ? { load: this.describeLoad(job.info, job) } : {}),
        ...(foreign ? { loadElsewhere: this.describeLoad(foreign) } : {}),
        ...(store.isEmpty() && !job && !foreign ? { hint: 'There is no graph yet - call sapGraphSync with mode full.' } : {})
      };
    }

    const effective = mode === 'delta' && store.isEmpty() ? 'full' : mode as 'full' | 'delta';
    const outcome = startLoad(file, this.rowSource(), effective, { prefixes: graphPrefixes(), languages: this.languages() });
    if (!outcome.started) {
      if ('foreign' in outcome) {
        return {
          status: 'busy',
          note: 'Another process (another chat) is loading this graph; asking it again changes nothing. Call with mode status to follow it.',
          loadElsewhere: this.describeLoad(outcome.foreign),
          graph: this.graphState()
        };
      }
      const finished = await waitFor(outcome.running, this.waitSeconds(args));
      return {
        status: finished ? 'success' : 'running',
        note: 'A load was already running in this process; this call waited for it instead of starting another.',
        load: this.describeLoad(outcome.running.info, outcome.running),
        graph: this.graphState()
      };
    }

    const finished = await waitFor(outcome.job, this.waitSeconds(args));
    if (finished && outcome.job.error) {
      return { status: 'error', error: `The load failed and was rolled back: ${outcome.job.error}`, graph: this.graphState() };
    }
    return {
      status: finished ? 'success' : 'running',
      ...(effective !== mode ? { note: 'There was no graph yet, so this is a full load.' } : {}),
      ...(finished ? {} : { hint: 'Still loading in the background. Call sapGraphSync with mode status to see it finish; questions keep getting the previous graph until it commits.' }),
      load: this.describeLoad(outcome.job.info, outcome.job),
      graph: this.graphState()
    };
  }

  private waitSeconds(args: any): number {
    const value = Number(args?.wait);
    return Number.isFinite(value) && value >= 0 ? Math.min(value, 300) : 25;
  }

  /** An old graph brought up to date before the question, within a short wait. */
  private async refreshIfOld(args: any): Promise<string | undefined> {
    if (args?.refresh === false) return undefined;
    const maxAge = graphMaxAgeMinutes();
    if (maxAge <= 0) return undefined;
    const store = graphStore(this.file);
    const last = store.meta('lastSyncAt');
    if (!last || Date.now() - Date.parse(last) < maxAge * 60000) return undefined;
    const outcome = startLoad(this.file, this.rowSource(), 'delta', { prefixes: graphPrefixes(), languages: this.languages() });
    const job = outcome.started ? outcome.job : 'running' in outcome ? outcome.running : undefined;
    if (!job) return 'The graph is being refreshed by another process; this answer is from the graph as it was.';
    const finished = await waitFor(job, AUTO_REFRESH_WAIT_SECONDS);
    if (!finished) return 'The graph is older than the refresh limit and is being brought up to date in the background; this answer is from the graph as it was.';
    if (job.error) return `Refreshing the graph failed (${job.error}); this answer is from the graph as it was.`;
    const reloaded = job.result?.objectsReloaded?.length;
    return reloaded ? `Refreshed first: ${reloaded} changed object(s) reloaded.` : undefined;
  }

  private names(value: unknown, what: string): string[] {
    if (value === undefined || value === null || value === '') return [];
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\s]+/) : undefined;
    if (!list) throw new McpError(ErrorCode.InvalidParams, `${what} is a list of names.`);
    return list.map(item => String(item).trim()).filter(Boolean);
  }

  async exploreCore(args: any): Promise<Record<string, unknown>> {
    const names = this.names(args?.names, 'names');
    const usesAll = this.names(args?.usesAll, 'usesAll');
    const search = typeof args?.search === 'string' ? args.search.trim() : '';
    const tables = this.names(args?.tableAccess, 'tableAccess').map(table => table.toUpperCase());
    if (names.length === 0 && usesAll.length === 0 && !search && tables.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Ask about something: names, search, usesAll or tableAccess.');
    }
    const badTable = tables.find(table => !/^[A-Z0-9_/]{1,30}$/.test(table));
    if (badTable) throw new McpError(ErrorCode.InvalidParams, `'${badTable}' is not a table name.`);
    const maxScan = Math.max(0, Math.floor(Number(args?.maxScan ?? DEFAULT_MAX_SCAN)));
    const direction = String(args?.direction || 'callers').toLowerCase();
    if (!['callers', 'callees', 'both'].includes(direction)) {
      throw new McpError(ErrorCode.InvalidParams, `direction must be callers, callees or both, not '${args?.direction}'.`);
    }
    const depth = Math.min(MAX_DEPTH, Math.max(1, Math.floor(Number(args?.depth) || 1)));
    const maxResults = Math.max(1, Math.floor(Number(args?.maxResults) || DEFAULT_MAX_RESULTS));
    const maxSources = Math.max(0, Math.floor(Number(args?.maxSources ?? DEFAULT_MAX_SOURCES)));
    const withSource = args?.withSource !== false;
    const kinds = this.names(args?.kinds, 'kinds').map(kind => kind.trim());
    const options = {
      kinds: kinds.length > 0 ? kinds : undefined,
      includeDeclarations: args?.includeDeclarations === true,
      onlyCustom: args?.onlyCustom !== false
    };

    const store = graphStore(this.file);
    if (store.isEmpty()) {
      const job = loadJob(this.file);
      const foreign = foreignLoad(this.file);
      return {
        status: 'empty',
        error: 'There is no graph of this system yet.',
        hint: job || foreign ? 'A load is running - wait for it with sapGraphSync mode status.' : 'Load it once with sapGraphSync mode full (a few minutes).',
        ...(job ? { load: this.describeLoad(job.info, job) } : foreign ? { loadElsewhere: this.describeLoad(foreign) } : {})
      };
    }

    const refreshed = await this.refreshIfOld(args);
    const explorer = new GraphExplorer(store, this.languages());
    const answer: Record<string, unknown> = { status: 'success' };
    const truncated: Record<string, number> = {};
    const cut = <T>(list: T[], key: string): T[] => {
      if (list.length > maxResults) truncated[key] = list.length;
      return list.slice(0, maxResults);
    };

    const resolved = explorer.resolve(names);
    if (names.length > 0) {
      answer.matched = resolved.matched.map(compactNode);
      if (resolved.ambiguous.length > 0) {
        answer.ambiguous = resolved.ambiguous.map(entry => ({ name: entry.name, candidates: entry.candidates.map(node => node.label) }));
      }
      if (resolved.unknown.length > 0) {
        answer.unknown = resolved.unknown;
        answer.unknownNote = 'Not in the graph and not referenced by any customer code: a typo, an object outside Z*/Y*, or code the last load has not seen yet.';
      }
    }

    const results: Record<string, unknown>[] = [];
    const sourceJobs: { node: GraphNode | CallerEntry; target?: string; role: string }[] = [];
    for (const node of resolved.matched.slice(0, 5)) {
      const result: Record<string, unknown> = { of: node.label };
      if (direction !== 'callees') {
        if (depth === 1) {
          const callers = explorer.callers(node, options);
          result.callerCount = callers.length;
          result.callers = cut(callers, `callers of ${node.label}`).map(compactCaller);
          for (const caller of callers.slice(0, maxSources)) sourceJobs.push({ node: caller, target: targetName(node), role: `caller of ${node.label}` });
        } else {
          const walked = levels(explorer.walk(node, 'callers', depth, WALK_BUDGET, options), maxResults);
          result.callersByDepth = walked.byDepth;
          if (walked.budgetReached) result.callersBudgetReached = WALK_BUDGET;
          result.callers = walked.shown;
        }
      }
      if (direction !== 'callers') {
        if (depth === 1) {
          const { entries, standardHidden } = explorer.callees(node, options);
          result.calleeCount = entries.length;
          result.callees = cut(entries, `callees of ${node.label}`).map(entry => dropEmpty({ ...entry, from: entry.from.length ? entry.from : undefined }));
          if (standardHidden > 0) result.standardCalleesHidden = standardHidden;
        } else {
          const walked = levels(explorer.walk(node, 'callees', depth, WALK_BUDGET, options), maxResults);
          result.calleesByDepth = walked.byDepth;
          if (walked.budgetReached) result.calleesBudgetReached = WALK_BUDGET;
          result.callees = walked.shown;
        }
      }
      if (node.kind === 'method' || node.kind === 'function') sourceJobs.unshift({ node, role: 'asked' });
      results.push(result);
    }
    if (results.length > 0) answer.results = results;

    if (usesAll.length > 0) {
      const footprint = explorer.resolve(usesAll);
      const shared = explorer.sharedCallers(footprint.matched, options);
      answer.usesAll = {
        of: footprint.matched.map(node => node.label),
        ...(footprint.unknown.length ? { unknown: footprint.unknown } : {}),
        count: shared.length,
        callers: cut(shared, 'usesAll').map(compactCaller),
        ...(footprint.matched.length < 2 ? { note: 'usesAll needs at least two names the graph knows.' } : {})
      };
    }

    if (tables.length > 0) {
      const accessResults: Record<string, unknown>[] = [];
      for (const table of tables.slice(0, 5)) {
        const candidates = await this.tableCandidates(table);
        const result = await tableAccess(table, candidates, {
          store, explorer, read: url => this.read(url), prefixes: graphPrefixes()
        }, maxScan);
        accessResults.push(dropEmpty({
          table: result.table,
          candidates: result.candidates,
          scannedNow: result.scannedNow,
          fromCache: result.fromCache,
          notScanned: result.notScanned,
          ...(result.notScanned > 0 ? { hint: `${result.notScanned} place(s) not read yet - ask again to go on; what was read is kept.` } : {}),
          writers: result.writers,
          readerCount: result.readers.length,
          readers: cut(result.readers, `readers of ${table}`),
          typeOnlyCount: result.typeOnly.length,
          typeOnly: cut(result.typeOnly, `type users of ${table}`).map(user => user.name),
          failed: result.failed,
          notCached: result.notCached
        }));
      }
      answer.tableAccess = accessResults;
    }

    if (search) {
      const found = explorer.search(search, Math.min(maxResults, 25));
      answer.search = {
        words: search,
        ...(found.mode === 'any' && found.hits.length ? { note: 'Nothing matched every word; these match some of them.' } : {}),
        hits: found.hits.map(hit => dropEmpty({ ...compactNode(hit), usedBy: hit.usedBy }))
      };
    }

    if (withSource && sourceJobs.length > 0) {
      answer.sources = await this.sources(sourceJobs, maxSources + 2);
    }

    if (Object.keys(truncated).length > 0) {
      answer.truncated = truncated;
      answer.truncatedNote = `Lists were cut at maxResults (${maxResults}); the numbers are the full counts.`;
    }
    answer.graph = { lastSyncAt: store.meta('lastSyncAt'), ...(refreshed ? { refreshed } : {}) };
    return answer;
  }

  /** The code each source job points at, read once per address. */
  private async sources(jobs: { node: GraphNode | CallerEntry; target?: string; role: string }[], limit: number): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (const job of jobs.slice(0, limit)) {
      const { node } = job;
      const part = 'part' in node ? (node as CallerEntry).part : undefined;
      if (part === 'definition') continue;
      const include = 'include' in node ? (node as CallerEntry).include : undefined;
      const store = graphStore(this.file);
      const classPart = include ? store.includeRow(include)?.part : undefined;
      const subc = node.objectType === 'PROG' ? store.includeRow(node.object)?.subc : undefined;
      const url = sourceUrlOf({ objectType: node.objectType, object: node.object, member: node.member, part: classPart, include, subc });
      if (!url) continue;
      let source: string;
      try {
        source = await this.read(url);
      } catch (error: any) {
        out.push({ of: node.label, role: job.role, url, error: `Could not read the source: ${error?.message || error}` });
        continue;
      }
      let blocks: CodeBlock[] = [];
      if (node.kind === 'method' && node.objectType === 'CLAS' && (!classPart || classPart.startsWith('CM'))) {
        const block = methodBlock(source, node.member!, job.target ? 60 : 150, job.target);
        if (block) blocks = [block];
      } else if (job.target) {
        blocks = blocksNaming(source, job.target, 2, 60);
      } else {
        blocks = blocksNaming(source, node.member || node.object, 1, 150);
      }
      if (blocks.length === 0) continue;
      out.push({ of: node.label, role: job.role, url, blocks });
    }
    return out;
  }

  /**
   * The customer includes the where-used index names for a table - asked of
   * SAP rather than of the graph, which keeps standard types out and may be
   * an hour old. OTYPE and NAME lead the key, so this is an index lookup
   * however large the table's use; the include patterns only filter what it
   * found.
   */
  private async tableCandidates(table: string): Promise<string[]> {
    const includes: string[] = [];
    // One statement per prefix: a 30-character name and every pattern of two
    // prefixes would not fit the 255 characters a statement may have.
    for (const prefix of graphPrefixes()) {
      const patterns = [`${prefix}%`, `L${prefix}%`, `SAPL${prefix}%`];
      const sql = `SELECT include FROM wbcrossgt WHERE otype = 'TY' AND name = '${table}' AND ( ${patterns.map(pattern => `include LIKE '${pattern}'`).join(' OR ')} )`;
      const payload: any = await this.queries.runQueryCore({ sqlQuery: sql, rowNumber: 100000 });
      const values = Array.isArray(payload?.result?.values) ? payload.result.values : [];
      includes.push(...values.map((row: any) => String(row.INCLUDE ?? row.include ?? '').trim()).filter(Boolean));
    }
    return includes;
  }

  private async read(url: string): Promise<string> {
    const cached = sourceCache.get(url);
    if (cached !== undefined) return cached;
    const source = await this.tracked(`Failed to read ${url}`, () => this.readClient.getObjectSource(url));
    sourceCache.set(url, source);
    return source;
  }
}

/**
 * A walk of several levels, shown so that the deeper levels are not crowded
 * out by the first: the list limit is shared between the levels, and every
 * level's full count is given.
 */
function levels(walk: WalkEntry[], maxResults: number): { byDepth: Record<number, number>; shown: Record<string, unknown>[]; budgetReached: boolean } {
  const byDepth: Record<number, number> = {};
  for (const entry of walk) byDepth[entry.depth] = (byDepth[entry.depth] || 0) + 1;
  const depths = Object.keys(byDepth).map(Number);
  const share = Math.max(1, Math.floor(maxResults / Math.max(1, depths.length)));
  const shown = depths.flatMap(depth => walk.filter(entry => entry.depth === depth).slice(0, share))
    .map(entry => ({ depth: entry.depth, via: entry.via, ...compactNode(entry.node) }));
  return { byDepth, shown, budgetReached: walk.length >= WALK_BUDGET };
}

/** Objects a delta reloaded, shown up to this many - a transport import can touch hundreds. */
const MAX_RELOADED_SHOWN = 20;

const summarized = (result: SyncResult): Record<string, unknown> => {
  const reloaded = result.objectsReloaded;
  if (!reloaded || reloaded.length <= MAX_RELOADED_SHOWN) return { ...result };
  return { ...result, objectsReloaded: reloaded.slice(0, MAX_RELOADED_SHOWN), objectsReloadedCount: reloaded.length };
};
/** The word to look for in a caller's code: the member called, or the object. */
const targetName = (node: GraphNode): string => node.functionName || node.member || node.object;

const dropEmpty = <T extends Record<string, unknown>>(value: T): T => {
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined || item === null || item === '' || (Array.isArray(item) && item.length === 0)) delete value[key];
  }
  return value;
};

const compactNode = (node: GraphNode): Record<string, unknown> => dropEmpty({
  name: node.label,
  kind: node.kind,
  object: node.member || node.kind === 'function' ? node.object : undefined,
  package: node.package,
  text: node.text
});

const compactCaller = (entry: CallerEntry): Record<string, unknown> => dropEmpty({
  ...compactNode(entry),
  part: entry.part === 'method' || entry.part === 'function' ? undefined : entry.part,
  include: entry.kind === 'method' || entry.kind === 'function' ? undefined : entry.include,
  programs: entry.programs,
  kinds: entry.kinds.length === 1 && entry.kinds[0] === 'method' ? undefined : entry.kinds,
  uses: entry.uses,
  references: entry.references > 1 ? entry.references : undefined
});

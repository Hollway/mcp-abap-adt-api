/**
 * Environment-driven server configuration.
 *
 * Every value is read lazily: dotenv loads .env after the module graph is
 * imported, so anything captured at import time would miss it.
 */
import { readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * The version this server tells a client about on initialize.
 *
 * It used to be a literal in the constructor, and the literal stopped being
 * true three releases ago: the server announced 1.0.0 while the package was
 * at 1.3.0, so the one place a client can ask which build it is talking to
 * answered with a number nobody had shipped. Read it from the package
 * instead, from beside the compiled file and from beside the sources, which
 * is where the tests run from.
 */
export const serverVersion = (): string => {
  for (const candidate of [join(__dirname, '..', '..', 'package.json'), join(__dirname, '..', '..', '..', 'package.json')]) {
    try {
      const version = JSON.parse(readFileSync(candidate, 'utf8'))?.version;
      if (typeof version === 'string' && version.trim()) return version.trim();
    } catch {
      // Not there, or not readable - try the next place.
    }
  }
  return '0.0.0';
};

/**
 * When the build that is answering was compiled.
 *
 * The version alone cannot say whether a process is running the code just
 * compiled: inside one working session every build carries the same number,
 * and five servers share one dist, so a process left over from before the
 * build announces exactly what a restarted one does. The modification time of
 * the file actually loaded does say it - __filename is the compiled module
 * when the server runs from dist, and the source file when the tests run it.
 */
export const buildStamp = (): string | undefined => {
  try {
    return statSync(__filename).mtime.toISOString();
  } catch {
    // A bundle with no file behind it, or a read that is not allowed.
    return undefined;
  }
};

/** When this process started, which is when it last picked up a build. */
export const startedAt = (): string =>
  new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

const truthy = (value: string | undefined): boolean =>
  !!value && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());

/**
 * Refuse every tool that changes the target system.
 *
 * For a system that must not be touched (a production or QA client opened only
 * for reading), this is a fence in the server itself rather than a deny list in
 * whichever client happens to be connected.
 */
export const isReadOnly = (): boolean => truthy(process.env.SAP_READONLY);

const tokenSet = (raw: string | undefined): Set<string> => {
  if (!raw) return new Set();
  return new Set(
    raw.split(/[,\s]+/).map(t => t.trim()).filter(t => t.length > 0)
  );
};

/**
 * Tool groups or individual tool names to hide, comma or space separated
 * (SAP_TOOLS_EXCLUDE=debugger,traces,atc,git). The whole list is some 160,000
 * characters of tool definitions, spent on every session before a word is
 * said, and most sessions need a fraction of it.
 */
export const excludedTokens = (): Set<string> => tokenSet(process.env.SAP_TOOLS_EXCLUDE);

/**
 * Tool groups or names to serve, to the exclusion of everything else
 * (SAP_TOOLS_INCLUDE=source,package,codeAnalysis). The other way round from
 * the exclusion list, and the cheaper one to write when a session needs ten
 * tools out of a hundred and eighty; SAP_TOOLS_PROFILE names a ready-made set.
 * Exclusion still wins, and healthcheck is served either way - a server that
 * cannot say which system it is on is a worse trade than one extra tool.
 */
export const includedTokens = (): Set<string> => tokenSet(process.env.SAP_TOOLS_INCLUDE);

/** Named set of groups to serve (SAP_TOOLS_PROFILE=read), expanded by toolFilter. */
export const toolProfileName = (): string => (process.env.SAP_TOOLS_PROFILE || '').trim().toLowerCase();

/**
 * Groups or tool names allowed through despite SAP_READONLY
 * (SAP_READONLY_ALLOW=debugger). For a system that should not be developed on
 * but does need one specific capability - debugging a running session, say -
 * this keeps the fence around everything else instead of turning it off.
 *
 * These tools are still not reads: they keep readOnlyHint false, so a client
 * still treats them as changing the system.
 */
export const readOnlyAllowances = (): Set<string> => tokenSet(process.env.SAP_READONLY_ALLOW);

/** Log verbosity for the stderr logger. */
export const logLevel = (): 'error' | 'warn' | 'info' | 'debug' => {
  const raw = (process.env.LOG_LEVEL || 'warn').trim().toLowerCase();
  return raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug'
    ? raw
    : 'warn';
};

/**
 * Cap on the serialized size of a single tool result. Some ADT answers are
 * enormous (userTransports with targets can exceed 400k characters) and blow
 * up the caller's context before it can even look at them.
 */
export const maxResponseChars = (): number => {
  const raw = Number(process.env.SAP_MAX_RESPONSE_CHARS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 200000;
};

/**
 * Read a duration given in seconds, the unit an operator thinks in.
 */
const seconds = (raw: string | undefined, fallbackSeconds: number): number => {
  const value = Number(raw);
  return Math.floor((Number.isFinite(value) && value > 0 ? value : fallbackSeconds) * 1000);
};

const count = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

/**
 * How long an idle session that holds no locks is kept before it is logged
 * off (SAP_SESSION_IDLE_TTL, seconds).
 *
 * Keeping it costs a SAP session and buys the next call a warm login; there
 * is nothing else to lose by closing it, which is why this one is short.
 */
export const sessionIdleTtlMs = (): number =>
  seconds(process.env.SAP_SESSION_IDLE_TTL, 900);

/**
 * How long an idle session that still holds locks is kept
 * (SAP_SESSION_IDLE_TTL_LOCKED, seconds).
 *
 * Longer, because closing it drops locks their owner may still be planning to
 * use, and the answer to a lock nobody wants any more is a person looking at
 * who took it - not the server guessing.
 *
 * The default is 28 minutes because SAP settles the upper bound: with
 * rdisp/plugin_auto_logout and http/security_session_timeout at 1800 seconds
 * (the value on our systems), a session idle for half an hour is gone and its locks
 * with it. Keeping the entry longer would buy its owner nothing and cost a
 * slot in the pool.
 *
 * Why 28 and not 29 or 30: the sweep runs once a minute, so a session is
 * closed somewhere between its limit and a minute later. Aiming at 1800
 * exactly means routinely arriving after SAP has already dropped the
 * session - the locks come off either way, but nobody sees which ones. A
 * two-minute margin buys a deliberate unlock with a line in the log naming
 * what was released.
 */
export const lockedSessionIdleTtlMs = (): number =>
  seconds(process.env.SAP_SESSION_IDLE_TTL_LOCKED, 1680);

/**
 * How many SAP sessions this server may hold at once (SAP_MAX_SESSIONS).
 *
 * Every pooled user costs two sessions on the backend - the stateful one and
 * the stateless clone reads go through - so the default is deliberately well
 * under what a system can take: our development system runs 16 dialogue work processes and
 * icm/max_conn = 100, and this server is not entitled to all of it. Systems
 * differ, which is why it is a parameter.
 */
export const maxSessions = (): number => count(process.env.SAP_MAX_SESSIONS, 25);

/**
 * How many tool calls may be in flight against SAP at once
 * (SAP_MAX_CONCURRENT). Beyond this the server answers 503 rather than
 * queueing without limit: dialogue work processes are shared with everybody
 * else on the system.
 */
export const maxConcurrentCalls = (): number => count(process.env.SAP_MAX_CONCURRENT, 8);

/** Where the HTTP transport listens (MCP_HOST, MCP_PORT). */
export const httpHost = (): string => (process.env.MCP_HOST || '0.0.0.0').trim();
/**
 * Port to listen on. Zero is allowed and means any free port - which is how
 * the tests start a server without picking a number that might be taken.
 */
export const httpPort = (): number => {
  const value = Number(process.env.MCP_PORT);
  return Number.isInteger(value) && value >= 0 && value < 65536 ? value : 3000;
};

/**
 * Largest request body accepted (MCP_MAX_BODY_MB).
 *
 * Writing a class sends its whole source in one JSON-RPC call, so the usual
 * small default for a JSON body is the wrong shape of limit here: it would
 * refuse exactly the calls this server exists for.
 */
export const maxBodyBytes = (): number => count(process.env.MCP_MAX_BODY_MB, 50) * 1024 * 1024;

/**
 * How long one request may take (MCP_REQUEST_TIMEOUT, seconds).
 *
 * Generous, because an ATC run, a unit test run or the activation of a large
 * package legitimately takes minutes, and cutting those off leaves the work
 * running on the backend with nobody to read the answer.
 */
export const requestTimeoutMs = (): number => seconds(process.env.MCP_REQUEST_TIMEOUT, 600);

/**
 * Origins allowed to reach the endpoint (MCP_ALLOWED_ORIGINS, comma
 * separated). Unset means no origin check - the transport is behind an
 * ingress that does its own, and turning it on by default would refuse
 * clients that send no Origin at all.
 */
export const allowedOrigins = (): string[] => [...tokenSet(process.env.MCP_ALLOWED_ORIGINS)];

/**
 * Token guarding the diagnostic endpoints (SAP_ADMIN_TOKEN).
 *
 * Unset disables them outright rather than leaving them open: /sessions names
 * who is connected and what they have locked, and DELETE ends somebody else
 * session. Both are for an operator, not for whoever can reach the port.
 */
export const adminToken = (): string | undefined => process.env.SAP_ADMIN_TOKEN?.trim() || undefined;

/**
 * What this server assumes the backend session timeout to be
 * (SAP_ASSUMED_SESSION_TIMEOUT, seconds).
 *
 * Nothing reads it from SAP - rdisp/plugin_auto_logout and
 * http/security_session_timeout are not in a table this server can query, and
 * an ICF service can narrow them further. It is used only to check that the
 * locked-session limit is comfortably inside it, and to say so at startup
 * when it is not. Guessing wrong here is not fatal: it costs the deliberate
 * unlock, not the unlock itself.
 */
export const assumedSessionTimeoutMs = (): number =>
  seconds(process.env.SAP_ASSUMED_SESSION_TIMEOUT, 1800);

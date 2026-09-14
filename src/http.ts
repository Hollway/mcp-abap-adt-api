/**
 * The HTTP transport: one server, many users, credentials per request.
 *
 * The shape is deliberately narrow. A request arrives with HTTP Basic
 * credentials, those name a session in the pool, and the MCP machinery runs
 * inside that session - so the locks it takes, the source it caches and the
 * counters it moves belong to the caller and to nobody else. What the request
 * does NOT do is open or close a SAP session: that is the pool's business,
 * and confusing the two is what made the previous HTTP version leave a
 * session behind on every single call.
 *
 * Built on node:http rather than a framework. What is needed here is five
 * routes, a size-limited JSON body and honest status codes; the MCP SDK takes
 * the native request and response objects as they are.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AbapAdtServer } from './index.js';
import { parseBasicAuth } from './lib/auth';
import type { BasicCredentials } from './lib/auth';
import { sapTarget, keyFor, openSession } from './lib/adtTarget';
import type { SapTarget } from './lib/adtTarget';
import { SessionPool, PoolFullError } from './lib/sessionPool';
import type { PooledSession } from './lib/sessionPool';
import { isMutatingTool } from './lib/toolClasses';
import { describeAdtError } from './lib/adtError';
import { processMetrics } from './lib/metrics';
import { backendHealth } from './lib/backendHealth';
import { createLogger } from './lib/logger';
import { newRequestId, runInRequest, nameTool, currentRequest } from './lib/requestContext';
import {
  httpHost,
  httpPort,
  maxBodyBytes,
  requestTimeoutMs,
  allowedOrigins,
  adminToken,
  maxConcurrentCalls,
  assumedSessionTimeoutMs,
  sessionIdleTtlMs,
  lockedSessionIdleTtlMs,
  maxSessions
} from './lib/serverConfig';

/** JSON-RPC error codes this layer produces itself. */
const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  internal: -32603,
  /** Server-defined range: the caller has to act, and can. */
  unauthorized: -32001,
  busy: -32002
} as const;

const sendJson = (
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void => {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
};

const rpcError = (
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
  data?: unknown
): void =>
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: data === undefined ? { code, message } : { code, message, data },
    id: null
  }, headers);

/**
 * Read the request body, refusing one that is too large before it is in
 * memory rather than after.
 */
const readBody = (req: IncomingMessage, limit: number): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0;
    let refused = false;
    const chunks: Buffer[] = [];
    const tooLarge = () =>
      Object.assign(
        new Error(`Request body exceeds ${Math.round(limit / 1024 / 1024)} MB.`),
        { tooLarge: true }
      );

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (refused) {
        // Way past the point of arguing: a sender still going at four times
        // the limit is not going to be talked out of it by a status code.
        if (size > limit * 4) req.destroy();
        return;
      }
      if (size > limit) {
        refused = true;
        // Keep reading and throw it away rather than tearing the socket
        // down: the client is still sending, and a connection reset in the
        // middle of that is what it would see instead of the 413 that
        // explains the problem. Nothing more is kept, so the oversized body
        // never lands in memory.
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => refused ? reject(tooLarge()) : resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', error => refused ? reject(tooLarge()) : reject(error));
  });

/** Every tool named in a JSON-RPC message, batch or not. */
const toolsCalled = (body: unknown): string[] => {
  const one = (message: any): string | undefined =>
    message?.method === 'tools/call' && typeof message?.params?.name === 'string'
      ? message.params.name
      : undefined;
  const messages = Array.isArray(body) ? body : [body];
  return messages.map(one).filter((name): name is string => !!name);
};

const secondsOf = (ms: number): number => Math.round(ms / 1000);

/**
 * Request-level events go through the structured logger so they carry the
 * request id, the caller and the tool. The startup banner and the pool
 * bookkeeping stay plain text: nobody correlates those with a call.
 */
const log = createLogger('http');

export interface HttpServerHandle {
  readonly port: number;
  readonly pool: SessionPool;
  /**
   * Stop listening, let what is in flight finish, then log every session off.
   * Bounded: a call that will not finish must not keep the process alive.
   */
  close(drainMs?: number): Promise<void>;
}

export function createPool(target: SapTarget): SessionPool {
  return new SessionPool({
    createClient: (credentials: BasicCredentials) => openSession(target, credentials),
    idleTtlMs: sessionIdleTtlMs,
    lockedIdleTtlMs: lockedSessionIdleTtlMs,
    maxSessions
  });
}

export async function startHttpServer(pool?: SessionPool): Promise<HttpServerHandle> {
  const target = sapTarget();
  const sessions = pool ?? createPool(target);
  const origins = allowedOrigins();
  const admin = adminToken();
  let inFlight = 0;
  let draining = false;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // An Origin check only when one is configured: a client that sends no
    // Origin at all is the normal case here, and refusing those by default
    // would break every one of them.
    const origin = req.headers.origin;
    if (origins.length && origin && !origins.includes(origin)) {
      rpcError(res, 403, RPC.invalidRequest, `Origin ${origin} is not allowed.`);
      return;
    }

    if (path === '/health') {
      sendJson(res, draining ? 503 : 200, {
        status: draining ? 'draining' : 'ok',
        transport: 'http',
        system: target.url,
        client: target.client,
        sessions: sessions.size(),
        inFlight,
        // Reported, not acted on: this process is healthy even when the
        // system it talks to is not, and restarting it would not help.
        sapDegraded: backendHealth.snapshot().degraded
      });
      return;
    }

    /**
     * Readiness cannot say whether SAP is reachable: this server holds no
     * credentials of its own - every one of them belongs to a caller - so
     * there is nothing to log in with. It reports what it does know: whether
     * this process is taking work and whether the pool has room.
     */
    if (path === '/ready') {
      /**
       * Ready means "send me traffic", and the only thing that makes this
       * process unfit for traffic is that it is going away.
       *
       * Deliberately NOT reported here: a full pool, and whether SAP
       * answers. A full pool is busy, not unfit - failing readiness for it
       * would pull the only replica out of the load balancer and stop even
       * the 503 that names who is holding the sessions. And SAP is a
       * dependency every replica shares: failing on it would empty the
       * service of endpoints without doing anything for SAP, and replace a
       * diagnosable error with a connection refused. Both are reported on
       * /metrics instead, where they inform rather than act.
       */
      sendJson(res, draining ? 503 : 200, {
        status: draining ? 'draining' : 'ready',
        sessions: sessions.size(),
        maxSessions: maxSessions(),
        inFlight,
        maxConcurrent: maxConcurrentCalls()
      });
      return;
    }

    if (path === '/metrics') {
      sendJson(res, 200, {
        process: processMetrics.snapshot(),
        sap: backendHealth.snapshot(),
        pool: {
          sessions: sessions.size(),
          maxSessions: maxSessions(),
          inFlight,
          idleTtlSeconds: secondsOf(sessionIdleTtlMs()),
          lockedIdleTtlSeconds: secondsOf(lockedSessionIdleTtlMs())
        }
      });
      return;
    }

    if (path === '/sessions' || path.startsWith('/sessions/')) {
      await handleSessions(req, res, path);
      return;
    }

    if (path !== '/mcp') {
      rpcError(res, 404, RPC.invalidRequest, `No such endpoint: ${path}.`);
      return;
    }

    if (req.method !== 'POST') {
      rpcError(res, 405, RPC.invalidRequest, 'Method not allowed; this endpoint takes POST.', { allow: 'POST' });
      return;
    }

    await handleMcp(req, res);
  };

  /**
   * The diagnostic endpoints, and why they are shut unless a token is set:
   * /sessions names who is connected and what they have locked, and the
   * delete ends somebody else's session. That is an operator's business, not
   * that of whoever can reach the port.
   */
  const handleSessions = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    if (!admin) {
      rpcError(res, 404, RPC.invalidRequest,
        'The session endpoints are disabled. Set SAP_ADMIN_TOKEN on the server to enable them.');
      return;
    }
    if (req.headers['x-admin-token'] !== admin) {
      rpcError(res, 403, RPC.unauthorized, 'Wrong or missing X-Admin-Token.');
      return;
    }

    if (req.method === 'GET' && path === '/sessions') {
      sendJson(res, 200, { sessions: sessions.describe(), maxSessions: maxSessions() });
      return;
    }

    if (req.method === 'DELETE' && path.startsWith('/sessions/')) {
      const user = decodeURIComponent(path.slice('/sessions/'.length)).toUpperCase();
      const match = sessions.describe().find(s => s.user === user);
      if (!match) {
        rpcError(res, 404, RPC.invalidRequest, `No session held for ${user}.`);
        return;
      }
      try {
        const closed = await sessions.close(keyFor(target, { user, password: '' }), 'requested');
        sendJson(res, 200, { closed });
      } catch (error) {
        // In flight right now: closing it would pull the session out from
        // under a call that is still running.
        rpcError(res, 409, RPC.busy, error instanceof Error ? error.message : 'Could not close the session.');
      }
      return;
    }

    rpcError(res, 405, RPC.invalidRequest, 'Use GET /sessions or DELETE /sessions/<user>.', { allow: 'GET, DELETE' });
  };

  const handleMcp = (req: IncomingMessage, res: ServerResponse): Promise<void> =>
    runInRequest({ id: newRequestId() }, () => serveMcp(req, res));

  const serveMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const auth = parseBasicAuth(req.headers.authorization);
    if (!auth.ok) {
      log.warn('refused: no usable credentials', { failure: auth.failure });
      rpcError(res, 401, RPC.unauthorized, auth.message, {
        'www-authenticate': `Basic realm="${target.url}", charset="UTF-8"`
      });
      return;
    }
    const context = currentRequest();
    if (context) context.user = auth.credentials.user;

    let body: unknown;
    try {
      const raw = await readBody(req, maxBodyBytes());
      body = raw ? JSON.parse(raw) : undefined;
    } catch (error: any) {
      if (error?.tooLarge) {
        // The rest of the body is never read, so this connection cannot be
        // reused - say so rather than leaving the client to discover it.
        rpcError(res, 413, RPC.invalidRequest, error.message, { connection: 'close' });
      } else {
        rpcError(res, 400, RPC.parse, 'The request body is not valid JSON.');
      }
      return;
    }

    if (draining) {
      rpcError(res, 503, RPC.busy, 'This server is shutting down.', { 'retry-after': '5' });
      return;
    }

    if (inFlight >= maxConcurrentCalls()) {
      rpcError(res, 503, RPC.busy,
        `This server is already running ${inFlight} calls against SAP; try again shortly.`,
        { 'retry-after': '2' });
      return;
    }

    let session: PooledSession;
    try {
      session = await sessions.acquire(keyFor(target, auth.credentials), auth.credentials);
    } catch (error) {
      reportAcquireFailure(res, error, auth.credentials);
      return;
    }

    inFlight += 1;
    try {
      // Writes on one session go one at a time: a lock, the write it guards
      // and the unlock only mean anything in that order. Reads travel on the
      // stateless clone and have nothing to serialise against.
      const tools = toolsCalled(body);
      nameTool(tools[0]);
      // logout ends the SAP session from inside the request and leaves a
      // client that cannot log in again; dropSession keeps the client but
      // voids every lock handle it was holding. Neither is visible to the
      // pool unless it is told, and an untold pool would serve the next
      // caller a session that can only fail.
      if (tools.includes('logout')) sessions.retire(session, 'requested');
      if (tools.includes('dropSession')) session.state.locks.clear();
      const exclusive = tools.some(isMutatingTool);
      const serve = () => sessions.run(session, () => dispatch(req, res, session, body));
      await (exclusive ? sessions.runExclusive(session, serve) : serve());
      backendHealth.reachable();
      log.info('served', { durationMs: Date.now() - started, exclusive });
    } catch (error) {
      log.error('request failed', {
        durationMs: Date.now() - started,
        reason: describeAdtError(error).error
      });
      rpcError(res, 500, RPC.internal, describeAdtError(error).error);
    } finally {
      inFlight -= 1;
      sessions.release(session);
      await sessions.closeIfRetired(session).catch(error =>
        log.error('closing a retired session failed', { reason: describeAdtError(error).error })
      );
    }
  };

  /**
   * One MCP server per request, on a session that outlives it.
   *
   * Building the server is a few dozen assignments and no I/O, so it is far
   * cheaper than what it buys: no shared MCP state between callers. Closing
   * it at the end closes the transport and nothing else - the SAP session
   * stays in the pool, which is the whole point.
   */
  const dispatch = async (
    req: IncomingMessage,
    res: ServerResponse,
    session: PooledSession,
    body: unknown
  ): Promise<void> => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = new AbapAdtServer(session.client);
    let closed = false;
    const closeOnce = () => {
      if (closed) return;
      closed = true;
      Promise.resolve(transport.close()).catch(() => undefined);
      Promise.resolve(server.close()).catch(() => undefined);
    };
    res.on('close', closeOnce);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      closeOnce();
    }
  };

  const reportAcquireFailure = (res: ServerResponse, error: unknown, credentials: BasicCredentials): void => {
    if (error instanceof PoolFullError) {
      log.warn('refused: the pool is full', {
        held: error.sessions.length,
        limit: error.limit,
        holders: error.sessions.map(s => `${s.user}:${s.locks}`)
      });
      rpcError(res, 503, RPC.busy, error.message, { 'retry-after': '30' }, { sessions: error.sessions });
      return;
    }
    const info = describeAdtError(error);
    if (info.status === 401 || info.status === 403) {
      // The backend answered - it just said no to this password. That is a
      // fact about one caller, not about the system.
      backendHealth.reachable();
      log.warn('refused: SAP rejected the credentials');
      rpcError(res, info.status, RPC.unauthorized, 'SAP rejected these credentials.', {
        'www-authenticate': `Basic realm="${target.url}", charset="UTF-8"`
      });
      return;
    }
    backendHealth.unreachable(info.error);
    log.error('could not open a session', {
      reason: info.error,
      consecutiveFailures: backendHealth.snapshot().consecutiveFailures
    });
    rpcError(res, 502, RPC.internal, `Could not open a SAP session: ${info.error}`);
  };

  const httpServer: HttpServer = createServer((req, res) => {
    handler(req, res).catch(error => {
      log.error('unhandled failure', { reason: describeAdtError(error).error });
      rpcError(res, 500, RPC.internal, 'Internal server error.');
    });
  });

  // Node would otherwise cut a request off after two minutes, which is well
  // inside what an ATC run or a package activation legitimately takes.
  httpServer.requestTimeout = requestTimeoutMs();
  httpServer.headersTimeout = Math.min(60_000, requestTimeoutMs());

  const host = httpHost();
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(httpPort(), host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  // The port actually bound, which is not the configured one when that was 0.
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : httpPort();

  sessions.start();

  console.error(`[http] listening on http://${host}:${port}`);
  console.error(`[http]   MCP        : POST   http://${host}:${port}/mcp   (HTTP Basic, SAP credentials)`);
  console.error(`[http]   health     : GET    http://${host}:${port}/health, /ready, /metrics`);
  console.error(
    admin
      ? `[http]   sessions   : GET/DELETE http://${host}:${port}/sessions (X-Admin-Token)`
      : '[http]   sessions   : disabled (set SAP_ADMIN_TOKEN to enable /sessions)'
  );
  console.error(
    `[http]   pool       : up to ${maxSessions()} sessions, ${maxConcurrentCalls()} calls at once, ` +
    `idle ${secondsOf(sessionIdleTtlMs())}s / ${secondsOf(lockedSessionIdleTtlMs())}s with locks`
  );
  if (!origins.length) {
    console.error('[http]   origins    : not checked (set MCP_ALLOWED_ORIGINS to restrict)');
  }

  /**
   * The locked-session limit only buys a deliberate unlock while it lands
   * inside the backend timeout - and the sweep runs once a minute, so the
   * real closing time is up to a minute later than the limit says. Past that
   * point SAP gets there first: the locks still come off, but nobody sees
   * which ones.
   */
  const assumed = assumedSessionTimeoutMs();
  if (lockedSessionIdleTtlMs() + 60_000 > assumed) {
    console.error(
      `[http] WARNING: SAP_SESSION_IDLE_TTL_LOCKED is ${secondsOf(lockedSessionIdleTtlMs())}s, ` +
      `which the sweep can stretch past the ${secondsOf(assumed)}s this server assumes SAP allows. ` +
      'Locked sessions will usually be gone before they are cleaned up, so their locks will be ' +
      'released by the timeout rather than named in the log. Lower it, or set ' +
      'SAP_ASSUMED_SESSION_TIMEOUT if this system allows longer.'
    );
  }

  return {
    port,
    pool: sessions,
    async close(drainMs = 10_000): Promise<void> {
      // Refuse new work first, so /ready turns 503 and the load balancer
      // stops sending requests before the ones in flight are disturbed.
      draining = true;
      sessions.stop();

      /**
       * Let what is running finish.
       *
       * httpServer.close() waits for open connections, and HTTP keep-alive
       * means a client that is merely idle holds one - so on its own it can
       * wait forever for somebody who has stopped asking. Closing the idle
       * ones and waiting on the in-flight count instead separates "still
       * working" from "still connected".
       */
      httpServer.closeIdleConnections?.();
      const until = Date.now() + drainMs;
      while (inFlight > 0 && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (inFlight > 0) {
        console.error(`[http] ${inFlight} request(s) did not finish in time; closing anyway`);
      }

      await new Promise<void>(resolve => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
      const closed = await sessions.closeAll('shutdown');
      const withLocks = closed.filter(c => c.locks > 0);
      if (withLocks.length) {
        console.error(
          `[http] shutdown released locks held by: ` +
          withLocks.map(c => `${c.user} (${c.locks})`).join(', ')
        );
      }
      console.error(`[http] stopped, ${closed.length} session(s) logged off`);
    }
  };
}

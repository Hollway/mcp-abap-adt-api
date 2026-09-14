#!/usr/bin/env node
/**
 * Process entry point.
 *
 * index.ts used to construct and start the server as a side effect of being
 * imported, which is why nothing could import it - not a test, not an HTTP
 * layer. It is now a module that exports the class; choosing a transport and
 * starting it happens here.
 */

import { AbapAdtServer, announceTarget } from './index.js';
import { startHttpServer } from './http.js';
import type { HttpServerHandle } from './http.js';

type Transport = 'stdio' | 'http';

const transportFromEnv = (): Transport => {
  const raw = (process.env.MCP_TRANSPORT || 'stdio').trim().toLowerCase();
  if (raw === 'stdio' || raw === 'http') return raw;
  throw new Error(`MCP_TRANSPORT must be 'stdio' or 'http', got '${raw}'`);
};

/**
 * Shut down on the signal an orchestrator actually sends.
 *
 * Kubernetes sends SIGTERM on every rolling update, and a server that
 * ignores it leaves its SAP sessions - and their locks - behind on each
 * redeploy. Draining is bounded: a call that will not finish must not keep
 * the pod alive forever, but it must not stop the sessions being logged off
 * either, which is why the guard fires well after the drain would.
 */
const onShutdown = (close: () => Promise<void>, graceMs = 20_000): void => {
  let closing = false;
  const stop = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.error(`[main] ${signal} received, shutting down`);
    const guard = setTimeout(() => {
      console.error('[main] shutdown took too long, exiting anyway');
      process.exit(1);
    }, graceMs);
    guard.unref?.();
    try {
      await close();
    } catch (error) {
      console.error('[main] shutdown failed:', error instanceof Error ? error.message : error);
    }
    clearTimeout(guard);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  /**
   * Go down the same way on a programming error as on a signal.
   *
   * The default for an uncaught exception is to print it and exit at once,
   * which over HTTP leaves every pooled SAP session - and its locks -
   * behind. The process still dies; it just says goodbye first.
   */
  process.on('uncaughtException', error => {
    console.error('[main] uncaught exception:', error);
    void stop('uncaughtException');
  });
  process.on('unhandledRejection', reason => {
    console.error('[main] unhandled rejection:', reason);
    void stop('unhandledRejection');
  });
};

async function main(): Promise<void> {
  const transport = transportFromEnv();

  if (transport === 'http') {
    announceTarget('http');
    const handle: HttpServerHandle = await startHttpServer();
    onShutdown(() => handle.close());
    return;
  }

  const server = new AbapAdtServer();
  announceTarget();
  await server.run();
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error instanceof Error ? error.message : error);
  process.exit(1);
});

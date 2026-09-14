/**
 * Which SAP system this process talks to, and how a session to it is opened.
 *
 * One process serves one system: the URL, the client and the language come
 * from the environment and are the same for everybody. Only the credentials
 * differ per caller, which is why they are the only thing passed in.
 *
 * Deploying one server per SAP client is the decision behind that - it keeps
 * the pool honest (every session in it is comparable), keeps the read-only
 * fence meaningful (one profile, one system), and makes "which system am I
 * looking at" a property of the URL a user connects to.
 */
import { ADTClient, session_types } from 'abap-adt-api';
import type { BasicCredentials } from './auth';
import { sessionKey } from './auth';

export interface SapTarget {
  url: string;
  client?: string;
  language?: string;
}

/** The system from the environment, refusing to guess at a missing URL. */
export function sapTarget(): SapTarget {
  const url = process.env.SAP_URL;
  if (!url) {
    throw new Error('Missing required environment variable: SAP_URL.');
  }
  return {
    url,
    client: process.env.SAP_CLIENT || undefined,
    language: process.env.SAP_LANGUAGE || undefined
  };
}

/** The pool key for one caller against this system. */
export const keyFor = (target: SapTarget, credentials: BasicCredentials): string =>
  sessionKey({ ...target, user: credentials.user });

/**
 * Open a session for one caller.
 *
 * The login is done here rather than left to the first call that needs it.
 * abap-adt-api logs in lazily, so several calls arriving together on a fresh
 * client would each find themselves logged out and each start their own login
 * - opening sessions the pool never hears about. One deliberate login on the
 * way in costs one round trip and removes that race.
 *
 * Stateful, because locks and source writes require it. Reads are served by
 * the stateless clone the handlers reach through BaseHandler.readClient.
 */
export async function openSession(
  target: SapTarget,
  credentials: BasicCredentials
): Promise<ADTClient> {
  const client = new ADTClient(
    target.url,
    credentials.user,
    credentials.password,
    target.client as string,
    target.language as string
  );
  client.stateful = session_types.stateful;
  await client.login();
  return client;
}

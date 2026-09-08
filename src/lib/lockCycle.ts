/**
 * Taking and releasing the lock a write needs.
 *
 * Three tools now run the same sequence around a write - editObject, the DDIC
 * creations, createAndWrite - and each of them has the same two obligations:
 * the session has to be stateful (dropSession and logout reset it, and a lock
 * on a stateless session is refused), and a lock this process already holds
 * must be reused rather than doubled and left behind. Keeping that in one
 * place is the difference between a lock leak being impossible and being one
 * forgotten line away.
 */
import { session_types } from 'abap-adt-api';
import type { ADTClient } from 'abap-adt-api';
import { lockRegistry } from './lockRegistry';
import { describeAdtError } from './adtError';

/** Called once per backend call so a handler can keep counting them. */
export type Track = (startTime: number, success: boolean) => void;

export interface TakenLock {
  lockHandle: string;
  /** False when the lock was already held by this process and got reused. */
  taken: boolean;
}

export async function takeLock(
  client: ADTClient,
  objectUrl: string,
  accessMode?: string,
  track?: Track
): Promise<TakenLock> {
  const held = lockRegistry.get(objectUrl);
  if (held) return { lockHandle: held.lockHandle, taken: false };

  const startTime = performance.now();
  try {
    client.stateful = session_types.stateful;
    const lock = await client.lock(objectUrl, accessMode);
    lockRegistry.remember(objectUrl, lock.LOCK_HANDLE, accessMode);
    track?.(startTime, true);
    return { lockHandle: lock.LOCK_HANDLE, taken: true };
  } catch (error: any) {
    track?.(startTime, false);
    throw error;
  }
}

export interface ReleasedLock {
  released: boolean;
  error?: string;
}

/**
 * Release a lock and forget it, reporting rather than throwing: the caller is
 * usually in the middle of reporting something else, and a lock that would not
 * come off is a line in that report, not a reason to lose it.
 */
export async function releaseLock(
  client: ADTClient,
  objectUrl: string,
  lockHandle: string,
  track?: Track
): Promise<ReleasedLock> {
  const startTime = performance.now();
  try {
    client.stateful = session_types.stateful;
    await client.unLock(objectUrl, lockHandle);
    lockRegistry.forget(objectUrl);
    track?.(startTime, true);
    return { released: true };
  } catch (error: any) {
    track?.(startTime, false);
    return { released: false, error: describeAdtError(error).error };
  }
}

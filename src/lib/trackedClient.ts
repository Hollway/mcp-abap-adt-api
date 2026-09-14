/**
 * A client that says when it was last used.
 *
 * The pool has to know when the stateful session last talked to SAP, because
 * that - not when its owner was last seen - is what SAP counts down to a
 * timeout. Reads travel on the stateless clone and keep that one alive
 * instead, so somebody who spends half an hour reading keeps the clone warm
 * while the session holding their locks quietly expires.
 *
 * The first attempt at this listed the tools that use the stateful client and
 * marked those. It was wrong in the quiet way a list is always wrong: three
 * read-only tools (healthcheck, atcCheck, inactiveObjects) go through the
 * stateful client too, so their calls kept the SAP session alive while the
 * pool believed it was idle - and would have closed it, taking the locks with
 * it, in the middle of somebody working.
 *
 * Observing the client itself has no list to keep up to date: whatever calls
 * it, for whatever reason, is a call on that session.
 */
import type { ADTClient } from 'abap-adt-api';

/**
 * Wrap a client so every method call reports back.
 *
 * Only calls count. Reading a property - baseUrl, username, csrfToken - is
 * local and reaches no backend, and `statelessClone` is deliberately handed
 * back untouched: the clone is a different SAP session, and a read on it says
 * nothing about the life of this one.
 */
export function trackUse<T extends object>(client: T, onUse: () => void): T {
  // One wrapper per method, kept: a fresh closure on every property read
  // would break identity comparisons and allocate on a hot path.
  const wrappers = new Map<PropertyKey, unknown>();

  return new Proxy(client, {
    get(target, property, receiver) {
      // Read against the target, not the proxy: a getter that reaches for
      // other members of the object - statelessClone does - would otherwise
      // come back through this trap and report uses that never happened.
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;

      const cached = wrappers.get(property);
      if (cached) return cached;

      const wrapper = (...args: unknown[]) => {
        onUse();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
      wrappers.set(property, wrapper);
      return wrapper;
    },

    set(target, property, value) {
      // Assignments are local too - `stateful` is the one that matters - so
      // they pass straight through without counting as use.
      return Reflect.set(target, property, value, target);
    }
  }) as T;
}

/** Convenience for the pool, which only ever wraps an ADT client. */
export const trackAdtClient = (client: ADTClient, onUse: () => void): ADTClient =>
  trackUse(client, onUse);

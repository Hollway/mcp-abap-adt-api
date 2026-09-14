/**
 * Request counters.
 *
 * Each handler used to keep its own counters and log the whole set on every
 * single request, which produced a line of noise per call and told nobody
 * anything: the numbers were per handler instance and never surfaced. They are
 * collected here instead and reported by healthcheck.
 *
 * They are counted twice over, at two scopes that answer different questions.
 * Per session, because "what have my calls been doing" is what healthcheck is
 * asked and the answer must not be inflated by everyone else's traffic. Per
 * process, because "is this server healthy" is asked by whoever runs it, and
 * that one has to span every user.
 */
import { currentSession } from './sessionContext';

interface Counters {
  requests: number;
  successes: number;
  failures: number;
  totalMs: number;
}

interface Rounded {
  requests: number;
  successes: number;
  failures: number;
  averageMs: number;
}

export interface MetricsSnapshot extends Rounded {
  handlers: Record<string, Rounded>;
}

export interface MetricsRegistry {
  record(handler: string, durationMs: number, success: boolean): void;
  snapshot(): MetricsSnapshot;
  reset(): void;
}

const empty = (): Counters => ({ requests: 0, successes: 0, failures: 0, totalMs: 0 });

const add = (c: Counters, durationMs: number, success: boolean) => {
  c.requests++;
  c.totalMs += durationMs;
  if (success) c.successes++;
  else c.failures++;
};

export function createMetrics(): MetricsRegistry {
  const totals = empty();
  const byHandler = new Map<string, Counters>();

  return {
    record(handler: string, durationMs: number, success: boolean): void {
      add(totals, durationMs, success);
      const own = byHandler.get(handler) || empty();
      add(own, durationMs, success);
      byHandler.set(handler, own);
    },

    snapshot(): MetricsSnapshot {
      const round = (c: Counters): Rounded => ({
        requests: c.requests,
        successes: c.successes,
        failures: c.failures,
        averageMs: c.requests > 0 ? Math.round(c.totalMs / c.requests) : 0
      });
      const handlers: Record<string, Rounded> = {};
      for (const [name, c] of byHandler) handlers[name] = round(c);
      return { ...round(totals), handlers };
    },

    reset(): void {
      totals.requests = totals.successes = totals.failures = totals.totalMs = 0;
      byHandler.clear();
    }
  };
}

/** Everything this process has done, across every session it has served. */
export const processMetrics = createMetrics();

/**
 * The counters of the session currently running.
 *
 * Recording goes to both scopes; reading and resetting stay with the session,
 * because that is what the caller asking has any business seeing.
 */
export const metrics: MetricsRegistry = {
  record(handler: string, durationMs: number, success: boolean): void {
    currentSession().metrics.record(handler, durationMs, success);
    processMetrics.record(handler, durationMs, success);
  },
  snapshot: () => currentSession().metrics.snapshot(),
  reset: () => currentSession().metrics.reset()
};

/**
 * Process-wide request counters.
 *
 * Each handler used to keep its own counters and log the whole set on every
 * single request, which produced a line of noise per call and told nobody
 * anything: the numbers were per handler instance and never surfaced. They are
 * collected here instead and reported by healthcheck.
 */
interface Counters {
  requests: number;
  successes: number;
  failures: number;
  totalMs: number;
}

const totals: Counters = { requests: 0, successes: 0, failures: 0, totalMs: 0 };
const byHandler = new Map<string, Counters>();

const empty = (): Counters => ({ requests: 0, successes: 0, failures: 0, totalMs: 0 });

const add = (c: Counters, durationMs: number, success: boolean) => {
  c.requests++;
  c.totalMs += durationMs;
  if (success) c.successes++;
  else c.failures++;
};

export const metrics = {
  record(handler: string, durationMs: number, success: boolean): void {
    add(totals, durationMs, success);
    const own = byHandler.get(handler) || empty();
    add(own, durationMs, success);
    byHandler.set(handler, own);
  },

  snapshot() {
    const round = (c: Counters) => ({
      requests: c.requests,
      successes: c.successes,
      failures: c.failures,
      averageMs: c.requests > 0 ? Math.round(c.totalMs / c.requests) : 0
    });
    const handlers: Record<string, ReturnType<typeof round>> = {};
    for (const [name, c] of byHandler) handlers[name] = round(c);
    return { ...round(totals), handlers };
  },

  reset(): void {
    totals.requests = totals.successes = totals.failures = totals.totalMs = 0;
    byHandler.clear();
  }
};

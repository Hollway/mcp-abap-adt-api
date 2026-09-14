/**
 * Whether SAP is answering, judged from the traffic that is already going.
 *
 * The tempting alternative is a probe: a technical user, a login every few
 * seconds, a green light. It was rejected deliberately. This server holds no
 * credentials of its own - every one of them belongs to a caller - and
 * introducing a standing account with a password in the deployment would
 * give that property away for a check that reports less than the real calls
 * already do.
 *
 * So the signal is passive. Every request that reaches SAP votes, and what
 * accumulates is "the last N attempts all failed to reach the backend",
 * which is what an alert actually wants to know.
 *
 * Credentials being rejected is NOT a failure here: a wrong password is a
 * fact about one caller, not about the system. Only failures that mean "the
 * backend did not answer" count.
 */
export interface BackendHealth {
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailure?: string;
  consecutiveFailures: number;
  /** True once enough calls in a row failed to reach SAP. */
  degraded: boolean;
}

const DEGRADED_AFTER = 3;

let lastSuccessAt: string | undefined;
let lastFailureAt: string | undefined;
let lastFailure: string | undefined;
let consecutiveFailures = 0;

export const backendHealth = {
  /** A call reached SAP and got an answer, whatever the answer was. */
  reachable(): void {
    lastSuccessAt = new Date().toISOString();
    consecutiveFailures = 0;
  },

  /** A call did not reach SAP at all - network, ICM, a dead host. */
  unreachable(reason: string): void {
    lastFailureAt = new Date().toISOString();
    lastFailure = reason;
    consecutiveFailures += 1;
  },

  snapshot(): BackendHealth {
    return {
      lastSuccessAt,
      lastFailureAt,
      lastFailure,
      consecutiveFailures,
      degraded: consecutiveFailures >= DEGRADED_AFTER
    };
  },

  reset(): void {
    lastSuccessAt = undefined;
    lastFailureAt = undefined;
    lastFailure = undefined;
    consecutiveFailures = 0;
  }
};

/**
 * Environment-driven server configuration.
 *
 * Every value is read lazily: dotenv loads .env after the module graph is
 * imported, so anything captured at import time would miss it.
 */

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
 * (SAP_TOOLS_EXCLUDE=debugger,traces,atc,git). 132 tools is a lot of context
 * to spend when a session only ever needs a handful of them.
 */
export const excludedTokens = (): Set<string> => tokenSet(process.env.SAP_TOOLS_EXCLUDE);

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

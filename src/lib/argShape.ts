/**
 * Object-shaped parameters, checked before the library dereferences them.
 *
 * Several tools take an object that another call produced - a git repository,
 * a rename refactoring, a quick-fix proposal, a service binding. Handed
 * something else, or nothing, the library read a field of undefined and the
 * TypeError surfaced as a transport error:
 *
 *   checkRepo      Cannot read properties of undefined (reading 'find')
 *   renamePreview  Cannot read properties of undefined (reading 'uri')
 *   fixEdits       Cannot read properties of undefined (reading 'match')
 *   bindingDetails Cannot read properties of undefined (reading 'find')
 *
 * None of those say what was expected or where it comes from, and all four
 * read as a fault of the backend rather than of the call. The check belongs
 * here, before the request is made.
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export interface ShapeExpectation {
  /** Name of the parameter, as the schema spells it. */
  parameter: string;
  /** Fields the library reads, without which it throws. */
  fields: string[];
  /** The call that produces such an object, for the message. */
  producedBy: string;
}

/** Which of the expected fields are absent from the value. */
export function missingFields(value: unknown, fields: string[]): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [...fields];
  const record = value as Record<string, unknown>;
  return fields.filter(f => record[f] === undefined || record[f] === null || record[f] === '');
}

/**
 * Refuse a parameter that is not the object the library will dereference,
 * naming what is missing and what produces it.
 */
export function requireShape(value: unknown, expectation: ShapeExpectation): void {
  const missing = missingFields(value, expectation.fields);
  if (!missing.length) return;
  const had =
    value === undefined || value === null
      ? 'nothing was passed'
      : typeof value !== 'object' || Array.isArray(value)
        ? `a ${Array.isArray(value) ? 'list' : typeof value} was passed`
        : `these fields are missing: ${missing.join(', ')}`;
  throw new McpError(
    ErrorCode.InvalidParams,
    `Pass ${expectation.parameter} as the object ${expectation.producedBy} hands back - ${had}. ` +
      `The fields it is read for are: ${expectation.fields.join(', ')}.`
  );
}

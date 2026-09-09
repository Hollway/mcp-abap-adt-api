/**
 * Reading the backend's answer to "may I create this object?".
 *
 * abap-adt-api's validateNewObject reports success as `!!CHECK_RESULT ||
 * !!SEVERITY`, so an answer that carries neither comes back as success:false.
 * That is not a refusal: the message class endpoint answers the validation
 * POST with HTTP 200 and an empty body, and a caller that gates on `success`
 * refuses a perfectly free name. A real objection arrives either as an
 * exception (the library throws on SEVERITY "ERROR") or with a SHORT_TEXT
 * saying what is wrong.
 */
export interface ValidationVerdict {
  /** Set only when the backend actually objected - the text to show. */
  objection?: string;
  /** True when the answer carried nothing at all: no objection, no blessing. */
  silent: boolean;
}

export function readValidation(validation: any): ValidationVerdict {
  const severity = validation?.SEVERITY;
  const shortText = validation?.SHORT_TEXT;
  const succeeded = validation?.success !== false;

  if (succeeded) return { silent: false };
  if (shortText) return { objection: String(shortText), silent: false };
  if (severity) return { objection: `The system reported ${severity}.`, silent: false };
  return { silent: true };
}

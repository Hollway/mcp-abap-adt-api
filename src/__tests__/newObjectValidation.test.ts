import { readValidation } from '../lib/newObjectValidation';

/**
 * abap-adt-api computes success as `!!CHECK_RESULT || !!SEVERITY`, so an
 * endpoint that answers the validation POST with 200 and an empty body - the
 * message class one does exactly that - comes back as success:false. Gating a
 * creation on that alone refuses a free name, which is how message classes
 * turned out to be uncreatable.
 */
describe('readValidation', () => {
  it('passes a plain success through', () => {
    expect(readValidation({ success: true })).toEqual({ silent: false });
  });

  it('treats an answer with no verdict at all as silence, not refusal', () => {
    expect(readValidation({ success: false })).toEqual({ silent: true });
    expect(readValidation({})).toEqual({ silent: false });
    expect(readValidation(undefined)).toEqual({ silent: false });
  });

  it('reports a real objection with the text the backend gave', () => {
    expect(readValidation({ success: false, SEVERITY: 'WARNING', SHORT_TEXT: 'Name already used.' }))
      .toEqual({ objection: 'Name already used.', silent: false });
  });

  it('reports a severity that came without a text', () => {
    expect(readValidation({ success: false, SEVERITY: 'WARNING' }))
      .toEqual({ objection: 'The system reported WARNING.', silent: false });
  });
});

/**
 * Text elements the way the system itself stores them: a text pool.
 *
 * ADT serves /sap/bc/adt/textelements only on some releases - on the ERP
 * system these tools were written against it is not there at all - and the
 * texts are then reachable only through ABAP: READ TEXTPOOL and INSERT
 * TEXTPOOL, run as a snippet. Everything that is easy to get wrong about that
 * pool lives in this module, away from the handler, so it can be tested
 * without a system.
 *
 * What a pool row looks like was measured on two systems rather than guessed:
 * a scan of 1,835 standard reports yielded exactly five ID letters.
 *
 *   I  text symbols (TEXT-001)      KEY = the three-character key, not always
 *                                   digits (001, S01, 11L); ENTRY = the text;
 *                                   LENGTH = the declared maximum, not the
 *                                   length of the text
 *   S  selection texts              KEY = the field name; ENTRY = eight
 *                                   characters of flags followed by the text;
 *                                   LENGTH = 8 + the maximum
 *   R  the program title            KEY empty. ADT never serves this one, so
 *                                   it is not part of any category here
 *   T  the list header              KEY empty
 *   H  the column headers           KEY = 001..004
 *
 * The eight characters in front of a selection text are flags, not indentation:
 * a D in the first position means the text comes from the data dictionary.
 * Writing eight blanks over them would silently cut that link, so an update
 * keeps the flags a row already has - and that lookup happens inside the
 * generated ABAP, on the pool as it stands at the moment of the write.
 */

export class TextPoolError extends Error {}

export type TextPoolLetter = 'I' | 'S' | 'R' | 'T' | 'H';

/** A row of the pool, as READ TEXTPOOL hands it over. */
export interface TextPoolRow {
  id: TextPoolLetter;
  key: string;
  entry: string;
  length: number;
}

/** A text element in the shape ADT uses, which the fallback has to match. */
export interface PoolTextElement {
  id: string;
  text: string;
  maxLength?: number;
  /** Set when the flags say the text is taken from the dictionary. */
  fromDictionary?: boolean;
}

export type PoolCategory = 'symbols' | 'selections' | 'headings';

/** The flag field in front of a selection text. Eight characters, always. */
export const SELECTION_FLAG_LENGTH = 8;

/** ENTRY is CHAR 132 in the pool, prefix included. */
export const ENTRY_LIMIT = 132;

export const LIST_HEADER_ID = 'listHeader';
export const COLUMN_HEADER_PREFIX = 'columnHeader_';
export const COLUMN_HEADER_COUNT = 4;

/** The separator the generated ABAP prints its rows with. */
export const FIELD_SEPARATOR = '~#~';

/** Which letters of the pool a category is made of. */
export function lettersFor(category: PoolCategory): TextPoolLetter[] {
  switch (category) {
    case 'symbols': return ['I'];
    case 'selections': return ['S'];
    case 'headings': return ['T', 'H'];
    default:
      throw new TextPoolError(`Unknown category '${category}'.`);
  }
}

const isLetter = (value: string): value is TextPoolLetter =>
  value === 'I' || value === 'S' || value === 'R' || value === 'T' || value === 'H';

/**
 * A character literal for the generated ABAP: 'X', with quotes doubled.
 *
 * Program names and keys go through here. They are checked as well as escaped -
 * a name that needs escaping at all is a name this module should not be
 * building a statement out of.
 */
export function charLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * A string literal for the generated ABAP: `x`, with backticks doubled.
 *
 * Texts go through here rather than through quotes, because a backtick literal
 * keeps trailing blanks and needs no doubling of the apostrophes that are
 * common in the texts themselves.
 */
export function stringLiteral(value: string): string {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new TextPoolError('A text element cannot contain a line break.');
  }
  return '`' + text.replace(/`/g, '``') + '`';
}

/**
 * The program name, checked before it is pasted into a statement.
 *
 * The equals signs are not decoration: a class keeps its texts in a pool named
 * ZCL_FOO=======================CP, and a pattern without them refuses every
 * class there is - which is how the first live read of one failed.
 */
export function programLiteral(name: string): string {
  const program = String(name || '').trim().toUpperCase();
  if (!/^[A-Z0-9_/$][A-Z0-9_/=]{0,39}$/.test(program)) {
    throw new TextPoolError(`'${name}' does not look like a program name.`);
  }
  return charLiteral(program);
}

/**
 * The lines that put the language into lv_langu.
 *
 * With nothing given the session language is the right one - it is the language
 * the texts were read in everywhere else in this server. A caller who does pass
 * one may pass either form: R, the one-character SAP key the pool is indexed
 * by, or RU, the two-character ISO code ADT uses. The conversion is the
 * system's own, because the mapping is not "take the first letter": Chinese is
 * ZH in ADT and 1 in the pool.
 */
export function languageLines(language?: string): string[] {
  const given = String(language || '').trim();
  if (!given) return ['lv_langu = sy-langu.'];
  if (given.length === 1) return [`lv_langu = ${charLiteral(given.toUpperCase())}.`];
  if (given.length === 2) {
    const iso = given.toUpperCase();
    return [
      'TRY.',
      `    lv_langu = cl_i18n_languages=>sap2_to_sap1( ${charLiteral(iso)} ).`,
      '  CATCH cx_root.',
      `    lv_langu = ${charLiteral(iso[0])}.`,
      'ENDTRY.'
    ];
  }
  throw new TextPoolError(
    `'${language}' is not a language: pass the one-character SAP key (R) or the two-character ISO code (RU).`
  );
}

/**
 * Only what the snippet uses.
 *
 * A declaration nothing reads is a warning at activation, and the activation
 * messages are how a caller is told what is wrong with a snippet - they are
 * worth keeping empty.
 */
const declarations = (options: { forWrite?: boolean; needsFlags?: boolean } = {}): string[] => [
  'DATA lt_pool TYPE TABLE OF textpool.',
  ...(options.forWrite ? ['DATA lt_before TYPE TABLE OF textpool.'] : []),
  'DATA ls_row TYPE textpool.',
  ...(options.forWrite ? ['DATA ls_new TYPE textpool.'] : []),
  ...(options.needsFlags ? ['DATA lv_prefix TYPE c LENGTH 8.'] : []),
  'DATA lv_subrc TYPE i.',
  'DATA lv_langu TYPE sy-langu.'
];

/**
 * Printing a row.
 *
 * ENTRY goes in brackets and last: the eight flag characters of a selection
 * text are blanks in the common case, and without the brackets there is no
 * telling them from the space around a separator.
 */
const printRows = (): string[] => [
  'LOOP AT lt_pool INTO ls_row.',
  '  out->write( |ROW' + FIELD_SEPARATOR + '{ ls_row-id }' + FIELD_SEPARATOR +
    '{ ls_row-key }' + FIELD_SEPARATOR + '{ ls_row-length }' + FIELD_SEPARATOR +
    '[{ ls_row-entry }]| ).',
  'ENDLOOP.'
];

/** The snippet that reads the pool of a program. */
export function readPoolSnippet(program: string, language?: string): string[] {
  const literal = programLiteral(program);
  return [
    ...declarations(),
    ...languageLines(language),
    `READ TEXTPOOL ${literal} INTO lt_pool LANGUAGE lv_langu.`,
    // sy-subrc is taken before anything else: out->write is a method call and
    // resets it, which has silently swallowed a failure here before.
    'lv_subrc = sy-subrc.',
    `out->write( |READ${FIELD_SEPARATOR}{ lv_subrc }${FIELD_SEPARATOR}{ lines( lt_pool ) }| ).`,
    ...printRows()
  ];
}

export interface PoolPrint {
  rows: TextPoolRow[];
  /** sy-subrc of the read, which is 4 when the program has no pool at all. */
  subrc?: number;
  steps: Record<string, number>;
}

/** What the generated ABAP printed, back as rows. */
export function parsePoolPrint(output: string): PoolPrint {
  const rows: TextPoolRow[] = [];
  const steps: Record<string, number> = {};
  let subrc: number | undefined;
  const separator = FIELD_SEPARATOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rowPattern = new RegExp(
    `^ROW${separator}([ISRTH])${separator}(.*?)${separator}(-?\\d+)${separator}\\[([\\s\\S]*)\\]$`
  );
  const stepPattern = new RegExp(`^(READ|INSERT)${separator}(-?\\d+)${separator}(-?\\d+)$`);

  for (const raw of String(output || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const step = stepPattern.exec(line);
    if (step) {
      const name = step[1].toLowerCase();
      steps[name] = Number(step[2]);
      steps[`${name}Rows`] = Number(step[3]);
      if (step[1] === 'READ' && subrc === undefined) subrc = Number(step[2]);
      continue;
    }
    const row = rowPattern.exec(line);
    if (!row) continue;
    const id = row[1];
    if (!isLetter(id)) continue;
    rows.push({ id, key: row[2], entry: row[4], length: Number(row[3]) });
  }
  return { rows, subrc, steps };
}

const headingIdOf = (row: TextPoolRow): string | undefined => {
  if (row.id === 'T') return LIST_HEADER_ID;
  const index = Number(row.key);
  if (!Number.isInteger(index) || index < 1 || index > COLUMN_HEADER_COUNT) return undefined;
  return `${COLUMN_HEADER_PREFIX}${index}`;
};

/**
 * The rows of one category, in the shape ADT answers with.
 *
 * headings is the awkward one: ADT serves it as five elements - the list header
 * and four column headers - and serves them even when the program has none, as
 * empty texts. A program without a list header has no T row at all, so the
 * empty ones are filled in here.
 */
export function elementsFromRows(rows: TextPoolRow[], category: PoolCategory): PoolTextElement[] {
  if (category === 'symbols') {
    return rows
      .filter(row => row.id === 'I')
      .map(row => ({ id: row.key, text: row.entry, maxLength: row.length }));
  }

  if (category === 'selections') {
    return rows
      .filter(row => row.id === 'S')
      .map(row => {
        const flags = row.entry.slice(0, SELECTION_FLAG_LENGTH);
        const element: PoolTextElement = { id: row.key, text: row.entry.slice(SELECTION_FLAG_LENGTH) };
        if (flags.startsWith('D')) element.fromDictionary = true;
        return element;
      });
  }

  const byId = new Map<string, TextPoolRow>();
  for (const row of rows) {
    if (row.id !== 'T' && row.id !== 'H') continue;
    const id = headingIdOf(row);
    if (id) byId.set(id, row);
  }
  const ids = [
    LIST_HEADER_ID,
    ...Array.from({ length: COLUMN_HEADER_COUNT }, (_, index) => `${COLUMN_HEADER_PREFIX}${index + 1}`)
  ];
  return ids.map(id => {
    const row = byId.get(id);
    return row ? { id, text: row.entry, maxLength: row.length } : { id, text: '' };
  });
}

/** One row the write is going to put into the pool. */
export interface PoolWrite {
  letter: TextPoolLetter;
  key: string;
  text: string;
  length: number;
  /** True for selection texts, whose flags are carried over in ABAP. */
  keepsFlags: boolean;
}

const headingRowFor = (id: string): { letter: TextPoolLetter; key: string } => {
  if (id === LIST_HEADER_ID) return { letter: 'T', key: '' };
  const match = new RegExp(`^${COLUMN_HEADER_PREFIX}([1-${COLUMN_HEADER_COUNT}])$`).exec(id);
  if (!match) {
    throw new TextPoolError(
      `'${id}' is not a heading: they are ${LIST_HEADER_ID} and ` +
      `${COLUMN_HEADER_PREFIX}1..${COLUMN_HEADER_PREFIX}${COLUMN_HEADER_COUNT}.`
    );
  }
  return { letter: 'H', key: `00${match[1]}` };
};

/**
 * The rows to write, and what had to be decided along the way.
 *
 * LENGTH is the declared maximum rather than the length of the text, so it
 * comes from maxLength when one is given. A text longer than that maximum
 * widens it instead of being cut - losing the tail of a text silently is the
 * worse of the two - and every such decision is reported back in notes.
 */
export function writesFor(
  category: PoolCategory,
  elements: PoolTextElement[],
  notes: string[] = []
): PoolWrite[] {
  if (!Array.isArray(elements)) {
    throw new TextPoolError('elements must be an array of {id, text}.');
  }
  const writes: PoolWrite[] = [];
  const seen = new Set<string>();

  for (const element of elements) {
    const id = String(element?.id ?? '').trim();
    if (!id) throw new TextPoolError('Every element needs an id.');
    const text = String(element?.text ?? '');

    let letter: TextPoolLetter;
    let key: string;
    if (category === 'headings') {
      ({ letter, key } = headingRowFor(id));
    } else {
      letter = category === 'symbols' ? 'I' : 'S';
      key = id.toUpperCase();
      if (key.length > SELECTION_FLAG_LENGTH) {
        throw new TextPoolError(`The key '${id}' is longer than ${SELECTION_FLAG_LENGTH} characters.`);
      }
    }

    const marker = `${letter}${key}`;
    if (seen.has(marker)) throw new TextPoolError(`'${id}' is in the list twice.`);
    seen.add(marker);

    const keepsFlags = letter === 'S';
    const room = ENTRY_LIMIT - (keepsFlags ? SELECTION_FLAG_LENGTH : 0);
    if (text.length > room) {
      throw new TextPoolError(
        `The text of '${id}' is ${text.length} characters; a pool entry holds ${room} here` +
        (keepsFlags ? ` (${ENTRY_LIMIT} less the ${SELECTION_FLAG_LENGTH} flag characters).` : '.')
      );
    }

    const given = element?.maxLength;
    let maximum = text.length;
    if (given !== undefined && given !== null) {
      const asked = Number(given);
      if (!Number.isInteger(asked) || asked < 0) {
        throw new TextPoolError(`The maxLength of '${id}' is not a whole number.`);
      }
      if (asked > room) {
        throw new TextPoolError(`The maxLength of '${id}' is ${asked}; a pool entry holds ${room} here.`);
      }
      maximum = asked;
      if (text.length > asked) {
        maximum = text.length;
        notes.push(
          `The text of '${id}' is ${text.length} characters and maxLength said ${asked}: ` +
          'the length was widened to fit rather than the text cut.'
        );
      }
    }

    if (text === '') {
      notes.push(`'${id}' has an empty text, so its row leaves the pool rather than being written empty.`);
    }

    writes.push({
      letter,
      key,
      text,
      length: keepsFlags ? maximum + SELECTION_FLAG_LENGTH : maximum,
      keepsFlags
    });
  }

  return writes;
}

/**
 * The program title, which is a pool row of its own.
 *
 * ADT serves it in no category - it cannot be read or written over the
 * endpoint at all - so it is a parameter here rather than an element, and it
 * only exists on the text pool path. The row has letter R and an empty key.
 */
export const TITLE_LETTER: TextPoolLetter = 'R';

export function titleFromRows(rows: TextPoolRow[]): { text: string; maxLength: number } | undefined {
  const row = rows.find(candidate => candidate.id === TITLE_LETTER);
  return row ? { text: row.entry, maxLength: row.length } : undefined;
}

/** The row a title is written as, under the same length rule as an element. */
export function titleWrite(title: string, maxLength?: number, notes: string[] = []): PoolWrite {
  const text = String(title ?? '');
  if (text.length > ENTRY_LIMIT) {
    throw new TextPoolError(`The title is ${text.length} characters; a pool entry holds ${ENTRY_LIMIT}.`);
  }
  let maximum = text.length;
  if (maxLength !== undefined && maxLength !== null) {
    const asked = Number(maxLength);
    if (!Number.isInteger(asked) || asked < 0 || asked > ENTRY_LIMIT) {
      throw new TextPoolError(`The titleMaxLength is not a length a pool entry can have (0 to ${ENTRY_LIMIT}).`);
    }
    maximum = asked;
    if (text.length > asked) {
      maximum = text.length;
      notes.push(
        `The title is ${text.length} characters and titleMaxLength said ${asked}: ` +
        'the length was widened to fit rather than the title cut.'
      );
    }
  }
  if (text === '') {
    notes.push('The title is empty, so its row leaves the pool rather than being written empty.');
  }
  return { letter: TITLE_LETTER, key: '', text, length: maximum, keepsFlags: false };
}

export interface WriteSnippetSpec {
  program: string;
  category: PoolCategory;
  writes: PoolWrite[];
  language?: string;
  /** Update only the rows given, instead of replacing the whole category. */
  merge?: boolean;
}

/**
 * The snippet that writes the pool back.
 *
 * Read, change and write happen in one run on purpose: INSERT TEXTPOOL replaces
 * the pool whole, so a write built on a pool read in an earlier call would drop
 * every text somebody else added in between - and every text of the categories
 * this call is not about.
 */
export function writePoolSnippet(spec: WriteSnippetSpec): string[] {
  const literal = programLiteral(spec.program);
  const letters = lettersFor(spec.category);
  const lines: string[] = [
    ...declarations({ forWrite: true, needsFlags: spec.writes.some(write => write.keepsFlags) }),
    ...languageLines(spec.language),
    `READ TEXTPOOL ${literal} INTO lt_pool LANGUAGE lv_langu.`,
    'lv_subrc = sy-subrc.',
    `out->write( |READ${FIELD_SEPARATOR}{ lv_subrc }${FIELD_SEPARATOR}{ lines( lt_pool ) }| ).`,
    // The flags of the selection texts come from the pool as it was before any
    // of this touched it.
    'lt_before = lt_pool.'
  ];

  if (!spec.merge) {
    for (const letter of letters) {
      lines.push(`DELETE lt_pool WHERE id = ${charLiteral(letter)}.`);
    }
  }

  for (const write of spec.writes) {
    const key = charLiteral(write.key);
    const letter = charLiteral(write.letter);
    lines.push(
      'CLEAR ls_new.',
      `ls_new-id = ${letter}.`,
      `ls_new-key = ${key}.`
    );
    if (write.keepsFlags) {
      lines.push(
        'lv_prefix = space.',
        `READ TABLE lt_before INTO ls_row WITH KEY id = ${letter} key = ${key}.`,
        'IF sy-subrc = 0.',
        `  lv_prefix = ls_row-entry(${SELECTION_FLAG_LENGTH}).`,
        'ENDIF.',
        // Offsets, not a string template. A template converts a C field and
        // drops its trailing blanks, and the flag field is a D followed by
        // seven of them: |{ lv_prefix }| && text wrote "DText" instead of
        // "D       Text", and the next read cut eight characters off the front
        // of the text. Measured on a live selection text, which came back as
        // the last two letters of itself.
        `ls_new-entry(${SELECTION_FLAG_LENGTH}) = lv_prefix.`,
        `ls_new-entry+${SELECTION_FLAG_LENGTH} = ${stringLiteral(write.text)}.`
      );
    } else {
      lines.push(`ls_new-entry = ${stringLiteral(write.text)}.`);
    }
    lines.push(
      `ls_new-length = ${write.length}.`,
      `DELETE lt_pool WHERE id = ${letter} AND key = ${key}.`
    );
    // An empty text is not an empty row: a program without a list header has no
    // T row at all, and that is what clearing one has to leave behind.
    if (write.text !== '') lines.push('APPEND ls_new TO lt_pool.');
  }

  lines.push(
    'SORT lt_pool BY id key.',
    `INSERT TEXTPOOL ${literal} FROM lt_pool LANGUAGE lv_langu STATE 'A'.`,
    'lv_subrc = sy-subrc.',
    `out->write( |INSERT${FIELD_SEPARATOR}{ lv_subrc }${FIELD_SEPARATOR}{ lines( lt_pool ) }| ).`,
    // What the pool holds afterwards, so the caller is told what is there
    // rather than what was asked for.
    `READ TEXTPOOL ${literal} INTO lt_pool LANGUAGE lv_langu.`,
    'lv_subrc = sy-subrc.',
    ...printRows()
  );

  return lines;
}

/**
 * The program whose pool holds the texts of an object.
 *
 * Only a program has a text pool of its own. A function group keeps its texts
 * in its main program, SAPL<group>, and a class in its class pool - the name
 * padded to thirty characters with equals signs and CP on the end. That naming
 * is the system's, not a convention of this server.
 */
/**
 * The object a transport request carries, which is not the pool program.
 *
 * The texts of a function group live in `SAPL<group>`, but what travels is
 * `R3TR FUGR <group>`; a class keeps them in its class pool and travels as
 * `R3TR CLAS <name>`. Registering the pool program itself would put a name in
 * the request that the transport system does not recognise as an object.
 */
export function transportObjectFor(objectType: string, objectName: string): { object: string; objName: string } {
  const name = String(objectName || '').trim().toUpperCase();
  const type = String(objectType || 'PROG/P').trim().toUpperCase();
  if (type.startsWith('FUGR')) return { object: 'FUGR', objName: name };
  if (type.startsWith('CLAS')) return { object: 'CLAS', objName: name };
  if (type.startsWith('INTF')) return { object: 'INTF', objName: name };
  return { object: 'PROG', objName: name };
}

export function poolProgramFor(objectType: string, objectName: string): string {
  const name = String(objectName || '').trim().toUpperCase();
  const type = String(objectType || 'PROG/P').trim().toUpperCase();
  if (type.startsWith('FUGR')) return `SAPL${name}`;
  if (type.startsWith('CLAS') || type.startsWith('INTF')) {
    return `${name}${'='.repeat(Math.max(0, 30 - name.length))}CP`;
  }
  return name;
}

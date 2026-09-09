/**
 * The source form of a table or a structure.
 *
 * ADT serves both TABL/DS and TABL/DT from one collection - ddic/structures -
 * as a DDL text, and that text is the only place the field list, the types and
 * the key flags can be read or written. There is no ddic/tables collection at
 * all on a classic ERP system: the type map inside abap-adt-api points at one,
 * which is why creating a transparent table over ADT answers "Resource
 * /sap/bc/adt/ddic/tables does not exist".
 *
 * Two things about that text are release-dependent and are therefore never
 * guessed here. The opening keyword is one: this backend writes and accepts
 * `define type NAME {`, while newer releases use `define structure`, so the
 * opener is taken from the stub the backend itself just created. The other is
 * that a QUAN or CURR field needs a unit annotation and is refused without one
 * - an error worth surfacing from a syntax check before activation rather than
 * from the activation itself.
 */

export interface StructureField {
  name: string;
  /** Data element or built-in type, e.g. WERKS_D or abap.char(10). */
  type: string;
  keyField?: boolean;
  notNull?: boolean;
  /** Field in this structure holding the unit of a quantity field. */
  unitField?: string;
  /** Field in this structure holding the currency of an amount field. */
  currencyField?: string;
  /** Field annotations, written above the field verbatim. */
  annotations?: string[];
}

export const structureUrl = (name: string): string =>
  `/sap/bc/adt/ddic/structures/${encodeURIComponent(String(name).trim().toLowerCase())}`;

export const structureSourceUrl = (name: string): string => `${structureUrl(name)}/source/main`;

/** The `define ... {` line, exactly as the backend wrote it. */
export function openerFrom(stub: string | undefined, name: string): string {
  const found = String(stub ?? '').match(/^[ \t]*define\s+\w+\s+[\w/]+\s*\{[ \t]*$/m);
  return found ? found[0].trim() : `define type ${String(name).trim().toLowerCase()} {`;
}

export interface BuildOptions {
  name: string;
  description: string;
  fields: StructureField[];
  /** The freshly created object's source, to take the opening keyword from. */
  stub?: string;
  /** #NOT_EXTENSIBLE unless the caller says otherwise. */
  enhancementCategory?: string;
}

/**
 * The reference of a unit or currency annotation is qualified with the
 * structure's own name - a real table writes 'mseg.meins', not 'meins', and
 * the unqualified form is refused with "Annotation with reference to unit code
 * for field MENGE is missing", which says nothing about what is wrong with it.
 */
function semanticsAnnotation(structure: string, kind: 'unit' | 'currency', field: string): string {
  const reference = `${structure.toLowerCase()}.${field.trim().toLowerCase()}`;
  return kind === 'unit'
    ? `@Semantics.quantity.unitOfMeasure : '${reference}'`
    : `@Semantics.amount.currencyCode : '${reference}'`;
}

export function buildStructureSource(options: BuildOptions): string {
  if (!options.fields?.length) {
    throw new Error('A structure needs at least one field.');
  }
  // A reference to a field that is not in the structure cannot activate, and
  // the backend's complaint names the quantity field rather than the typo.
  const declared = new Set(
    options.fields.map(f => String(f.name ?? '').trim().toUpperCase()).filter(Boolean)
  );
  for (const field of options.fields) {
    for (const [kind, referenced] of [['unitField', field.unitField], ['currencyField', field.currencyField]] as const) {
      if (!referenced) continue;
      if (!declared.has(String(referenced).trim().toUpperCase())) {
        throw new Error(
          `Field ${field.name}: ${kind} '${referenced}' is not a field of this structure. ` +
          `It has to be one of ${[...declared].join(', ')}.`
        );
      }
    }
  }

  const seen = new Set<string>();
  const lines: string[] = [
    `@EndUserText.label : '${String(options.description).replace(/'/g, "''")}'`,
    `@AbapCatalog.enhancementCategory : #${(options.enhancementCategory || 'NOT_EXTENSIBLE').replace(/^#/, '')}`,
    openerFrom(options.stub, options.name)
  ];

  for (const field of options.fields) {
    const fieldName = String(field.name ?? '').trim();
    if (!/^[A-Za-z][\w/]*$/.test(fieldName)) {
      throw new Error(`'${fieldName}' is not a field name.`);
    }
    if (seen.has(fieldName.toUpperCase())) {
      throw new Error(`Field ${fieldName} is listed twice.`);
    }
    seen.add(fieldName.toUpperCase());
    const type = String(field.type ?? '').trim();
    if (!type) throw new Error(`Field ${fieldName} has no type.`);

    if (field.unitField) {
      lines.push(`  ${semanticsAnnotation(options.name, 'unit', field.unitField)}`);
    }
    if (field.currencyField) {
      lines.push(`  ${semanticsAnnotation(options.name, 'currency', field.currencyField)}`);
    }
    for (const annotation of field.annotations || []) {
      lines.push(`  ${String(annotation).trim()}`);
    }
    // A key field is not null whether or not the caller said so - SAP stores
    // it that way, and writing it without makes the activation complain.
    const notNull = field.keyField || field.notNull;
    lines.push(
      `  ${field.keyField ? 'key ' : ''}${fieldName.toLowerCase()} : ${type.toLowerCase()}${notNull ? ' not null' : ''};`
    );
  }

  lines.push('}');
  return lines.join('\n');
}

export interface ParsedStructure {
  /** Name as the define line spells it. */
  name: string;
  label?: string;
  fields: StructureField[];
  /** Lines that are neither a field nor an annotation - includes, mostly. */
  other: string[];
}

/**
 * Read the served text back into a field list.
 *
 * This is what makes a table's definition usable: searchObject answers a table
 * with a SAPGUI bridge URI, objectStructure gives its metadata, and neither
 * shows a single field.
 */
export function parseStructureSource(source: string): ParsedStructure {
  const text = String(source ?? '');
  const label = text.match(/@EndUserText\.label\s*:\s*'((?:[^']|'')*)'/);
  const define = text.match(/^[ \t]*define\s+\w+\s+([\w/]+)\s*\{/m);

  const fields: StructureField[] = [];
  const other: string[] = [];
  let pending: string[] = [];
  let inside = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!inside) {
      if (/^define\s+\w+\s+[\w/]+\s*\{/.test(line)) inside = true;
      continue;
    }
    if (!line || line === '}') continue;
    if (line.startsWith('@')) { pending.push(line); continue; }

    const field = line.match(/^(key\s+)?([\w/]+)\s*:\s*(.+?)\s*;$/i);
    if (field) {
      const type = field[3].trim();
      const notNull = /\bnot\s+null$/i.test(type);
      fields.push({
        name: field[2].toUpperCase(),
        type: type.replace(/\s*not\s+null$/i, '').trim(),
        keyField: !!field[1],
        notNull,
        ...(pending.length ? { annotations: [...pending] } : {})
      });
      pending = [];
      continue;
    }
    other.push(line);
    pending = [];
  }

  return {
    name: define ? define[1].toUpperCase() : '',
    ...(label ? { label: label[1].replace(/''/g, "'") } : {}),
    fields,
    other
  };
}

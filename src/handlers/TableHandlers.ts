import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import {
  ddicName,
  headerQuery,
  headerTextQuery,
  fieldsQuery,
  textsQuery,
  domainsQuery,
  indexesQuery,
  indexFieldsQuery,
  foreignKeysQuery,
  foreignKeyFieldsQuery,
  groupByStructure,
  flattenFields,
  includesOf,
  textsByElement,
  applyConversionExits,
  pickText,
  shapeIndexes,
  shapeForeignKeys,
  chunkForQuery,
  TABLE_CLASSES,
  DELIVERY_CLASSES,
  TableFieldsError
} from '../lib/tableFields';
import type { Row, TableField } from '../lib/tableFields';

/**
 * A table as the dictionary knows it, rather than as its definition reads.
 *
 * getStructureSource answers the DDL text and the field list in it, and that
 * list stops at the name of a data element: what the field holds, how long it
 * is and what it is called needed one ddicElement call per field. Worse, an
 * .INCLUDE stayed a line of text - the fields it brings were simply not
 * there, which for EKPO is most of them.
 *
 * So these three read DD02L, DD03L, DD04T, DD01L, DD12L/DD17S and DD08L/DD05S
 * and answer the questions whole. Reading only: no ABAP is executed, which is
 * deliberate, because the dictionary is most often asked about on a system
 * where nothing may run.
 */
/** How many include names an answer lists before it just counts them. */
const INCLUDES_LISTED = 8;

export class TableHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'tableFields',
        description: 'The fields of a table or structure, with the includes spliced in where they sit. Each field carries its position, key and not-null flags, data element, domain, ABAP type, length and decimals, the table its value is checked against, the field holding its unit or currency, and its text in the connection language. This is the answer to "what is in this table": getStructureSource gives the DDL text, where the type of a field is the name of its data element and an .INCLUDE is a line of text rather than the fields it brings - for EKPO, most of them. Reading only, and it executes nothing, so it works on a system where nothing may run.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Table or structure, e.g. EKPO or ZAPPSTEP_POS.'
            },
            expandIncludes: {
              type: 'boolean',
              description: 'Splice the fields of an .INCLUDE into the list. Default true; false lists the include markers instead, which is the shape of the definition.'
            },
            withTexts: {
              type: 'boolean',
              description: 'Read the data element texts. Default true; false saves one query per 60 elements.'
            },
            fields: {
              type: 'string',
              description: 'Keep only the fields whose name contains this text, case-insensitive - for a table with hundreds of them.'
            },
            keysOnly: {
              type: 'boolean',
              description: 'Keep only the key fields. Default false.'
            },
            maxFields: {
              type: 'number',
              description: 'Fields to return, default 200. The full count is reported either way.'
            }
          },
          required: ['name']
        }
      },
      {
        name: 'tableIndexes',
        description: 'The secondary indexes of a table, each with the fields it is built on in order, whether it is unique and what it is called in the database. The answer to why a SELECT does or does not have an index to use. Reading only.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Table, e.g. EKPO.' }
          },
          required: ['name']
        }
      },
      {
        name: 'tableKeys',
        description: 'The foreign keys of a table: for each field, the table its value is checked against, the fields the two are joined on, the cardinality and whether the check is enforced on input. The answer to "where do the values of this field come from". Reading only.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Table, e.g. ZAPPSTEP_POS.' }
          },
          required: ['name']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'tableFields':
        return this.handleTableFields(args);
      case 'tableIndexes':
        return this.handleTableIndexes(args);
      case 'tableKeys':
        return this.handleTableKeys(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown table tool: ${toolName}`);
    }
  }

  private answer(payload: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  private name(args: any): string {
    const raw = String(args?.name || '').trim();
    if (!raw) throw new McpError(ErrorCode.InvalidParams, 'Pass name - the table to read.');
    try {
      return ddicName(raw);
    } catch (error: any) {
      throw new McpError(ErrorCode.InvalidParams, error.message);
    }
  }

  /** Run one SELECT and hand back its rows. */
  private async rows(sql: string, label: string, rowNumber = 1000): Promise<Row[]> {
    const startTime = performance.now();
    try {
      const result: any = await this.readClient.runQuery(sql, rowNumber);
      this.trackRequest(startTime, true);
      return Array.isArray(result?.values) ? result.values as Row[] : [];
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, `Failed to read ${label}`);
    }
  }

  /**
   * The same query over as many names as fit in it.
   *
   * The statement limit is 255 characters, so how many names go in one query
   * depends on the query and on the names - chunkForQuery asks the query
   * itself rather than guessing a count.
   */
  private async rowsForNames(
    names: string[],
    build: (names: string[]) => string,
    label: string
  ): Promise<Row[]> {
    const rows: Row[] = [];
    for (const part of chunkForQuery(names, build)) {
      if (part.length === 0) continue;
      rows.push(...await this.rows(build(part), label));
    }
    return rows;
  }

  /**
   * What kind of object this is, and whether its fields live in DD03L at all.
   *
   * A view keeps its columns elsewhere and a CDS entity is not in DD02L, so
   * both are answered with what they are rather than with an empty field list.
   */
  private async header(name: string): Promise<{ row?: Row; text?: string }> {
    const [rows, texts] = await Promise.all([
      this.rows(headerQuery(name), `the header of ${name}`, 2),
      this.rows(headerTextQuery(name), `the text of ${name}`, 20)
    ]);
    const best = pickText(texts, process.env.SAP_LANGUAGE || 'E');
    return {
      row: rows[0],
      ...(best && best.DDTEXT ? { text: String(best.DDTEXT).trim() } : {})
    };
  }

  async handleTableFields(args: any): Promise<any> {
    const name = this.name(args);
    const expand = args?.expandIncludes !== false;
    const withTexts = args?.withTexts !== false;
    const maxFields = Number(args?.maxFields) > 0 ? Math.floor(Number(args.maxFields)) : 200;

    const { row: header, text: description } = await this.header(name);
    const tabclass = header ? String(header.TABCLASS || '').trim().toUpperCase() : '';

    // Collect the rows level by level: one query per level of includes rather
    // than one per structure.
    const byStructure = new Map<string, Row[]>();
    let wanted = [name];
    const seen = new Set<string>();
    let levels = 0;
    while (wanted.length > 0 && levels < 15) {
      const rows = await this.rowsForNames(wanted, fieldsQuery, `the fields of ${wanted.join(', ')}`);
      for (const [structure, list] of groupByStructure(rows)) byStructure.set(structure, list);
      wanted.forEach(structure => seen.add(structure));
      if (!expand) break;
      const next = new Set<string>();
      for (const structure of wanted) {
        for (const row of byStructure.get(structure) || []) {
          const fieldname = String(row.FIELDNAME || '').trim();
          const included = String(row.PRECFIELD || '').trim().toUpperCase();
          if (fieldname.startsWith('.') && included && !seen.has(included)) next.add(included);
        }
      }
      wanted = [...next];
      levels++;
    }

    if (!byStructure.has(name)) {
      return this.answer({
        status: 'error',
        name,
        ...(tabclass ? { tableClass: TABLE_CLASSES[tabclass] || tabclass } : {}),
        error: header
          ? `${name} is a ${TABLE_CLASSES[tabclass] || tabclass} and keeps no fields in the dictionary field list.`
          : `${name} is not a table or structure in this system.`,
        hint: header
          ? 'A database view keeps its columns in its own definition, and a CDS entity is read with getStructureSource or ddicElement.'
          : 'A structure declared in a type pool or inside a program is not in the dictionary at all - that one is read from its source. Check the name with searchObject; a CDS entity or a table type is read with getStructureSource or ddicElement.'
      });
    }

    let flattened;
    try {
      flattened = flattenFields(name, { byStructure });
    } catch (error: any) {
      if (error instanceof TableFieldsError) throw new McpError(ErrorCode.InvalidParams, error.message);
      throw error;
    }

    // Narrowed before anything is looked up: the texts and the conversion
    // exits are read for the fields that come back, not for the 400 of EKPO.
    let fields: TableField[] = flattened.fields;
    const total = fields.length;
    const filter = String(args?.fields || '').trim().toUpperCase();
    if (filter) fields = fields.filter(field => field.name.includes(filter));
    if (args?.keysOnly === true) fields = fields.filter(field => field.key === true);
    const selected = fields.length;
    if (fields.length > maxFields) fields = fields.slice(0, maxFields);

    const domains = [...new Set(fields.map(field => field.domain).filter((d): d is string => !!d))];
    if (domains.length) {
      fields = applyConversionExits(
        fields,
        await this.rowsForNames(domains, domainsQuery, 'the domains')
      );
    }

    if (withTexts) {
      const elements = [...new Set(fields.map(field => field.dataElement).filter((e): e is string => !!e))];
      if (elements.length) {
        const texts = textsByElement(
          await this.rowsForNames(elements, textsQuery, 'the data element texts'),
          process.env.SAP_LANGUAGE || 'E'
        );
        fields = fields.map(field => {
          const label = field.dataElement ? texts.get(field.dataElement.toUpperCase()) : undefined;
          return label ? { ...field, text: label } : field;
        });
      }
    }

    const contflag = header ? String(header.CONTFLAG || '').trim().toUpperCase() : '';
    const includes = expand ? flattened.includes : [];
    return this.answer({
      status: 'success',
      name,
      ...(tabclass ? { tableClass: TABLE_CLASSES[tabclass] || tabclass } : {}),
      ...(description ? { description } : {}),
      ...(contflag ? { deliveryClass: DELIVERY_CLASSES[contflag] || contflag } : {}),
      ...(header && String(header.MAINFLAG || '').trim() === 'X' ? { maintenanceAllowed: true } : {}),
      fieldCount: total,
      keyCount: flattened.fields.filter(field => field.key).length,
      // A table like EKPO is made of two dozen includes, and the list of them
      // would outweigh the fields a narrowed answer was asked for.
      ...(includes.length
        ? {
          includeCount: includes.length,
          includes: includes.slice(0, INCLUDES_LISTED),
          ...(includes.length > INCLUDES_LISTED
            ? { includesNotListed: includes.length - INCLUDES_LISTED }
            : {})
        }
        : {}),
      // Only with the includes expanded is an unread one a gap; unexpanded,
      // the markers are the answer that was asked for.
      ...(expand && flattened.missing.length
        ? {
          includesNotRead: flattened.missing,
          includesHint: 'These structures answered no fields: an append or an include of a type this reader does not follow. Their fields are missing from the list.'
        }
        : {}),
      ...(expand
        ? {}
        : {
          expanded: false,
          includeMarkers: includesOf(byStructure.get(name) || [])
        }),
      fields,
      ...(selected !== total ? { fieldsSelected: selected } : {}),
      ...(fields.length < selected
        ? {
          truncated: true,
          hint: `The first ${maxFields} of ${selected} fields are here. Narrow with fields or keysOnly, or raise maxFields.`
        }
        : {})
    });
  }

  async handleTableIndexes(args: any): Promise<any> {
    const name = this.name(args);
    const [indexes, indexFields] = await Promise.all([
      this.rows(indexesQuery(name), `the indexes of ${name}`, 200),
      this.rows(indexFieldsQuery(name), `the index fields of ${name}`, 1000)
    ]);

    const shaped = shapeIndexes(indexes, indexFields);
    return this.answer({
      status: 'success',
      name,
      indexCount: shaped.length,
      indexes: shaped,
      ...(shaped.length === 0
        ? { hint: `${name} has no secondary index of its own. The primary key is always indexed; tableFields shows which fields it is.` }
        : {})
    });
  }

  async handleTableKeys(args: any): Promise<any> {
    const name = this.name(args);
    const [keys, keyFields] = await Promise.all([
      this.rows(foreignKeysQuery(name), `the foreign keys of ${name}`, 500),
      this.rows(foreignKeyFieldsQuery(name), `the foreign key fields of ${name}`, 1000)
    ]);

    const shaped = shapeForeignKeys(keys, keyFields);
    return this.answer({
      status: 'success',
      name,
      keyCount: shaped.length,
      foreignKeys: shaped,
      ...(shaped.length === 0
        ? { hint: `${name} declares no foreign key. A field can still have a check table without one - tableFields reports that as checkTable.` }
        : {})
    });
  }
}

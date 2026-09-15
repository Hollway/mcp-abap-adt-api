/**
 * ATC check variants, confirmed before a worklist is opened on one.
 *
 * atcCheckVariant posts to /sap/bc/adt/atc/worklists?checkVariant=NAME, and
 * the backend answers with a worklist id whatever the name is - measured, a
 * variant invented on the spot got an id, and so did the empty string. Worse,
 * each call answers with a different id, so the answer cannot even be read as
 * an identity. The run started on such a worklist then fails with a bare 500,
 * several calls later, and nothing connects that to the name.
 *
 * Code Inspector holds the variants in SCICHKV_HD - CIUSER empty for the
 * global ones - which is a plain read, so the name can be checked first.
 */

export interface VariantRow {
  CHECKVNAME?: string;
  CIUSER?: string;
}

/** ATC names are upper case letters, digits, underscore and the namespace slash. */
export function isVariantNameSafe(name: string): boolean {
  return /^[A-Z0-9_/][A-Z0-9_/]{0,29}$/.test(String(name ?? '').toUpperCase());
}

export function variantQuery(): string {
  return 'SELECT ciuser, checkvname FROM scichkv_hd';
}

export function variantNames(result: any): { name: string; global: boolean }[] {
  const values = result?.values ?? result?.result?.values ?? [];
  return (Array.isArray(values) ? values : [])
    .map((row: VariantRow) => ({
      name: String(row?.CHECKVNAME ?? '').trim(),
      global: !String(row?.CIUSER ?? '').trim()
    }))
    .filter(v => v.name);
}

export interface VariantVerdict {
  checked: boolean;
  exists?: boolean;
  /** Global variants only, and only a handful - enough to point the caller somewhere. */
  examples?: string[];
}

export function judgeVariant(name: string, rows: { name: string; global: boolean }[]): VariantVerdict {
  const wanted = String(name ?? '').toUpperCase();
  if (!rows.length) return { checked: false };
  return {
    checked: true,
    exists: rows.some(r => r.name.toUpperCase() === wanted),
    examples: [...new Set(rows.filter(r => r.global).map(r => r.name))].slice(0, 8)
  };
}

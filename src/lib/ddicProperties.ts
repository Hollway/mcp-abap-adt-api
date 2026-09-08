/**
 * Building the property documents of DDIC domains and data elements.
 *
 * Both are written with a PUT that carries the WHOLE definition: the type, the
 * output format, the fixed values, all four field labels. Sending only the one
 * field a caller wants to change would blank everything else, so a change is
 * expressed here as a patch merged onto what the system currently holds, and
 * the merge is a pure function so it can be tested without a system.
 */
// These four are exported from the library's api module but not re-exported
// from its root index, so the import reaches one level in. Types only: nothing
// of the library's runtime is pulled in by this path.
import type {
  DataElementMetaData,
  DataElementProperties,
  DomainMetaData,
  DomainProperties
} from 'abap-adt-api/build/api/objectcontents';

export const DOMAIN_BASE = '/sap/bc/adt/ddic/domains';
export const DATA_ELEMENT_BASE = '/sap/bc/adt/ddic/dataelements';

/** ADT object URL of a domain or data element, from its name. */
export const ddicUrl = (base: string, name: string): string =>
  `${base}/${encodeURIComponent(String(name).trim().toLowerCase())}`;

export const domainUrl = (name: string): string => ddicUrl(DOMAIN_BASE, name);
export const dataElementUrl = (name: string): string => ddicUrl(DATA_ELEMENT_BASE, name);

/** The name a domain or data element URL points at. */
export const ddicNameOf = (url: string): string =>
  decodeURIComponent(url.split('#')[0].replace(/\/+$/, '').split('/').pop() || '').toUpperCase();

export interface DomainState {
  metaData: DomainMetaData;
  properties: DomainProperties;
}

export interface DataElementState {
  metaData: DataElementMetaData;
  properties: DataElementProperties;
}

export interface DomainFixValuePatch {
  low: string;
  high?: string;
  text?: string;
}

/** What a caller may change about a domain. Everything is optional. */
export interface DomainPatch {
  description?: string;
  datatype?: string;
  length?: number;
  decimals?: number;
  outputLength?: number;
  style?: string;
  conversionExit?: string;
  signExists?: boolean;
  lowercase?: boolean;
  ampmFormat?: boolean;
  valueTable?: string;
  fixValues?: DomainFixValuePatch[];
}

/** What a caller may change about a data element. Everything is optional. */
export interface DataElementPatch {
  description?: string;
  /** Domain this element takes its type from; sets typeKind to "domain". */
  domain?: string;
  /** Built-in ABAP type, for an element with no domain. */
  dataType?: string;
  length?: number;
  decimals?: number;
  /** Fills all four labels at once, each cut to the length SAP allows. */
  label?: string;
  shortLabel?: string;
  mediumLabel?: string;
  longLabel?: string;
  headingLabel?: string;
  searchHelp?: string;
  searchHelpParameter?: string;
  setGetParameter?: string;
  defaultComponentName?: string;
  deactivateInputHistory?: boolean;
  changeDocument?: boolean;
  leftToRightDirection?: boolean;
  deactivateBIDIFiltering?: boolean;
}

/** SAP's own ceilings for the four field labels. */
export const LABEL_LIMITS = {
  short: 10,
  medium: 20,
  long: 40,
  heading: 55
} as const;

const pick = <T>(patched: T | undefined, current: T): T =>
  patched === undefined ? current : patched;

/** A domain document with the patch applied over the current definition. */
export function mergeDomain(current: DomainState, patch: DomainPatch): DomainState {
  const type = current.properties.typeInformation || { datatype: '', length: 0, decimals: 0 };
  const output = current.properties.outputInformation || {
    length: 0,
    signExists: false,
    lowercase: false,
    ampmFormat: false
  };
  const values = current.properties.valueInformation;

  const touchesValues = patch.valueTable !== undefined || patch.fixValues !== undefined;

  return {
    metaData: {
      ...current.metaData,
      description: pick(patch.description, current.metaData.description)
    },
    properties: {
      typeInformation: {
        datatype: pick(patch.datatype, type.datatype).toUpperCase(),
        length: pick(patch.length, type.length),
        decimals: pick(patch.decimals, type.decimals)
      },
      outputInformation: {
        // ADT shows an output length of 0 as "same as the type length", which
        // is what a caller who says nothing about it means.
        length: pick(patch.outputLength, output.length || pick(patch.length, type.length)),
        style: pick(patch.style, output.style),
        conversionExit: pick(patch.conversionExit, output.conversionExit),
        signExists: pick(patch.signExists, output.signExists),
        lowercase: pick(patch.lowercase, output.lowercase),
        ampmFormat: pick(patch.ampmFormat, output.ampmFormat)
      },
      valueInformation: touchesValues
        ? {
          valueTableRef: pick(patch.valueTable, values?.valueTableRef || ''),
          appendExists: values?.appendExists || false,
          fixValues: pick(patch.fixValues, values?.fixValues)
        }
        : values
    }
  };
}

export interface LabelTruncation {
  label: 'short' | 'medium' | 'long' | 'heading';
  limit: number;
  written: string;
}

export interface DataElementMergeResult {
  state: DataElementState;
  /** Labels cut to fit, so the answer can say so instead of hiding it. */
  truncated: LabelTruncation[];
}

const fit = (
  value: string,
  which: LabelTruncation['label'],
  truncated: LabelTruncation[]
): string => {
  const limit = LABEL_LIMITS[which];
  if (value.length <= limit) return value;
  // A label cut mid-word should not end in a space - SAP stores it verbatim.
  const written = value.slice(0, limit).replace(/ +$/, '');
  truncated.push({ label: which, limit, written });
  return written;
};

/**
 * A data element document with the patch applied over the current definition.
 *
 * The type is one choice or the other: naming a domain makes the element take
 * its type from that domain (typeKind "domain" in the document), naming a
 * built-in type makes it a predefined one and clears the domain. Passing both
 * is a contradiction the caller has to resolve, so it is rejected before this
 * point rather than silently resolved here.
 */
export function mergeDataElement(
  current: DataElementState,
  patch: DataElementPatch
): DataElementMergeResult {
  const labels = current.properties.fieldLabels || {
    shortFieldLabel: '',
    mediumFieldLabel: '',
    longFieldLabel: '',
    headingFieldLabel: ''
  };
  const truncated: LabelTruncation[] = [];

  const byDomain = patch.domain !== undefined;
  const byType = patch.dataType !== undefined;

  const label = (
    which: LabelTruncation['label'],
    specific: string | undefined,
    currentValue: string
  ): string => {
    const value = specific !== undefined ? specific : patch.label;
    if (value === undefined) return currentValue;
    return fit(value, which, truncated);
  };

  return {
    truncated,
    state: {
      metaData: {
        ...current.metaData,
        description: pick(patch.description, current.metaData.description)
      },
      properties: {
        typeName: byDomain
          ? String(patch.domain).toUpperCase()
          : byType
            ? ''
            : current.properties.typeName,
        dataType: byType
          ? String(patch.dataType).toUpperCase()
          : byDomain
            ? ''
            : current.properties.dataType,
        dataTypeLength: byType
          ? (patch.length ?? 0)
          : byDomain
            ? 0
            : pick(patch.length, current.properties.dataTypeLength),
        dataTypeDecimals: byType
          ? (patch.decimals ?? 0)
          : byDomain
            ? 0
            : pick(patch.decimals, current.properties.dataTypeDecimals),
        fieldLabels: {
          ...labels,
          shortFieldLabel: label('short', patch.shortLabel, labels.shortFieldLabel),
          mediumFieldLabel: label('medium', patch.mediumLabel, labels.mediumFieldLabel),
          longFieldLabel: label('long', patch.longLabel, labels.longFieldLabel),
          headingFieldLabel: label('heading', patch.headingLabel, labels.headingFieldLabel)
        },
        searchHelp: pick(patch.searchHelp, current.properties.searchHelp),
        searchHelpParameter: pick(patch.searchHelpParameter, current.properties.searchHelpParameter),
        setGetParameter: pick(patch.setGetParameter, current.properties.setGetParameter),
        defaultComponentName: pick(patch.defaultComponentName, current.properties.defaultComponentName),
        deactivateInputHistory: pick(patch.deactivateInputHistory, current.properties.deactivateInputHistory),
        changeDocument: pick(patch.changeDocument, current.properties.changeDocument),
        leftToRightDirection: pick(patch.leftToRightDirection, current.properties.leftToRightDirection),
        deactivateBIDIFiltering: pick(patch.deactivateBIDIFiltering, current.properties.deactivateBIDIFiltering)
      }
    }
  };
}

/** Domain and built-in type are alternatives; say so before anything is sent. */
export const typeChoiceError = (patch: DataElementPatch): string | undefined => {
  if (patch.domain !== undefined && patch.dataType !== undefined) {
    return 'A data element takes its type either from a domain or from a built-in ABAP type. ' +
      'Pass domain, or dataType with length (and decimals) - not both.';
  }
  return undefined;
};

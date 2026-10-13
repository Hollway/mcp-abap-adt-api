/**
 * A package created through CL_PACKAGE_FACTORY, for the releases that serve no
 * /sap/bc/adt/packages.
 *
 * On the ERP system these tools were written against, only
 * /sap/bc/adt/packages/settings is served: the creation, the name validation
 * and even reading a package answer 404. The workbench API SE21 itself uses
 * does the job, in three calls measured there:
 *
 *   create_new_package    the package object, locked and changeable
 *   save                  writes TDEVC/TDEVCT and records R3TR DEVC in the
 *                         caller's own task of the request it is given
 *   set_changeable false  releases the lock - also after a failed save, or the
 *                         half-made package stays locked to this user
 *
 * Software component and transport layer are fixed rather than asked for: HOME
 * and Z* for a transportable package, LOCAL and none for a $ package - the
 * user's decision, so a package never ends up in a layer nobody uses.
 */
import { charLiteral } from './textPool';
import {
  DDIF_DECLARATIONS,
  ddifLanguageLines,
  infoLine,
  isLocalPackage,
  packageName,
  stepLines,
  textLiteral
} from './ddifWrite';
import type { StepSpec } from './ddifWrite';

export const TRANSPORTABLE_COMPONENT = 'HOME';
export const TRANSPORTABLE_LAYER = 'Z*';
export const LOCAL_COMPONENT = 'LOCAL';

/** TDEVCT-CTEXT is CHAR 60. */
const DESCRIPTION_LENGTH = 60;

export interface PackageDdifSpec {
  name: string;
  description: string;
  /** The package it goes under; empty for a top-level package. */
  superPackage?: string;
  /** The request, already resolved from a task. Omitted for a $ package. */
  request?: string;
  language?: string;
}

export interface PackageSnippet {
  code: string[];
  exceptions: Record<string, string[]>;
  softwareComponent: string;
  transportLayer?: string;
}

/** The ABAP that creates, saves and releases the package. */
export function packageDdifSnippet(spec: PackageDdifSpec): PackageSnippet {
  const name = packageName(spec.name);
  const local = isLocalPackage(name);
  const parent = spec.superPackage ? packageName(spec.superPackage) : '';
  const softwareComponent = local ? LOCAL_COMPONENT : TRANSPORTABLE_COMPONENT;
  const transportLayer = local ? undefined : TRANSPORTABLE_LAYER;

  const create: StepSpec = {
    step: 'create',
    call: [
      'CALL METHOD cl_package_factory=>create_new_package',
      '  EXPORTING i_reuse_deleted_object = abap_true',
      '            i_suppress_dialog      = abap_true',
      '  IMPORTING e_package              = lo_package',
      '  CHANGING  c_package_data         = ls_package'
    ]
  };
  const save: StepSpec = {
    step: 'save',
    call: [
      'CALL METHOD lo_package->save',
      '  EXPORTING ' + (spec.request && !local ? `i_transport_request = ${charLiteral(spec.request)} ` : '') +
        'i_suppress_dialog = abap_true',
      '  IMPORTING e_transport_request = lv_korrnum'
    ],
    // The lock has to come off whatever save did.
    continueOnFailure: true
  };
  const release: StepSpec = {
    step: 'unlock',
    call: [
      'CALL METHOD lo_package->set_changeable',
      '  EXPORTING i_changeable = abap_false i_suppress_dialog = abap_true'
    ],
    continueOnFailure: true
  };

  return {
    code: [
      ...DDIF_DECLARATIONS,
      'DATA ls_package TYPE scompkdtln.',
      'DATA lo_package TYPE REF TO if_package.',
      ...ddifLanguageLines(spec.language),
      `ls_package-devclass = ${charLiteral(name)}.`,
      `ls_package-ctext = ${textLiteral(spec.description, 'description', DESCRIPTION_LENGTH)}.`,
      'ls_package-as4user = sy-uname.',
      'ls_package-masterlang = lv_langu.',
      'ls_package-language = lv_langu.',
      `ls_package-dlvunit = ${charLiteral(softwareComponent)}.`,
      ...(transportLayer ? [`ls_package-pdevclass = ${charLiteral(transportLayer)}.`] : []),
      `ls_package-korrflag = ${local ? 'abap_false' : 'abap_true'}.`,
      ...(parent ? [`ls_package-parentcl = ${charLiteral(parent)}.`] : []),
      ...stepLines(create),
      ...stepLines(save),
      infoLine('task', 'lv_korrnum'),
      ...stepLines(release)
    ],
    exceptions: {},
    softwareComponent,
    ...(transportLayer ? { transportLayer } : {})
  };
}

/** What TDEVC holds for the package afterwards, as the proof. */
export const packageRowSql = (name: string): string =>
  `SELECT devclass, parentcl, pdevclass, dlvunit, as4user FROM tdevc WHERE devclass = '${packageName(name)}'`;

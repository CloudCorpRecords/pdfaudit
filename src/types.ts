/**
 * pdfaudit types.
 *
 * pdfaudit audits one local PDF against the machine-checkable
 * basics of PDF/UA accessibility and reports:
 *
 *   - one entry per check: its pinned id and name, whether it
 *     passed, and a detail string explaining the outcome
 *   - how many checks failed
 *   - a remediation route chosen from the audit outcome
 *   - a one-line verdict summarising all of the above
 *
 * The audit reads the file from disk but never uploads it and
 * never touches the network.
 */

/** The remediation route chosen for an audited document. */
export type AuditRoute =
  | "already-compliant"
  | "ocr"
  | "guaranteed"
  | "repair";

/** One accessibility check's outcome. Keys in pinned order. */
export interface AuditCheck {
  /** Pinned check id, e.g. "tagged". */
  id: string;
  /** Human-readable check name, e.g. "Document is tagged". */
  name: string;
  /** Whether the document passed this check. */
  passed: boolean;
  /** Pinned detail string explaining the outcome. */
  detail: string;
}

/** The full accessibility audit report. Keys in pinned order. */
export interface AuditReport {
  /** The audited file's path, echoed from the input. */
  filePath: string;
  /** The seven checks, in pinned order. */
  checks: AuditCheck[];
  /** Number of checks with `passed: false`. */
  failed: number;
  /** The remediation route for this document. */
  route: AuditRoute;
  /** One-line verdict: pass count, route, and failed ids. */
  verdict: string;
}

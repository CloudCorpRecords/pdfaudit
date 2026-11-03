#!/usr/bin/env node
/**
 * pdfaudit CLI.
 *
 *   pdfaudit check_pdf_accessibility '<json>'
 *   pdfaudit mcp
 *   pdfaudit --version
 *
 * The JSON argument is the tool's full arguments object:
 * {"file_path": "/path/to/document.pdf"}. The audit is
 * pure local file processing: the document is read from
 * disk, never uploaded, and no network is touched.
 * Exit codes: 0 success, 1 runtime error (including an
 * unparseable JSON argument, a missing file, or a file
 * that is not an auditable PDF), 2 usage error.
 */
import { checkPdfAccessibility, formatReport, VERSION } from "./audit.js";

function usage(): never {
  console.error(`Usage:
  pdfaudit check_pdf_accessibility '<json>'
  pdfaudit mcp
  pdfaudit --version`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    await import("./mcp.js");
    return;
  }
  if (cmd !== "check_pdf_accessibility") usage();

  const [jsonArg] = rest;
  if (jsonArg === undefined) usage();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonArg);
  } catch (err) {
    console.error(
      `error: cannot parse JSON argument: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  try {
    const report = await checkPdfAccessibility(parsed);
    console.log(formatReport(report));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();

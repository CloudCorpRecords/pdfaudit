# pdfaudit — Build Report

MCP Rebuild 1000, Batch 20. Rebuild of Thrain Spotlight MCP
(npm `@thrain/spotlight-mcp`), built from the firsthand spec
in `~/workspace/mcp-rebuild-100/specs-batch20/pdfaudit.md`
(read first), with the shared minimal PDF object-scan model
from `specs-batch20/redactpdf.md` §"PDF engine scope" and
`builds/pdfport/src/` read as a read-only pattern reference
(all code written fresh). Local build only — nothing pushed
or published.

Identity: repo `pdfaudit`, npm `@reneturcios/pdfaudit`,
MCP name `io.github.CloudCorpRecords/pdfaudit`, version
`0.1.0`, bin `pdfaudit` → `dist/cli.js`.

## Files created (19/19 per TEMPLATE.md checklist)

- `package.json`, `server.json` (description "Audit a local
  PDF against the machine-checkable basics of PDF/UA
  accessibility. No uploads." — 91 chars, verified by count;
  npm entry carries `version: 0.1.0`; OCI entry
  `ghcr.io/cloudcorprecords/pdfaudit:0.1.0` carries **no**
  `version` field), `Dockerfile` (node:20-alpine two-stage,
  label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/pdfaudit"`),
  `tsconfig.json` (byte-identical to
  `builds/codescout/tsconfig.json`, diff-verified),
  `.gitignore`, `LICENSE` (MIT, Copyright (c) 2026 Rene
  Turcios), `README.md` (fresh prose), `CHANGELOG.md`
  (single 0.1.0 entry, 2026-10-27), `package-lock.json`
  (Route 3, see below)
- `src/index.ts`, `src/cli.ts`
  (`check_pdf_accessibility '<json>'` where the argument is
  the tool's full JSON arguments object, `mcp`, `--version`;
  exit 2 usage / 1 runtime error), `src/mcp.ts`,
  `src/types.ts`, `src/audit.ts` (core, `VERSION = "0.1.0"`)
- `test/audit.test.ts`
- `.github/workflows/{ci,publish,publish-container,registry-publish}.yml`
  (adapted from `builds/codescout`; publish-container
  `IMAGE = ghcr.io/cloudcorprecords/pdfaudit`, smoke-test
  server-name assertion `pdfaudit`)

Plus the parity fixture at
`harness/fixtures/spotlight-mcp-tools-original.json`,
labelled with its coordinator-read registry source.

## Tool implemented (1)

- `check_pdf_accessibility` — description exactly "Audit a
  local PDF against the machine-checkable basics of PDF/UA
  accessibility and return a JSON report. The document is
  never uploaded."; argument `file_path` (string, required).

  The core (`src/audit.ts`) runs a minimal PDF object scan
  (Node built-ins only): `%PDF-` header check, plain object
  blocks, catalog, info dictionary (via the trailer `/Info`
  reference, falling back to the object carrying `/Title`),
  `/MarkInfo` (inline or by reference), `/StructTreeRoot`,
  `/StructElem` objects, image XObjects (`/Subtype /Image`),
  the `/Encrypt` dictionary (reference or inline trailer
  dictionary) and its `/P` bits, and Tj/TJ text extraction
  (literal strings with escapes and octal, hex strings,
  FlateDecode streams inflated) for the route decision.

  The 7 checks run with the spec's pinned ids, names, rules
  and detail strings: `tagged`, `structure_tree`,
  `document_language`, `title_exposed`, `image_alt_text`,
  `reading_order`, `access_locks`. The report carries keys
  in the pinned order `filePath`, `checks`, `failed`,
  `route`, `verdict`; check entries carry `id`, `name`,
  `passed`, `detail` in that order. `route` is
  `already-compliant` iff `failed == 0`, else `ocr` iff no
  extractable text but at least one image exists, else
  `guaranteed` iff untagged with extractable text, else
  `repair`. The verdict follows the pinned template
  (`<passed>/7 checks passed. Route: <route>.` plus
  ` Failed: <ids>.` when any check failed).

  `src/mcp.ts` uses the SDK's low-level `Server`
  (`sdk/server/index.js` + `StdioServerTransport`) with an
  explicit JSON-schema literal — no McpServer/zod
  registration — and returns the report as a single text
  item, pretty-printed with a 2-space indent. Parse and
  file errors surface as `isError` with the pinned wording
  (`file not found: <path>` / `not a PDF file: <path>` /
  `unsupported PDF structure: <path>`); encrypted PDFs are
  still audited because encryption is itself a check.

## Verification (foreground, this session)

- `npm test` (`tsx --test test/*.test.ts`): **32 tests, 32
  pass, 0 fail** — Tj/TJ extraction (literal, TJ array,
  hex, escapes/octal); a fully compliant hand-built PDF
  passing all 7 checks with every pinned pass detail;
  report and check-entry key order; MarkInfo by reference;
  a FlateDecode content stream; Marked-false, missing
  StructTreeRoot, tree-without-elements, empty Lang,
  hex-string Title, and empty Title failures with pinned
  details; all four image-alt-text branches (no reference,
  all-with-alt, 1-of-1 lacking, 1-of-2 lacking); access
  locks (unencrypted via the compliant baseline, /P 516
  permits, /P 4 locked, missing /P locked, inline trailer
  Encrypt permits); all four routes with exact verdict
  strings (already-compliant, ocr for a scanned document,
  guaranteed for untagged digital text via Tj and via TJ,
  repair for a partially tagged document); and the error
  paths (file not found, not a PDF, header-only unsupported,
  no-catalog unsupported, missing / non-string / empty
  `file_path`).
- `npx tsc --noEmit` → exit 0; `npm run build` produced
  `dist/` with all 15 outputs.
- `dist/cli.js --version` → `0.1.0`; unknown command exits
  2 with usage; `check_pdf_accessibility '<json>'` on a
  hand-built compliant PDF exits 0 and prints the report
  (`7/7 checks passed. Route: already-compliant.`); the
  same command on a missing path exits 1 with
  `error: file not found: /nope/x.pdf`.
- Parity: `harness/parity.py` vs
  `harness/fixtures/spotlight-mcp-tools-original.json` →
  **PASS, parity 100.0, identical_tools 1/1**. Report saved
  under `parity-out/`.

## Lockfile status

`package-lock.json` generated via Route 3 only (temp dir
holding `package.json` alone, `npm install
--package-lock-only --ignore-scripts --offline`), verified:
parses, name `@reneturcios/pdfaudit`, **128 package
entries**. Dependencies were then installed in the build
dir with `npm install --ignore-scripts --offline` against
that lockfile; no fallback symlink was needed.

## Gaps / honest notes

- Check ids/names and the reading-order + alt-text rules
  are pinned reconstructions of the original README's
  seven topic list; the original's internal check
  implementations are not published in the npm record
  (spec gap, recorded in the spec itself).
- Image alt text uses a simplification: a structure
  element "references an image" iff its raw dictionary
  text contains the `/Image` token, and it "carries alt
  text" iff it contains an `/Alt` entry. Real content-reference
  indirection (OBJR/MCR chains) is outside the minimal
  object-scan model.
- XMP metadata title is not consulted — the info
  dictionary `/Title` only — recorded as a limitation in
  the spec and the README.
- Encrypted PDFs: the audit runs on the raw object scan
  even when streams are encrypted (their text simply does
  not extract), because encryption is one of the checks;
  only an unparseable file (no header / no object blocks /
  no catalog) is an error.
- Container build not exercised locally; the
  publish-container workflow smoke-tests the image at
  publish time.
- Nothing pushed or published; this is a local build only.

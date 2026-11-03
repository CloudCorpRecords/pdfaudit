# pdfaudit

Some PDFs look fine on screen and are unusable with a screen
reader: the text is there, but nothing says what order to read
it in, images carry no descriptions, and the file may even be
locked against the extraction assistive technology depends on.
pdfaudit checks a local PDF against the machine-checkable
basics of PDF/UA accessibility and reports exactly what it
found, in a JSON report a caller can act on. The document is
never uploaded — the audit reads the file from disk, runs
entirely locally, and touches no network.

Seven checks run on every document. The document must be
tagged (a `/MarkInfo` dictionary with `/Marked true` in the
catalog) and must carry a structure tree (`/StructTreeRoot`).
Its language must be set (a non-empty `/Lang` entry) and its
title exposed (a non-empty `/Title` in the information
dictionary; XMP metadata is not consulted). Every image must
be reachable from a structure element that carries alt text.
The reading order must be determinable, which requires the
structure tree and at least one structure element. And the
document must not be locked against assistive access: an
unencrypted document passes, while an encrypted one passes
only when its permission bits allow extraction in support of
accessibility.

Each check reports a pinned id, a name, a pass or fail, and a
detail string. The report counts the failures and picks a
route for what to do next: `already-compliant` when nothing
failed, `ocr` for a scanned document (no extractable text but
at least one image), `guaranteed` for an untagged digital PDF
that does carry extractable text, and `repair` for everything
else — partially tagged or mixed documents that need targeted
fixes. A one-line verdict summarises the pass count, the
route, and the ids of any failed checks.

The audit works on a deliberately small reading of the PDF:
plain object blocks are scanned for the catalog, the
information dictionary, structure elements, image objects,
and the encryption dictionary, and text is recovered from
the `Tj` and `TJ` operators to inform the route decision.
Files that cannot be read this way are reported honestly —
a missing file, a file with no PDF header, and a file with
no usable object structure each produce their own error
rather than a misleading report.

## CLI

```bash
npx @reneturcios/pdfaudit check_pdf_accessibility '{"file_path": "/path/to/document.pdf"}'
npx @reneturcios/pdfaudit --version
```

The report is printed as JSON:

```json
{
  "filePath": "/path/to/document.pdf",
  "checks": [
    {
      "id": "tagged",
      "name": "Document is tagged",
      "passed": true,
      "detail": "MarkInfo/Marked is true"
    }
  ],
  "failed": 0,
  "route": "already-compliant",
  "verdict": "7/7 checks passed. Route: already-compliant."
}
```

(The example above abbreviates the `checks` list; a real
report always carries all seven entries.)

Exit codes: `0` on success, `1` on a runtime error
(including an unparseable JSON argument, a missing file,
or a file that is not an auditable PDF), `2` on a usage
error.

## MCP server

```bash
npx -y @reneturcios/pdfaudit mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "pdfaudit": {
      "command": "npx",
      "args": ["-y", "@reneturcios/pdfaudit", "mcp"]
    }
  }
}
```

### Tools

- `check_pdf_accessibility` — Audit a local PDF against the
  machine-checkable basics of PDF/UA accessibility and
  return a JSON report. The document is never uploaded.
  - `file_path` (string, required) — path to a local PDF

  Returns a single text item carrying the JSON report,
  pretty-printed with a 2-space indent, with keys in the
  order `filePath`, `checks`, `failed`, `route`, `verdict`.
  Each entry in `checks` carries `id`, `name`, `passed`,
  and `detail` in that order.

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/pdfaudit
docker run --rm -v "$PWD:/w" ghcr.io/cloudcorprecords/pdfaudit check_pdf_accessibility '{"file_path": "/w/document.pdf"}'
```

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # tsx --test test/*.test.ts (pure local, no network)
npm run dev     # run the CLI from source
```

## License

MIT — Copyright (c) 2026 Rene Turcios

# Changelog

## 0.1.0 (2026-10-27)

- Initial release: `check_pdf_accessibility` MCP tool and
  `check_pdf_accessibility '<json>'` CLI command auditing
  a local PDF against the machine-checkable basics of
  PDF/UA accessibility. The document is never uploaded;
  all processing is local.
- Seven checks with pinned ids and detail strings:
  `tagged`, `structure_tree`, `document_language`,
  `title_exposed`, `image_alt_text`, `reading_order`, and
  `access_locks`. The JSON report carries `filePath`,
  `checks`, `failed`, `route`, and `verdict` in that
  order.
- Pinned route decision: `already-compliant` when no
  check fails, `ocr` for a scanned document (no
  extractable text but at least one image), `guaranteed`
  for an untagged digital PDF with extractable text, and
  `repair` otherwise. The verdict summarises the pass
  count, the route, and the failed check ids.

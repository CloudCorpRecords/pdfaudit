/**
 * pdfaudit core: audit a local PDF against the machine-checkable
 * basics of PDF/UA accessibility.
 *
 *   checkPdfAccessibility(args) -> AuditReport
 *
 * The PDF model is a minimal object scan over the raw bytes
 * (Node built-ins only, PDF bytes treated as latin1 text so one
 * character is one byte):
 *
 *   - a `%PDF-` header is required, and at least one plain
 *     `N G obj ... endobj` block must be present, with a
 *     `/Type /Catalog` object among them — otherwise the file
 *     is reported as `not a PDF file: <path>` or
 *     `unsupported PDF structure: <path>`, and a missing file
 *     as `file not found: <path>`. Encrypted PDFs are still
 *     audited: encryption is itself one of the checks.
 *   - the catalog dictionary supplies the tagging flag
 *     (`/MarkInfo` with `/Marked true`, inline or by
 *     reference), `/StructTreeRoot`, and `/Lang`; the info
 *     dictionary (located through the trailer's `/Info`
 *     reference, or by its `/Title` entry) supplies `/Title`.
 *   - structure elements are objects whose dictionary carries
 *     `/Type /StructElem`; images are objects whose dictionary
 *     carries `/Subtype /Image`.
 *   - the encryption dictionary is located through the
 *     trailer's `/Encrypt` entry (a reference or an inline
 *     dictionary) and its `/P` permission integer is tested
 *     for bit 10 (value 512, "extract content in support of
 *     accessibility"). A missing `/P` fails the check.
 *   - text for the route decision is recovered from the
 *     string operands of the `Tj` and `TJ` operators across
 *     every decoded stream (FlateDecode streams are inflated
 *     with node:zlib, others are used raw); literal strings
 *     honour `\(` `\)` `\\` and octal escapes, hex strings
 *     are decoded byte-wise, all as latin1 characters. Only
 *     the total character count (`textChars`) is kept; it is
 *     internal and never appears in the report.
 *
 * The seven checks, the report shape, the route decision and
 * the verdict template are pinned by the build spec; see the
 * README for the full list.
 */
import { readFile, stat } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import type { AuditCheck, AuditReport, AuditRoute } from "./types.js";

export const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Minimal PDF object scan
// ---------------------------------------------------------------------------

interface PdfObject {
  num: number;
  /** Full inner body: dictionary plus "stream ... endstream" when present. */
  body: string;
  /** The dictionary portion (everything before "stream", or the whole body). */
  dict: string;
  /** Raw stream text (latin1) when the object carries a stream, else null. */
  stream: string | null;
}

function parseObjects(text: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const re = /(\d+)\s+(\d+)\s+obj(?![0-9])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = Number(m[1]);
    const bodyStart = re.lastIndex;
    const end = text.indexOf("endobj", bodyStart);
    if (end === -1) continue;
    const body = text
      .slice(bodyStart, end)
      .replace(/^\s+/, "")
      .replace(/\s+$/, "");
    let dict = body;
    let stream: string | null = null;
    const streamAt = body.indexOf("stream");
    if (streamAt !== -1) {
      dict = body.slice(0, streamAt);
      let dataStart = streamAt + "stream".length;
      if (body.startsWith("\r\n", dataStart)) dataStart += 2;
      else if (body[dataStart] === "\n" || body[dataStart] === "\r") dataStart += 1;
      const lengthMatch = /\/Length\s+(\d+)/.exec(dict);
      if (lengthMatch) {
        stream = body.slice(dataStart, dataStart + Number(lengthMatch[1]));
      } else {
        const streamEnd = body.lastIndexOf("endstream");
        let raw = body.slice(dataStart, streamEnd === -1 ? body.length : streamEnd);
        if (raw.endsWith("\r\n")) raw = raw.slice(0, -2);
        else if (raw.endsWith("\n") || raw.endsWith("\r")) raw = raw.slice(0, -1);
        stream = raw;
      }
    }
    objects.set(num, { num, body, dict, stream });
  }
  return objects;
}

function findCatalog(objects: Map<number, PdfObject>): PdfObject | undefined {
  for (const obj of objects.values()) {
    if (/\/Type\s*\/Catalog(?![A-Za-z0-9])/.test(obj.dict)) return obj;
  }
  return undefined;
}

function trailerRef(text: string, key: string): number | undefined {
  const re = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`, "g");
  let found: number | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found = Number(m[1]);
  return found;
}

/** The balanced `<< ... >>` dictionary starting at text[start], or null. */
function extractDictAt(text: string, start: number): string | null {
  if (!text.startsWith("<<", start)) return null;
  let depth = 0;
  let i = start;
  while (i < text.length) {
    if (text.startsWith("<<", i)) {
      depth += 1;
      i += 2;
      continue;
    }
    if (text.startsWith(">>", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return text.slice(start, i);
      continue;
    }
    i += 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// PDF literal / hex strings
// ---------------------------------------------------------------------------

/** Parse a literal string starting at text[start] === "(". */
export function parseLiteralString(
  text: string,
  start: number,
): { value: string; next: number } {
  let out = "";
  let depth = 1;
  let i = start + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "\\") {
      const nxt = text[i + 1] ?? "";
      if (nxt === "n") { out += "\n"; i += 2; continue; }
      if (nxt === "r") { out += "\r"; i += 2; continue; }
      if (nxt === "t") { out += "\t"; i += 2; continue; }
      if (nxt === "b") { out += "\b"; i += 2; continue; }
      if (nxt === "f") { out += "\f"; i += 2; continue; }
      if (nxt === "(" || nxt === ")" || nxt === "\\") { out += nxt; i += 2; continue; }
      if (nxt === "\n") { i += 2; continue; }
      if (nxt === "\r") { i += text[i + 2] === "\n" ? 3 : 2; continue; }
      if (nxt >= "0" && nxt <= "7") {
        let oct = "";
        let j = i + 1;
        while (j < text.length && oct.length < 3 && text[j] >= "0" && text[j] <= "7") {
          oct += text[j];
          j += 1;
        }
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        i = j;
        continue;
      }
      out += nxt;
      i += 2;
      continue;
    }
    if (ch === "(") { depth += 1; out += ch; i += 1; continue; }
    if (ch === ")") {
      depth -= 1;
      if (depth > 0) out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { value: out, next: i };
}

function parseHexString(text: string, start: number): { value: string; next: number } {
  const end = text.indexOf(">", start + 1);
  const stop = end === -1 ? text.length : end;
  let hex = text.slice(start + 1, stop).replace(/\s+/g, "");
  if (hex.length % 2 === 1) hex += "0";
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return { value: out, next: end === -1 ? text.length : end + 1 };
}

/**
 * Read a string-valued dictionary entry: after `/Key`, accept a
 * literal string, a hex string, or a name (`/en-US` reads as
 * `en-US`). Returns undefined when the key is absent or its value
 * is none of those forms.
 */
function dictStringValue(dict: string, key: string): string | undefined {
  const at = new RegExp(`/${key}(?![A-Za-z0-9])`).exec(dict);
  if (!at) return undefined;
  let i = at.index + at[0].length;
  while (i < dict.length && /\s/.test(dict[i])) i += 1;
  if (dict[i] === "(") return parseLiteralString(dict, i).value;
  if (dict[i] === "<" && dict[i + 1] !== "<") return parseHexString(dict, i).value;
  if (dict[i] === "/") {
    let j = i + 1;
    while (j < dict.length && !/[\s<>\[\]()/%]/.test(dict[j])) j += 1;
    return dict.slice(i + 1, j);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Content-stream text extraction (Tj / TJ string operands)
// ---------------------------------------------------------------------------

/** Recover the text shown by the Tj and TJ operators in one stream. */
export function extractTextFromContent(content: string): string {
  let out = "";
  let pendingString: string | null = null;
  let pendingArray: string | null = null;
  let i = 0;
  const isWs = (c: string) =>
    c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\0";
  const isDelimiter = (c: string) =>
    isWs(c) || c === "(" || c === ")" || c === "<" || c === ">" || c === "[" ||
    c === "]" || c === "{" || c === "}" || c === "/" || c === "%";
  while (i < content.length) {
    const ch = content[i];
    if (isWs(ch)) { i += 1; continue; }
    if (ch === "%") {
      while (i < content.length && content[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "(") {
      const parsed = parseLiteralString(content, i);
      pendingString = parsed.value;
      pendingArray = null;
      i = parsed.next;
      continue;
    }
    if (ch === "<") {
      if (content[i + 1] === "<") { i += 2; continue; }
      const parsed = parseHexString(content, i);
      pendingString = parsed.value;
      pendingArray = null;
      i = parsed.next;
      continue;
    }
    if (ch === ">") { i += content[i + 1] === ">" ? 2 : 1; continue; }
    if (ch === "[") {
      let joined = "";
      i += 1;
      while (i < content.length && content[i] !== "]") {
        const c = content[i];
        if (c === "(") {
          const parsed = parseLiteralString(content, i);
          joined += parsed.value;
          i = parsed.next;
          continue;
        }
        if (c === "<" && content[i + 1] !== "<") {
          const parsed = parseHexString(content, i);
          joined += parsed.value;
          i = parsed.next;
          continue;
        }
        i += 1;
      }
      i += 1; // consume "]"
      pendingArray = joined;
      pendingString = null;
      continue;
    }
    if (ch === "]" || ch === "{" || ch === "}") { i += 1; continue; }
    if (ch === "/") {
      i += 1;
      while (i < content.length && !isDelimiter(content[i])) i += 1;
      continue;
    }
    let j = i;
    while (j < content.length && !isDelimiter(content[j])) j += 1;
    const word = content.slice(i, j);
    i = j;
    if (word === "Tj") {
      if (pendingString !== null) {
        out += pendingString;
        pendingString = null;
      }
    } else if (word === "TJ") {
      if (pendingArray !== null) {
        out += pendingArray;
        pendingArray = null;
      }
    }
  }
  return out;
}

function decodeStreamText(obj: PdfObject): string | null {
  if (obj.stream === null) return null;
  if (/\/FlateDecode(?![A-Za-z0-9])/.test(obj.dict)) {
    try {
      return inflateSync(Buffer.from(obj.stream, "latin1")).toString("latin1");
    } catch {
      return obj.stream;
    }
  }
  return obj.stream;
}

// ---------------------------------------------------------------------------
// Individual check helpers
// ---------------------------------------------------------------------------

/** The dictionary a catalog entry points at: inline `<< >>` or by reference. */
function entryDictText(
  dict: string,
  key: string,
  objects: Map<number, PdfObject>,
): string | null {
  const at = new RegExp(`/${key}(?![A-Za-z0-9])`).exec(dict);
  if (!at) return null;
  let i = at.index + at[0].length;
  while (i < dict.length && /\s/.test(dict[i])) i += 1;
  if (dict.startsWith("<<", i)) return extractDictAt(dict, i);
  const ref = /^(\d+)\s+\d+\s+R/.exec(dict.slice(i));
  if (ref) {
    const target = objects.get(Number(ref[1]));
    return target ? target.dict : null;
  }
  return null;
}

function findInfoObject(
  text: string,
  objects: Map<number, PdfObject>,
): PdfObject | undefined {
  const infoNum = trailerRef(text, "Info");
  if (infoNum !== undefined && objects.has(infoNum)) return objects.get(infoNum);
  for (const obj of objects.values()) {
    if (/\/Title\s*[(<]/.test(obj.dict)) return obj;
  }
  return undefined;
}

interface EncryptFacts {
  present: boolean;
  /** The /P permission integer, or undefined when absent/unreadable. */
  p?: number;
}

function findEncrypt(text: string, objects: Map<number, PdfObject>): EncryptFacts {
  const refAt = /\/Encrypt\s+(\d+)\s+\d+\s+R/.exec(text);
  if (refAt) {
    const target = objects.get(Number(refAt[1]));
    if (target) {
      const p = /\/P\s+(-?\d+)/.exec(target.dict);
      return p ? { present: true, p: Number(p[1]) } : { present: true };
    }
    return { present: true };
  }
  const inlineAt = /\/Encrypt(?![A-Za-z0-9])/.exec(text);
  if (inlineAt) {
    let i = inlineAt.index + inlineAt[0].length;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    const inline = extractDictAt(text, i);
    if (inline !== null) {
      const p = /\/P\s+(-?\d+)/.exec(inline);
      return p ? { present: true, p: Number(p[1]) } : { present: true };
    }
    return { present: true };
  }
  return { present: false };
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/** Audit already-read PDF bytes. Throws the pinned parse errors. */
export function auditPdfBytes(filePath: string, data: Buffer): AuditReport {
  const text = data.toString("latin1");
  if (!text.slice(0, 1024).includes("%PDF-")) {
    throw new Error(`not a PDF file: ${filePath}`);
  }
  const objects = parseObjects(text);
  if (objects.size === 0) {
    throw new Error(`unsupported PDF structure: ${filePath}`);
  }
  const catalog = findCatalog(objects);
  if (!catalog) {
    throw new Error(`unsupported PDF structure: ${filePath}`);
  }

  // -- Check 1: tagged -------------------------------------------------------
  const markInfo = entryDictText(catalog.dict, "MarkInfo", objects);
  const tagged = markInfo !== null && /\/Marked\s+true(?![A-Za-z])/.test(markInfo);
  const checkTagged: AuditCheck = {
    id: "tagged",
    name: "Document is tagged",
    passed: tagged,
    detail: tagged
      ? "MarkInfo/Marked is true"
      : "no MarkInfo dictionary with Marked true",
  };

  // -- Check 2: structure tree ----------------------------------------------
  const hasStructTree = entryDictText(catalog.dict, "StructTreeRoot", objects) !== null;
  const checkStructure: AuditCheck = {
    id: "structure_tree",
    name: "Structure tree present",
    passed: hasStructTree,
    detail: hasStructTree
      ? "StructTreeRoot present"
      : "no StructTreeRoot in the document catalog",
  };

  // -- Check 3: document language --------------------------------------------
  const lang = dictStringValue(catalog.dict, "Lang");
  const hasLang = lang !== undefined && lang.length > 0;
  const checkLanguage: AuditCheck = {
    id: "document_language",
    name: "Document language set",
    passed: hasLang,
    detail: hasLang ? `Lang is "${lang}"` : "no Lang entry in the document catalog",
  };

  // -- Check 4: title exposed -------------------------------------------------
  const info = findInfoObject(text, objects);
  const title = info ? dictStringValue(info.dict, "Title") : undefined;
  const hasTitle = title !== undefined && title.length > 0;
  const checkTitle: AuditCheck = {
    id: "title_exposed",
    name: "Document title exposed",
    passed: hasTitle,
    detail: hasTitle
      ? `Title is "${title}"`
      : "no Title in the document information dictionary",
  };

  // -- Check 5: image alt text -------------------------------------------------
  const structElems = [...objects.values()].filter((obj) =>
    /\/Type\s*\/StructElem(?![A-Za-z0-9])/.test(obj.dict),
  );
  const imageCount = [...objects.values()].filter((obj) =>
    /\/Subtype\s*\/Image(?![A-Za-z0-9])/.test(obj.dict),
  ).length;
  const referencing = structElems.filter((obj) => /\/Image(?![A-Za-z0-9])/.test(obj.dict));
  const withAlt = referencing.filter((obj) => /\/Alt(?![A-Za-z0-9])/.test(obj.dict)).length;
  let checkAlt: AuditCheck;
  if (imageCount === 0) {
    checkAlt = {
      id: "image_alt_text",
      name: "Image alt text",
      passed: true,
      detail: "no images found",
    };
  } else if (referencing.length === 0) {
    checkAlt = {
      id: "image_alt_text",
      name: "Image alt text",
      passed: false,
      detail: "images present but no structure element references them",
    };
  } else if (withAlt === referencing.length) {
    checkAlt = {
      id: "image_alt_text",
      name: "Image alt text",
      passed: true,
      detail: `all ${referencing.length} image-referencing structure element(s) carry alt text`,
    };
  } else {
    checkAlt = {
      id: "image_alt_text",
      name: "Image alt text",
      passed: false,
      detail: `${referencing.length - withAlt} of ${referencing.length} image-referencing structure element(s) lack alt text`,
    };
  }

  // -- Check 6: reading order ---------------------------------------------------
  const hasOrder = hasStructTree && structElems.length > 0;
  const checkOrder: AuditCheck = {
    id: "reading_order",
    name: "Reading order determinable",
    passed: hasOrder,
    detail: hasOrder
      ? "structure elements define the reading order"
      : "no structure elements to define a reading order",
  };

  // -- Check 7: access locks -------------------------------------------------------
  const encrypt = findEncrypt(text, objects);
  let checkLocks: AuditCheck;
  if (!encrypt.present) {
    checkLocks = {
      id: "access_locks",
      name: "Not locked against assistive access",
      passed: true,
      detail: "document is not encrypted",
    };
  } else if (encrypt.p !== undefined && (encrypt.p & 512) !== 0) {
    checkLocks = {
      id: "access_locks",
      name: "Not locked against assistive access",
      passed: true,
      detail: "encryption permits accessibility extraction",
    };
  } else {
    checkLocks = {
      id: "access_locks",
      name: "Not locked against assistive access",
      passed: false,
      detail: "encryption does not permit accessibility extraction",
    };
  }

  const checks: AuditCheck[] = [
    checkTagged,
    checkStructure,
    checkLanguage,
    checkTitle,
    checkAlt,
    checkOrder,
    checkLocks,
  ];
  const failed = checks.filter((c) => !c.passed).length;
  const passedCount = checks.length - failed;

  // -- Route decision ---------------------------------------------------------------
  let textChars = 0;
  for (const obj of objects.values()) {
    const decoded = decodeStreamText(obj);
    if (decoded !== null) textChars += extractTextFromContent(decoded).length;
  }

  let route: AuditRoute;
  if (failed === 0) {
    route = "already-compliant";
  } else if (textChars === 0 && imageCount > 0) {
    route = "ocr";
  } else if (!tagged && textChars > 0) {
    route = "guaranteed";
  } else {
    route = "repair";
  }

  // -- Verdict -------------------------------------------------------------------------
  let verdict = `${passedCount}/7 checks passed. Route: ${route}.`;
  if (failed > 0) {
    const ids = checks.filter((c) => !c.passed).map((c) => c.id).join(", ");
    verdict += ` Failed: ${ids}.`;
  }

  return {
    filePath,
    checks,
    failed,
    route,
    verdict,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Audit the local PDF named by the arguments object `{file_path}`. */
export async function checkPdfAccessibility(args: unknown): Promise<AuditReport> {
  const raw: Record<string, unknown> = isRecord(args) ? args : {};
  if (raw.file_path === undefined) throw new Error("file_path is required");
  if (typeof raw.file_path !== "string" || raw.file_path.length === 0) {
    throw new Error("file_path must be a non-empty string");
  }
  const filePath = raw.file_path;

  let data: Buffer;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`file not found: ${filePath}`);
    data = await readFile(filePath);
  } catch (err) {
    if (err instanceof Error && err.message === `file not found: ${filePath}`) {
      throw err;
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`file not found: ${filePath}`);
    }
    throw err;
  }
  return auditPdfBytes(filePath, data);
}

/** Render a report as the JSON text block MCP clients show. */
export function formatReport(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}

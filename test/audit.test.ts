import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import {
  checkPdfAccessibility,
  extractTextFromContent,
} from "../src/audit.js";
import type { AuditReport } from "../src/types.js";

/**
 * All tests run on minimal PDFs hand-built in-test as plain
 * object blocks — the same shape the audit's object scan
 * reads. No network, no fixture files on disk beyond the
 * temp files written here. Every check's pass and fail
 * detail strings, all four routes, the verdict template,
 * the report key order, and the file / parse error wording
 * are each pinned.
 */

let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pdfaudit-test-"));
});

/** Assemble a minimal PDF from object bodies numbered 1..N. */
function buildPdf(bodies: string[], trailerExtra = ""): Buffer {
  let out = "%PDF-1.4\n";
  bodies.forEach((body, i) => {
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R${trailerExtra} >>\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function contentObj(shown: string): string {
  return `<< >>\nstream\nBT /F1 12 Tf ${shown} ET\nendstream`;
}

const PAGES = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
const PAGE = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>";
const ROOT = "<< /Type /StructTreeRoot /K [6 0 R] >>";
const ELEM = "<< /Type /StructElem /S /Document /P 5 0 R /Pg 3 0 R >>";
const INFO = "<< /Title (Annual Report) /Author (Tester) >>";
const IMAGE =
  "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 >>\nstream\n\nendstream";

/** Bodies of a fully compliant document; overrides replace by 1-based number. */
function compliantBodies(overrides: Record<number, string> = {}): string[] {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 5 0 R /Lang (en-US) >>",
    PAGES,
    PAGE,
    contentObj("(Hello accessible world) Tj"),
    ROOT,
    ELEM,
    INFO,
  ];
  for (const [num, body] of Object.entries(overrides)) {
    bodies[Number(num) - 1] = body;
  }
  return bodies;
}

async function audit(name: string, data: Buffer): Promise<AuditReport> {
  const file = path.join(dir, name);
  await writeFile(file, data);
  return checkPdfAccessibility({ file_path: file });
}

function check(report: AuditReport, id: string) {
  const found = report.checks.find((c) => c.id === id);
  assert.ok(found, `check ${id} present`);
  return found;
}

describe("extractTextFromContent — Tj/TJ extraction model", () => {
  it("extracts a literal string shown with Tj", () => {
    assert.equal(extractTextFromContent("BT (Hello) Tj ET"), "Hello");
  });

  it("extracts the strings of a TJ array, ignoring kerning numbers", () => {
    assert.equal(extractTextFromContent("[(A) 120 (B) -40 (C)] TJ"), "ABC");
  });

  it("extracts a hex string shown with Tj", () => {
    assert.equal(extractTextFromContent("<4869> Tj"), "Hi");
  });

  it("honours literal-string escapes including octal", () => {
    assert.equal(extractTextFromContent("(a\\(b\\) \\\\ \\101) Tj"), "a(b) \\ A");
  });
});

describe("checkPdfAccessibility — a fully compliant document", () => {
  it("passes all seven checks with the pinned pass details", async () => {
    const report = await audit("compliant.pdf", buildPdf(compliantBodies(), " /Info 7 0 R"));
    assert.deepEqual(
      report.checks.map((c) => [c.id, c.name, c.passed, c.detail]),
      [
        ["tagged", "Document is tagged", true, "MarkInfo/Marked is true"],
        ["structure_tree", "Structure tree present", true, "StructTreeRoot present"],
        ["document_language", "Document language set", true, 'Lang is "en-US"'],
        ["title_exposed", "Document title exposed", true, 'Title is "Annual Report"'],
        ["image_alt_text", "Image alt text", true, "no images found"],
        ["reading_order", "Reading order determinable", true, "structure elements define the reading order"],
        ["access_locks", "Not locked against assistive access", true, "document is not encrypted"],
      ],
    );
    assert.equal(report.failed, 0);
    assert.equal(report.route, "already-compliant");
    assert.equal(report.verdict, "7/7 checks passed. Route: already-compliant.");
  });

  it("report and check keys are in the pinned order", async () => {
    const report = await audit("order.pdf", buildPdf(compliantBodies(), " /Info 7 0 R"));
    assert.deepEqual(Object.keys(report), ["filePath", "checks", "failed", "route", "verdict"]);
    for (const c of report.checks) {
      assert.deepEqual(Object.keys(c), ["id", "name", "passed", "detail"]);
    }
    assert.equal(report.filePath, path.join(dir, "order.pdf"));
    assert.equal(report.checks.length, 7);
  });

  it("MarkInfo supplied by reference also counts as tagged", async () => {
    const bodies = compliantBodies({
      1: "<< /Type /Catalog /Pages 2 0 R /MarkInfo 8 0 R /StructTreeRoot 5 0 R /Lang (en-US) >>",
    });
    bodies.push("<< /Marked true /Suspects false >>");
    const report = await audit("markinfo-ref.pdf", buildPdf(bodies, " /Info 7 0 R"));
    assert.equal(check(report, "tagged").passed, true);
    assert.equal(report.failed, 0);
  });

  it("a FlateDecode content stream is inflated for the audit", async () => {
    const plain = "BT /F1 12 Tf (Flated text) Tj ET";
    const compressed = deflateSync(Buffer.from(plain, "latin1"));
    const bodies = compliantBodies({
      4: `<< /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n${compressed.toString("latin1")}\nendstream`,
    });
    const report = await audit("flated.pdf", buildPdf(bodies, " /Info 7 0 R"));
    assert.equal(report.failed, 0);
    assert.equal(report.route, "already-compliant");
  });
});

describe("checkPdfAccessibility — tagging, language, and title failures", () => {
  it("Marked false fails the tagged check with the pinned detail", async () => {
    const bodies = compliantBodies({
      1: "<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked false >> /StructTreeRoot 5 0 R /Lang (en-US) >>",
    });
    const report = await audit("unmarked.pdf", buildPdf(bodies, " /Info 7 0 R"));
    assert.deepEqual(check(report, "tagged"), {
      id: "tagged",
      name: "Document is tagged",
      passed: false,
      detail: "no MarkInfo dictionary with Marked true",
    });
  });

  it("a missing StructTreeRoot fails structure_tree and reading_order", async () => {
    const bodies = compliantBodies({
      1: "<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>",
    });
    const report = await audit("no-tree.pdf", buildPdf(bodies, " /Info 7 0 R"));
    assert.equal(check(report, "structure_tree").passed, false);
    assert.equal(check(report, "structure_tree").detail, "no StructTreeRoot in the document catalog");
    assert.equal(check(report, "reading_order").passed, false);
  });

  it("a structure tree with no structure elements fails reading_order alone", async () => {
    const bodies = compliantBodies({ 5: "<< /Type /StructTreeRoot /K [] >>", 6: "<< /Producer (Test) >>" });
    const report = await audit("no-elems.pdf", buildPdf(bodies, " /Info 7 0 R"));
    assert.equal(check(report, "structure_tree").passed, true);
    assert.deepEqual(check(report, "reading_order"), {
      id: "reading_order",
      name: "Reading order determinable",
      passed: false,
      detail: "no structure elements to define a reading order",
    });
    assert.equal(report.failed, 1);
    assert.equal(report.verdict, "6/7 checks passed. Route: repair. Failed: reading_order.");
  });

  it("an empty Lang string fails document_language", async () => {
    const bodies = compliantBodies({
      1: "<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 5 0 R /Lang () >>",
    });
    const report = await audit("empty-lang.pdf", buildPdf(bodies, " /Info 7 0 R"));
    assert.deepEqual(check(report, "document_language"), {
      id: "document_language",
      name: "Document language set",
      passed: false,
      detail: "no Lang entry in the document catalog",
    });
  });

  it("a hex-string Title is decoded and exposed", async () => {
    const bodies = compliantBodies({ 7: "<< /Title <5469746c65> >>" });
    const report = await audit("hex-title.pdf", buildPdf(bodies, " /Info 7 0 R"));
    assert.equal(check(report, "title_exposed").passed, true);
    assert.equal(check(report, "title_exposed").detail, 'Title is "Title"');
  });

  it("an empty Title fails title_exposed with the pinned detail", async () => {
    const bodies = compliantBodies({ 7: "<< /Title () /Author (Tester) >>" });
    const report = await audit("empty-title.pdf", buildPdf(bodies, " /Info 7 0 R"));
    assert.deepEqual(check(report, "title_exposed"), {
      id: "title_exposed",
      name: "Document title exposed",
      passed: false,
      detail: "no Title in the document information dictionary",
    });
  });
});

describe("checkPdfAccessibility — image alt text", () => {
  it("an image no structure element references fails with the pinned detail", async () => {
    const bodies = compliantBodies();
    bodies.push(IMAGE);
    const report = await audit("image-unreferenced.pdf", buildPdf(bodies, " /Info 7 0 R"));
    assert.deepEqual(check(report, "image_alt_text"), {
      id: "image_alt_text",
      name: "Image alt text",
      passed: false,
      detail: "images present but no structure element references them",
    });
  });

  it("a referencing structure element with /Alt passes, naming the count", async () => {
    // The minimal scan model keys on the /Image token inside the
    // structure element's own dictionary text.
    const bodies = compliantBodies({
      6: "<< /Type /StructElem /S /Figure /P 5 0 R /Alt (A cat asleep) /Image 8 0 R >>",
    });
    bodies.push(IMAGE);
    const report = await audit("image-alt.pdf", buildPdf(bodies, " /Info 7 0 R"));
    assert.deepEqual(check(report, "image_alt_text"), {
      id: "image_alt_text",
      name: "Image alt text",
      passed: true,
      detail: "all 1 image-referencing structure element(s) carry alt text",
    });
    assert.equal(report.failed, 0);
  });

  it("a referencing structure element without /Alt fails, naming the count", async () => {
    const bodies = compliantBodies({
      6: "<< /Type /StructElem /S /Figure /P 5 0 R /Image 8 0 R >>",
    });
    bodies.push(IMAGE);
    const report = await audit("image-no-alt.pdf", buildPdf(bodies, " /Info 7 0 R"));
    assert.equal(check(report, "image_alt_text").passed, false);
    assert.equal(
      check(report, "image_alt_text").detail,
      "1 of 1 image-referencing structure element(s) lack alt text",
    );
  });

  it("one of two referencing elements lacking /Alt reports 1 of 2", async () => {
    const bodies = [
      "<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 5 0 R /Lang (en-US) >>",
      PAGES,
      PAGE,
      contentObj("(Two figures) Tj"),
      "<< /Type /StructTreeRoot /K [6 0 R 7 0 R] >>",
      "<< /Type /StructElem /S /Figure /P 5 0 R /Alt (First figure) /Image 9 0 R >>",
      "<< /Type /StructElem /S /Figure /P 5 0 R /Image 9 0 R >>",
      INFO,
      IMAGE,
    ];
    const report = await audit("image-two.pdf", buildPdf(bodies, " /Info 8 0 R"));
    assert.equal(check(report, "image_alt_text").passed, false);
    assert.equal(
      check(report, "image_alt_text").detail,
      "1 of 2 image-referencing structure element(s) lack alt text",
    );
  });
});

describe("checkPdfAccessibility — access locks", () => {
  it("encryption whose /P sets bit 512 permits accessibility extraction", async () => {
    const bodies = compliantBodies();
    bodies.push("<< /Filter /Standard /V 2 /R 3 /P 516 >>");
    const report = await audit(
      "encrypted-open.pdf",
      buildPdf(bodies, " /Info 7 0 R /Encrypt 8 0 R"),
    );
    assert.deepEqual(check(report, "access_locks"), {
      id: "access_locks",
      name: "Not locked against assistive access",
      passed: true,
      detail: "encryption permits accessibility extraction",
    });
    assert.equal(report.failed, 0);
  });

  it("encryption without bit 512 is locked against assistive access", async () => {
    const bodies = compliantBodies();
    bodies.push("<< /Filter /Standard /V 2 /R 3 /P 4 >>");
    const report = await audit(
      "encrypted-locked.pdf",
      buildPdf(bodies, " /Info 7 0 R /Encrypt 8 0 R"),
    );
    assert.equal(check(report, "access_locks").passed, false);
    assert.equal(
      check(report, "access_locks").detail,
      "encryption does not permit accessibility extraction",
    );
    assert.equal(report.verdict, "6/7 checks passed. Route: repair. Failed: access_locks.");
  });

  it("an Encrypt dictionary with no /P counts as locked", async () => {
    const bodies = compliantBodies();
    bodies.push("<< /Filter /Standard /V 2 /R 3 >>");
    const report = await audit(
      "encrypted-no-p.pdf",
      buildPdf(bodies, " /Info 7 0 R /Encrypt 8 0 R"),
    );
    assert.equal(check(report, "access_locks").passed, false);
    assert.equal(
      check(report, "access_locks").detail,
      "encryption does not permit accessibility extraction",
    );
  });

  it("an inline trailer Encrypt dictionary is honoured", async () => {
    const report = await audit(
      "encrypted-inline.pdf",
      buildPdf(compliantBodies(), " /Info 7 0 R /Encrypt << /Filter /Standard /P 516 >>"),
    );
    assert.equal(check(report, "access_locks").passed, true);
    assert.equal(
      check(report, "access_locks").detail,
      "encryption permits accessibility extraction",
    );
  });
});

describe("checkPdfAccessibility — routes and verdicts", () => {
  it("an untagged digital PDF with text routes to guaranteed", async () => {
    const bodies = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      PAGES,
      PAGE,
      contentObj("(Some digital text) Tj"),
      "<< /Author (Someone) >>",
    ];
    const report = await audit("bare.pdf", buildPdf(bodies, " /Info 5 0 R"));
    assert.equal(report.route, "guaranteed");
    assert.equal(report.failed, 5);
    assert.equal(
      report.verdict,
      "2/7 checks passed. Route: guaranteed. Failed: tagged, structure_tree, document_language, title_exposed, reading_order.",
    );
  });

  it("TJ-array text also counts as extractable text for the route", async () => {
    const bodies = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      PAGES,
      PAGE,
      contentObj("[(Dig) 40 (ital)] TJ"),
      "<< /Author (Someone) >>",
    ];
    const report = await audit("bare-tj.pdf", buildPdf(bodies, " /Info 5 0 R"));
    assert.equal(report.route, "guaranteed");
  });

  it("a scanned document (image, no text) routes to ocr", async () => {
    const bodies = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      PAGES,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>",
      IMAGE,
      contentObj(""),
    ];
    const report = await audit("scanned.pdf", buildPdf(bodies));
    assert.equal(report.route, "ocr");
    assert.equal(report.failed, 6);
    assert.equal(
      report.verdict,
      "1/7 checks passed. Route: ocr. Failed: tagged, structure_tree, document_language, title_exposed, image_alt_text, reading_order.",
    );
  });

  it("a tagged document missing language and title routes to repair", async () => {
    const bodies = compliantBodies({
      1: "<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 5 0 R >>",
      7: "<< /Author (Tester) >>",
    });
    const report = await audit("partial.pdf", buildPdf(bodies, " /Info 7 0 R"));
    assert.equal(report.route, "repair");
    assert.equal(report.failed, 2);
    assert.equal(
      report.verdict,
      "5/7 checks passed. Route: repair. Failed: document_language, title_exposed.",
    );
  });
});

describe("checkPdfAccessibility — errors and argument validation", () => {
  it("a missing file is 'file not found: <path>'", async () => {
    const missing = path.join(dir, "does-not-exist.pdf");
    await assert.rejects(checkPdfAccessibility({ file_path: missing }), {
      message: `file not found: ${missing}`,
    });
  });

  it("a file with no %PDF- header is 'not a PDF file: <path>'", async () => {
    const file = path.join(dir, "not-a-pdf.pdf");
    await writeFile(file, "just some plain text, no header at all");
    await assert.rejects(checkPdfAccessibility({ file_path: file }), {
      message: `not a PDF file: ${file}`,
    });
  });

  it("a header with no object blocks is 'unsupported PDF structure: <path>'", async () => {
    const file = path.join(dir, "header-only.pdf");
    await writeFile(file, "%PDF-1.4\n%%EOF\n");
    await assert.rejects(checkPdfAccessibility({ file_path: file }), {
      message: `unsupported PDF structure: ${file}`,
    });
  });

  it("objects with no catalog are 'unsupported PDF structure: <path>'", async () => {
    const file = path.join(dir, "no-catalog.pdf");
    await writeFile(file, buildPdf([PAGES]));
    await assert.rejects(checkPdfAccessibility({ file_path: file }), {
      message: `unsupported PDF structure: ${file}`,
    });
  });

  it("a missing file_path names file_path as required", async () => {
    await assert.rejects(checkPdfAccessibility({}), { message: "file_path is required" });
    await assert.rejects(checkPdfAccessibility(null), { message: "file_path is required" });
  });

  it("a non-string or empty file_path names file_path", async () => {
    await assert.rejects(checkPdfAccessibility({ file_path: 42 }), {
      message: "file_path must be a non-empty string",
    });
    await assert.rejects(checkPdfAccessibility({ file_path: "" }), {
      message: "file_path must be a non-empty string",
    });
  });
});

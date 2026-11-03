/**
 * pdfaudit MCP server. Tools: check_pdf_accessibility.
 *
 * Why the low-level Server instead of McpServer: the high-level
 * helper converts zod schemas to JSON Schema and injects keys
 * not in this tool's defined spec ("$schema" and
 * "additionalProperties"), which breaks exact tool-list/schema
 * parity with the spec. This file serves tools/list with the
 * spec's exact input schema as an explicit literal, and every
 * tools/call is validated by the core, which names the
 * offending argument on invalid input.
 *
 * The audit is pure local file processing: the document is
 * read from disk, never uploaded, and no network is touched.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { checkPdfAccessibility, formatReport, VERSION } from "./audit.js";

const TOOLS = [
  {
    name: "check_pdf_accessibility",
    description:
      "Audit a local PDF against the machine-checkable basics of PDF/UA accessibility and return a JSON report. The document is never uploaded.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
         description: "Path to the local file for this call." },
      },
      required: ["file_path"],
    },
  },
];

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

const server = new Server(
  { name: "pdfaudit", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === "check_pdf_accessibility") {
      const report = await checkPdfAccessibility(args ?? {});
      return textResult(formatReport(report));
    }
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  } catch (err) {
    if (err instanceof McpError) throw err;
    return errorResult(err);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();

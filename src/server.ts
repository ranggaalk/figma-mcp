#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { transform } from "esbuild";
import { z } from "zod";
import { FigmaBridge } from "./bridge.js";

const PORT = Number(process.env.FIGMA_BRIDGE_PORT ?? 3055);
const HOST = process.env.FIGMA_BRIDGE_HOST ?? "127.0.0.1";

const READ_TIMEOUT_MS = 30_000;
const EXPORT_TIMEOUT_MS = 60_000;
/** Tool results larger than this are cut off so one call cannot flood the agent's context. */
const MAX_TEXT_CHARS = 80_000;

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const bridge = new FigmaBridge(PORT, HOST);

function textResult(value: unknown): ToolResult {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length > MAX_TEXT_CHARS) {
    text =
      text.slice(0, MAX_TEXT_CHARS) +
      `\n…[truncated: the full result was ${text.length} characters. Ask for a smaller depth or a more specific node.]`;
  }
  return { content: [{ type: "text", text }] };
}

async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

/** Accepts ids as they appear in Figma URLs (`12-34`) as well as API form (`12:34`). */
function normalizeNodeId(id: string): string {
  const trimmed = id.trim();
  return /^\d+-\d+$/.test(trimmed) ? trimmed.replace("-", ":") : trimmed;
}

/**
 * Figma's plugin sandbox rejects some newer syntax (optional chaining, object
 * spread, …), so agent-written code is lowered to ES2017 before it is sent.
 * The TypeScript loader also strips any type annotations the agent adds.
 */
async function compileSnippet(code: string): Promise<string> {
  const wrapped = `var __figmaBridgeMain = async function (figma, console) {\n${code}\n};`;
  try {
    const { code: compiled } = await transform(wrapped, { loader: "ts", target: "es2017" });
    return compiled;
  } catch (err) {
    const errors = (err as { errors?: Array<{ text: string; location?: { line: number; column: number } | null }> })
      .errors;
    if (!errors?.length) throw err;
    const details = errors
      // Line numbers are shifted by one because of the wrapper's first line.
      .map((e) => (e.location ? `line ${e.location.line - 1}, column ${e.location.column}: ${e.text}` : e.text))
      .join("\n");
    throw new Error(`The code has a syntax error and was not run.\n${details}`);
  }
}

const server = new McpServer(
  { name: "figma-bridge", version: "0.1.0" },
  {
    instructions: [
      "Reads and edits the Figma file the user currently has open, through a local plugin (no Figma REST API).",
      "Typical loop: get_status to confirm the connection → get_document_info / get_selection / get_node / get_styles to understand the file → execute_code to create or change the design → export_node to look at the result and fix what is off.",
      "Reuse the file's existing styles, variables and components instead of hard-coding values when they exist.",
      'If a tool reports that the plugin is not connected, ask the user to run Plugins → Development → "Figma MCP Bridge" in the Figma desktop app.',
    ].join("\n"),
  },
);

const depthSchema = z
  .number()
  .int()
  .min(0)
  .max(10)
  .default(2)
  .describe("How many levels of children to include. 0 returns only the node itself with a childCount.");

server.registerTool(
  "get_status",
  {
    title: "Figma connection status",
    description:
      "Check whether the Figma plugin is connected, and which file, page and selection are active. Call this first.",
    annotations: { readOnlyHint: true },
  },
  () =>
    guarded(async () => {
      const status = bridge.status();
      if (!bridge.connected) {
        return textResult({ connected: false, ...status, hint: bridge.notConnectedMessage() });
      }
      const live = await bridge.request("get_status", {}, READ_TIMEOUT_MS);
      return textResult({ connected: true, ...(live as object), bridge: status });
    }),
);

server.registerTool(
  "get_document_info",
  {
    title: "Document overview",
    description:
      "List the file's pages and the top-level frames/nodes on the current page (id, name, type, position, size). Use it to find node ids to inspect or export.",
    annotations: { readOnlyHint: true },
  },
  () => guarded(async () => textResult(await bridge.request("get_document_info", {}, READ_TIMEOUT_MS))),
);

server.registerTool(
  "get_selection",
  {
    title: "Read the current selection",
    description:
      "Return the nodes the user has selected in Figma, with layout, fills, strokes, text and component details, plus children down to `depth`.",
    inputSchema: { depth: depthSchema },
    annotations: { readOnlyHint: true },
  },
  ({ depth }) => guarded(async () => textResult(await bridge.request("get_selection", { depth }, READ_TIMEOUT_MS))),
);

server.registerTool(
  "get_node",
  {
    title: "Read a node",
    description:
      "Return one node by id with layout, fills, strokes, text and component details, plus children down to `depth`. Property names match the Figma Plugin API, so they can be used directly in execute_code.",
    inputSchema: {
      nodeId: z.string().describe('Node id such as "12:34". The "12-34" form from a Figma URL also works.'),
      depth: depthSchema,
    },
    annotations: { readOnlyHint: true },
  },
  ({ nodeId, depth }) =>
    guarded(async () =>
      textResult(await bridge.request("get_node", { nodeId: normalizeNodeId(nodeId), depth }, READ_TIMEOUT_MS)),
    ),
);

server.registerTool(
  "get_styles",
  {
    title: "Read local styles and variables",
    description:
      "Return the file's local paint, text and effect styles, and its variable collections with values per mode. Check this before designing so new work reuses the existing design tokens.",
    inputSchema: {
      includeVariables: z.boolean().default(true).describe("Set to false to skip variables in files with very many."),
    },
    annotations: { readOnlyHint: true },
  },
  ({ includeVariables }) =>
    guarded(async () => textResult(await bridge.request("get_styles", { includeVariables }, READ_TIMEOUT_MS))),
);

server.registerTool(
  "export_node",
  {
    title: "Export a node as an image",
    description:
      "Render a node (frame, component, group, page, …) to PNG and return the image so you can see the design. Use it after every meaningful change to verify the result visually. The Figma window must be visible on screen: Figma does not render while it is minimized or fully covered (get_status reports this as figmaWindowVisible).",
    inputSchema: {
      nodeId: z.string().optional().describe("Node to render. Defaults to the first selected node."),
      scale: z.number().min(0.05).max(4).default(1).describe("Export scale; 2 gives sharper detail."),
      maxSize: z
        .number()
        .int()
        .min(64)
        .max(4096)
        .default(1600)
        .describe("Longest side of the image in pixels. The scale is reduced if the export would exceed it."),
    },
    annotations: { readOnlyHint: true },
  },
  ({ nodeId, scale, maxSize }) =>
    guarded(async () => {
      const params = { nodeId: nodeId ? normalizeNodeId(nodeId) : undefined, scale, maxSize };
      const { base64, mimeType, ...info } = (await bridge.request("export_node", params, EXPORT_TIMEOUT_MS)) as {
        base64: string;
        mimeType: string;
      };
      return {
        content: [
          { type: "image", data: base64, mimeType },
          { type: "text", text: JSON.stringify(info) },
        ],
      };
    }),
);

server.registerTool(
  "execute_code",
  {
    title: "Run Plugin API code in Figma",
    description: [
      "Run JavaScript (or TypeScript) against the Figma Plugin API in the open file. This is how you create and edit designs.",
      "",
      "The code is the body of an async function: use `await` freely and `return` a value to get it back. `figma` is the Plugin API global. `console.log` output is returned too. Returned nodes come back as {id, name, type, x, y, width, height}; return the ids of what you create so you can inspect or export them afterwards.",
      "",
      "Rules of the Plugin API that commonly cause errors:",
      "- Load fonts before changing text: `await figma.loadFontAsync({ family: 'Inter', style: 'Regular' })`, then set `fontName` and `characters`.",
      "- The file uses dynamic page loading, so use the async variants: `figma.getNodeByIdAsync`, `figma.setCurrentPageAsync`, `instance.getMainComponentAsync`, `figma.getLocalPaintStylesAsync`, `node.setFillStyleIdAsync`, `figma.variables.getLocalVariablesAsync`, and `await page.loadAsync()` before reading another page's children.",
      "- Colors are `{ r, g, b }` with channels from 0 to 1, e.g. `fills = [{ type: 'SOLID', color: { r: 1, g: 0.4, b: 0 } }]`. Opacity belongs on the paint, not in the color.",
      "- `fills`, `strokes` and `effects` are immutable arrays: assign a new array rather than mutating in place.",
      "- For auto layout set `layoutMode` on the frame first. Set a child's `layoutSizingHorizontal/Vertical` to 'FILL' or 'HUG' only after it has been appended to an auto-layout parent.",
      "- New nodes appear at (0, 0) on the current page. Append them to their parent, or position them away from existing content.",
      "- Never call `figma.closePlugin()`; it disconnects this bridge.",
      "",
      "Each call is one undo step in Figma. If the code throws, changes made before the error are NOT rolled back, so inspect the document before retrying. Prefer several small calls over one very large script.",
    ].join("\n"),
    inputSchema: {
      code: z.string().describe("Body of an async function. `figma` and `console` are in scope."),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(300_000)
        .default(30_000)
        .describe("How long to wait for the code to finish."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  ({ code, timeoutMs }) =>
    guarded(async () => {
      if (!bridge.connected) throw new Error(bridge.notConnectedMessage());
      const compiled = await compileSnippet(code);
      return textResult(await bridge.request("execute_code", { compiled }, timeoutMs));
    }),
);

bridge.start();
await server.connect(new StdioServerTransport());

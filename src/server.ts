#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FigmaBridge } from "./bridge.js";
import { compileSnippet } from "./compile.js";
import {
  BUILD_TIMEOUT_MS,
  DEFAULT_PORT,
  PLUGIN_TIMEOUT_MARGIN_MS,
  PLUGIN_VERSION,
  type ExportResult,
  type ScreenshotResult,
} from "./protocol.js";
import { nodeSpecSchema, updatePropsSchema } from "./spec-schema.js";

const PORT = Number(process.env.FIGMA_BRIDGE_PORT ?? DEFAULT_PORT);
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

function toText(value: unknown): string {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length > MAX_TEXT_CHARS) {
    text =
      text.slice(0, MAX_TEXT_CHARS) +
      `\n…[truncated: the full result was ${text.length} characters. Ask for a smaller depth or a more specific node.]`;
  }
  return text;
}

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: toText(value) }] };
}

/** Like textResult, but a `screenshot` field becomes an image block. */
function resultWithScreenshot(value: unknown): ToolResult {
  const { screenshot, ...rest } = value as { screenshot?: ScreenshotResult } & Record<string, unknown>;
  if (!screenshot) return textResult(rest);
  if ("skipped" in screenshot) return textResult({ ...rest, screenshot: { skipped: screenshot.skipped } });
  const { base64, mimeType, ...info } = screenshot;
  return {
    content: [
      { type: "text", text: toText({ ...rest, screenshot: info }) },
      { type: "image", data: base64, mimeType },
    ],
  };
}

const screenshotSchema = z
  .boolean()
  .default(false)
  .describe(
    "Also return a PNG of the result (the top-level frame containing it), saving a separate export_node call. Skipped with a note while the Figma window is hidden.",
  );

async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  let result: ToolResult;
  try {
    result = await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
  const warning = bridge.versionWarning();
  if (warning) result.content.push({ type: "text", text: warning });
  return result;
}

/** Accepts ids as they appear in Figma URLs (`12-34`) as well as API form (`12:34`). */
function normalizeNodeId(id: string): string {
  const trimmed = id.trim();
  return /^\d+-\d+$/.test(trimmed) ? trimmed.replace("-", ":") : trimmed;
}

const server = new McpServer(
  { name: "figma-bridge", version: PLUGIN_VERSION },
  {
    instructions: [
      "Reads and edits the Figma file the user currently has open, through a local plugin (no Figma REST API).",
      "Typical loop: get_status to confirm the connection → get_document_info / get_selection / get_node / get_styles to understand the file → build_design to create screens and components, update_nodes to change existing nodes → look at the screenshot (screenshot: true) and fix what is off.",
      "Use execute_code only for what build_design and update_nodes cannot express (loops over many nodes, component variants, reading data); inside it, the `h` helpers give the same builder.",
      "Reuse the file's existing styles, variables and components instead of hard-coding values when they exist.",
      "Before changing a design that already existed (not one you just created), call save_checkpoint so the user can restore it from Figma's version history.",
      "Every call that changes the document is one undo step for the user, and is rolled back automatically if it fails.",
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
      const { base64, mimeType, ...info } = (await bridge.request(
        "export_node",
        params,
        EXPORT_TIMEOUT_MS,
      )) as ExportResult;
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
      "Run JavaScript (or TypeScript) against the Figma Plugin API in the open file. Prefer build_design and update_nodes; use this for what they cannot express.",
      "",
      "The code is the body of an async function: use `await` freely and `return` a value to get it back. `figma` is the Plugin API global. `console.log` output is returned too. Returned nodes come back as {id, name, type, x, y, width, height}; return the ids of what you create so you can inspect or export them afterwards.",
      "",
      "`h` holds builder helpers that handle fonts and sizing rules for you:",
      "- `await h.build(spec, { parent?, index? })` creates nodes from a build_design spec and returns the root node.",
      "- `await h.apply(nodeOrId, props)` changes a node with update_nodes props.",
      "- `await h.setText(nodeOrId, 'text')` replaces text after loading the fonts it uses.",
      "- `await h.font('Inter', 600)` resolves and loads a font, returning its FontName.",
      "- `h.paint('#4F46E5')` returns a fills/strokes array; `h.color('#4F46E5')` returns { r, g, b }.",
      "",
      "Rules of the Plugin API that commonly cause errors:",
      "- Load fonts before changing text: `await figma.loadFontAsync({ family: 'Inter', style: 'Regular' })`, then set `fontName` and `characters`.",
      "- The file uses dynamic page loading, so use the async variants: `figma.getNodeByIdAsync`, `figma.setCurrentPageAsync`, `instance.getMainComponentAsync`, `figma.getLocalPaintStylesAsync`, `node.setFillStyleIdAsync`, `figma.variables.getLocalVariablesAsync`, and `await page.loadAsync()` before reading another page's children.",
      "- Colors are `{ r, g, b }` with channels from 0 to 1, e.g. `fills = [{ type: 'SOLID', color: { r: 1, g: 0.4, b: 0 } }]`. Opacity belongs on the paint, not in the color.",
      "- `fills`, `strokes` and `effects` are immutable arrays: assign a new array rather than mutating in place.",
      "- For auto layout set `layoutMode` on the frame first. Set a child's `layoutSizingHorizontal/Vertical` to 'FILL' or 'HUG' only after it has been appended to an auto-layout parent.",
      "- New nodes appear at (0, 0) on the current page. Append them to their parent, or position them away from existing content.",
      "- Do not call `figma.closePlugin()` (it disconnects this bridge) or `figma.commitUndo()` / `figma.triggerUndo()` (the bridge manages undo). Code that does is rejected.",
      "",
      "Each call is one undo step in Figma. If the code throws or times out, every change it made is rolled back automatically, so the file is unchanged and you can fix the code and run it again. Prefer several small calls over one very large script.",
    ].join("\n"),
    inputSchema: {
      code: z.string().describe("Body of an async function. `figma`, `h` and `console` are in scope."),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(300_000)
        .default(30_000)
        .describe("How long to wait for the code to finish."),
      screenshot: screenshotSchema.describe(
        "Also return a PNG of the top-level frame containing the first node the code returns (or the selection).",
      ),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  ({ code, timeoutMs, screenshot }) =>
    guarded(async () => {
      if (!bridge.connected) throw new Error(bridge.notConnectedMessage());
      const compiled = await compileSnippet(code);
      return resultWithScreenshot(
        await bridge.request("execute_code", { compiled, timeoutMs, screenshot }, timeoutMs + PLUGIN_TIMEOUT_MARGIN_MS),
      );
    }),
);

server.registerTool(
  "build_design",
  {
    title: "Build a design from a spec",
    description: [
      "Create a frame (screen, card, component…) and everything inside it from one JSON spec, in a single undo step. The whole spec is checked before anything is created; errors name the exact path, e.g. spec.children[2].fill.",
      "",
      "Node types: frame (auto layout by default), component, text, rect, ellipse, line (divider) and svg (icons).",
      "Frames are vertical auto layout unless layout says otherwise, and hug their content; use width/height \"fill\" to stretch inside an auto-layout parent. Fonts are loaded for you (default Inter, size 16).",
      "Without parentId the result is placed in empty space on the current page, selected and scrolled into view. With parentId it is added inside that frame (at index, or last).",
      "",
      "Example:",
      '{"type":"frame","name":"Card","width":360,"padding":24,"gap":12,"fill":"#FFFFFF","radius":16,"stroke":"#E2E8F0","shadow":{"y":4,"blur":16,"color":"#0F172A14"},"children":[',
      ' {"type":"text","text":"Upgrade to Pro","size":20,"weight":600,"color":"#0F172A"},',
      ' {"type":"text","text":"Unlimited projects and priority support.","width":"fill","color":"#475569","lineHeight":1.5},',
      ' {"type":"line","fill":"#E2E8F0"},',
      ' {"type":"frame","layout":"horizontal","width":"fill","align":"end","gap":8,"children":[',
      '  {"type":"frame","name":"Button","padding":[10,16],"radius":8,"fill":"#4F46E5","children":[{"type":"text","text":"Upgrade","weight":600,"color":"#FFFFFF"}]}]}]}',
      "",
      "Returns the ids of the created nodes by spec path, for later update_nodes calls.",
    ].join("\n"),
    inputSchema: {
      spec: nodeSpecSchema,
      parentId: z.string().optional().describe("Frame (or page) to add the result to. Default: the current page."),
      index: z.number().int().min(0).optional().describe("Position among the parent's children. Default: last."),
      screenshot: screenshotSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ spec, parentId, index, screenshot }) =>
    guarded(async () =>
      resultWithScreenshot(
        await bridge.request(
          "build_design",
          { spec, parentId: parentId ? normalizeNodeId(parentId) : undefined, index, screenshot },
          BUILD_TIMEOUT_MS + PLUGIN_TIMEOUT_MARGIN_MS,
        ),
      ),
    ),
);

server.registerTool(
  "update_nodes",
  {
    title: "Change existing nodes",
    description: [
      "Change properties of existing nodes using the build_design format, in a single undo step. All updates are checked before any is applied.",
      "Which props apply depends on the node: frames take layout/gap/padding/align/fill/stroke/radius/shadow…, text takes text/spans/font/weight/size/color/align…, shapes take fill/stroke/radius. width/height/name/x/y/opacity/visible work on all.",
      'Example: {"updates":[{"nodeId":"12:34","props":{"fill":"#F8FAFC","padding":[16,24]}},{"nodeId":"12:40","props":{"text":"Save changes","weight":600}}]}',
    ].join("\n"),
    inputSchema: {
      updates: z
        .array(
          z.object({
            nodeId: z.string().describe('Node id such as "12:34".'),
            props: updatePropsSchema,
          }),
        )
        .min(1),
      screenshot: screenshotSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ updates, screenshot }) =>
    guarded(async () =>
      resultWithScreenshot(
        await bridge.request(
          "update_nodes",
          { updates: updates.map((u) => ({ ...u, nodeId: normalizeNodeId(u.nodeId) })), screenshot },
          BUILD_TIMEOUT_MS + PLUGIN_TIMEOUT_MARGIN_MS,
        ),
      ),
    ),
);

server.registerTool(
  "save_checkpoint",
  {
    title: "Save a version checkpoint",
    description:
      "Save a named version to the file's version history (File → Show version history in Figma), so the user can restore the design as it is now. Call it before changing designs that already existed, especially before large edits.",
    inputSchema: {
      title: z.string().min(1).max(200).describe('Short version name, e.g. "Before restyling the login screen".'),
      description: z.string().max(1000).optional().describe("What is about to change."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ title, description }) =>
    guarded(async () =>
      textResult(await bridge.request("save_checkpoint", { title, description }, 60_000 + PLUGIN_TIMEOUT_MARGIN_MS)),
    ),
);

bridge.start();
await server.connect(new StdioServerTransport());

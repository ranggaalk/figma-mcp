#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FigmaBridge } from "./bridge.js";
import { catalogStyles, saveCatalog, searchCatalogComponents } from "./catalog.js";
import { compileSnippet } from "./compile.js";
import { readImageFile } from "./images.js";
import { loadSkills, type Skill } from "./skills.js";
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
      "build_design and update_nodes report layout and contrast problems they find in a `check` field; fix them before moving on. Run check_design on a finished screen (or on an existing design you are asked to tidy) for the full report, and find_nodes to locate layers in large files.",
      "Reuse the file's design system instead of hard-coding values: get_styles lists styles and variables, get_components lists components. In specs, bind colors and spacing with { \"variable\": \"name\" } or { \"style\": \"name\" }, text with textStyle, and place components with type \"instance\".",
      "Before changing a design that already existed (not one you just created), call save_checkpoint so the user can restore it from Figma's version history.",
      "Every call that changes the document is one undo step for the user, and is rolled back automatically if it fails.",
      "Design know-how ships with this server as skills (get_skill): read design-direction before designing a new screen, design-system before creating tokens or components, accessibility for interactive screens and reviews, ux-writing for interface text.",
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
      "Return the file's local paint, text and effect styles, and its variable collections with values per mode. Check this before designing so new work reuses the existing design tokens. With includeLibraries, also list variables from enabled team libraries and styles from saved library catalogs (see save_library_catalog), with the keys needed to use them.",
    inputSchema: {
      includeVariables: z.boolean().default(true).describe("Set to false to skip variables in files with very many."),
      includeLibraries: z.boolean().default(false).describe("Also list team-library variables and catalog styles."),
    },
    annotations: { readOnlyHint: true },
  },
  ({ includeVariables, includeLibraries }) =>
    guarded(async () => {
      const styles = (await bridge.request("get_styles", { includeVariables, includeLibraries }, READ_TIMEOUT_MS)) as Record<string, unknown>;
      if (includeLibraries) styles.libraryCatalogStyles = await catalogStyles();
      return textResult(styles);
    }),
);

server.registerTool(
  "check_design",
  {
    title: "Check a design for problems",
    description: [
      "Inspect a frame (and everything in it) for common problems, each with the node id, its layer path and a suggested fix:",
      "- error: text that does not fit its fixed box, fonts that are not installed",
      "- warning: content cut off by a clipping frame or sticking out of its auto-layout parent, auto-layout frames left at Figma's 100 px default size, text contrast below WCAG AA, colors equal to a design token but not linked to it",
      "- info: colors outside the file's palette, text without a text style, default layer names (\"Frame 12\")",
      "Contents of component instances are checked in their main component.",
    ].join("\n"),
    inputSchema: {
      nodeId: z.string().optional().describe("Frame to check. Default: the first selected node."),
      minSeverity: z.enum(["error", "warning", "info"]).default("info").describe("Leave out less severe issues."),
      maxIssues: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: true },
  },
  ({ nodeId, minSeverity, maxIssues }) =>
    guarded(async () =>
      textResult(
        await bridge.request(
          "check_design",
          { nodeId: nodeId ? normalizeNodeId(nodeId) : undefined, minSeverity, maxIssues },
          120_000,
        ),
      ),
    ),
);

server.registerTool(
  "find_nodes",
  {
    title: "Find layers",
    description:
      "Search for layers by name, by text content and/or by type, on the current page, inside one node, or across all pages. Returns ids, layer paths and positions, which is cheaper than reading whole trees in large files.",
    inputSchema: {
      query: z.string().optional().describe("Part of the layer name (case-insensitive)."),
      text: z.string().optional().describe("Part of the text content; matches text layers only."),
      types: z
        .array(z.string())
        .optional()
        .describe('Node types such as ["FRAME", "TEXT", "INSTANCE", "COMPONENT"].'),
      withinNodeId: z.string().optional().describe("Only search inside this node."),
      allPages: z.boolean().default(false).describe("Search every page instead of the current one."),
      limit: z.number().int().min(1).max(500).default(50),
    },
    annotations: { readOnlyHint: true },
  },
  ({ query, text, types, withinNodeId, allPages, limit }) =>
    guarded(async () =>
      textResult(
        await bridge.request(
          "find_nodes",
          { query, text, types, withinNodeId: withinNodeId ? normalizeNodeId(withinNodeId) : undefined, allPages, limit },
          120_000,
        ),
      ),
    ),
);

server.registerTool(
  "get_components",
  {
    title: "List components",
    description:
      "List components and component sets in this file (with their properties and variant options), library components already used in the file, and matches from saved library catalogs. Place one with build_design type \"instance\" and component set to its name, id or key.",
    inputSchema: {
      query: z.string().optional().describe('Filter by name, e.g. "button".'),
      limit: z.number().int().min(1).max(500).default(50).describe("Maximum results per group."),
      includeUsed: z
        .boolean()
        .default(true)
        .describe("Scan instances for library components already used in this file (slower in very large files)."),
    },
    annotations: { readOnlyHint: true },
  },
  ({ query, limit, includeUsed }) =>
    guarded(async () => {
      const result = (await bridge.request("get_components", { query, limit, includeUsed }, 120_000)) as Record<string, unknown>;
      const catalogs = await searchCatalogComponents(query, limit);
      if (catalogs.length > 0) result.libraryCatalogs = catalogs;
      else result.libraryCatalogsHint = "No saved library catalogs match. To use a team library's components here, open the library file, run the plugin there and call save_library_catalog once.";
      return textResult(result);
    }),
);

server.registerTool(
  "save_library_catalog",
  {
    title: "Save this file as a library catalog",
    description:
      "Run this in a library file (one whose components and styles are published to a team library). It saves their names, keys and properties on this computer, so get_components and get_styles in other files can find them and build_design can import them by key. Only published items can be imported elsewhere; each entry shows its publish status.",
    annotations: { readOnlyHint: true },
  },
  () =>
    guarded(async () => {
      const snapshot = (await bridge.request("library_snapshot", {}, 120_000)) as {
        fileName: string;
        components: Array<Record<string, unknown>>;
        styles: Array<Record<string, unknown>>;
      };
      const path = await saveCatalog(snapshot as any);
      const unpublished = [...snapshot.components, ...snapshot.styles].filter((item) => item.published === "UNPUBLISHED").length;
      return textResult({
        saved: path,
        library: snapshot.fileName,
        components: snapshot.components.length,
        styles: snapshot.styles.length,
        unpublished,
        hint: unpublished
          ? `${unpublished} item(s) are not published yet; publish the library in Figma so other files can import them.`
          : "Other files can now find these with get_components / get_styles (includeLibraries).",
      });
    }),
);

server.registerTool(
  "place_image",
  {
    title: "Add an image file",
    description:
      "Put a PNG, JPEG or GIF from this computer into Figma: as a new rectangle at its natural size (or scaled to width), or as the fill of an existing node. Returns an imageHash to reuse in build_design / update_nodes as fill: { \"image\": \"<imageHash>\" }. Windows paths (C:\\…) are read through /mnt/c.",
    inputSchema: {
      path: z.string().describe("Path to the image file."),
      nodeId: z.string().optional().describe("Fill this existing node with the image instead of creating a rectangle."),
      parentId: z.string().optional().describe("Frame to put the new rectangle in. Default: free space on the current page."),
      width: z.number().positive().optional().describe("Scale the new rectangle to this width, keeping the aspect ratio."),
      scaleMode: z.enum(["fill", "fit", "crop", "tile"]).default("fill").describe("How the image fills its node."),
      name: z.string().optional().describe("Layer name. Default: the file name."),
      screenshot: screenshotSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ path, nodeId, parentId, width, scaleMode, name, screenshot }) =>
    guarded(async () => {
      const image = await readImageFile(path);
      return resultWithScreenshot(
        await bridge.request(
          "place_image",
          {
            base64: image.base64,
            name: name ?? image.name,
            nodeId: nodeId ? normalizeNodeId(nodeId) : undefined,
            parentId: parentId ? normalizeNodeId(parentId) : undefined,
            width,
            scaleMode: scaleMode.toUpperCase() as "FILL" | "FIT" | "CROP" | "TILE",
            screenshot,
          },
          BUILD_TIMEOUT_MS + PLUGIN_TIMEOUT_MARGIN_MS,
        ),
      );
    }),
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
      "- `figma.setCurrentPageAsync` does not finish while the Figma window is hidden (get_status: figmaWindowVisible). Work on another page through `page.loadAsync()` and `page.appendChild()` instead of switching to it.",
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
      'When turning on layout for a frame that had none, also give width/height ("hug" to fit the content): Figma otherwise keeps the cross-axis size fixed, which can cut content off.',
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

// ------------------------------------------------------------------ skills

const skills = loadSkills();
const skillByName = new Map(skills.map((skill) => [skill.name, skill]));

function skillText(name: string): string {
  const skill = skillByName.get(name);
  return skill ? skill.body : `(The ${name} skill is not installed with this server.)`;
}

function promptResult(description: string, text: string) {
  return { description, messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

if (skills.length > 0) {
  const names = skills.map((skill) => skill.name) as [string, ...string[]];

  server.registerTool(
    "get_skill",
    {
      title: "Read a design skill",
      description: [
        "Design know-how written for this bridge, in Markdown. Call without a name to list the skills; call with a name to read one before starting that kind of work:",
        ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join("\n"),
      inputSchema: { name: z.enum(names).optional().describe("Skill to read. Leave out to list them.") },
      annotations: { readOnlyHint: true },
    },
    ({ name }) =>
      guarded(async () => {
        if (!name) return textResult({ skills: skills.map(({ name, description, uri }) => ({ name, description, uri })) });
        return { content: [{ type: "text", text: skillText(name) }] };
      }),
  );

  for (const skill of skills) {
    server.registerResource(
      `skill-${skill.name}`,
      skill.uri,
      { title: `Skill: ${skill.name}`, description: skill.description, mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: skill.body }] }),
    );
  }

  const target = (nodeId: string | undefined) =>
    nodeId ? `the node ${nodeId}` : "the frame selected in Figma (ask the user to select one if nothing is selected)";

  server.registerPrompt(
    "design_screen",
    {
      title: "Design a screen",
      description: "Design a new screen or section in the open Figma file, using the file's design system, then review it.",
      argsSchema: {
        brief: z.string().describe("What to design: purpose, audience, content, constraints."),
        platform: z.string().optional().describe('For example "desktop 1440", "mobile 390".'),
      },
    },
    ({ brief, platform }) =>
      promptResult(
        "Design a screen",
        [
          "Design this in the Figma file that is open through figma-bridge:",
          "",
          brief,
          platform ? `\nPlatform: ${platform}` : "",
          "",
          "Follow the design-direction skill below: understand the job, read the file's design system, write a short plan, build with build_design using the file's variables, styles and components, then review the screenshot and the check results and fix what is off.",
          "Apply the accessibility and ux-writing skills to what you build (read them with get_skill).",
          "Finish by reporting what you built (frame name and id), the main decisions, your assumptions, and anything you could not verify.",
          "",
          "---",
          "",
          skillText("design-direction"),
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "audit_design",
    {
      title: "Audit a design",
      description: "Review a frame for accessibility, copy and design-system consistency, without changing it.",
      argsSchema: {
        nodeId: z.string().optional().describe("Frame to review. Default: the current selection."),
        focus: z.string().optional().describe('Narrow the review, for example "accessibility" or "copy".'),
      },
    },
    ({ nodeId, focus }) =>
      promptResult(
        "Audit a design",
        [
          `Review ${target(nodeId)} in the open Figma file. This is read-only: do not change anything.`,
          focus ? `Focus on: ${focus}.` : "Cover accessibility, interface copy (get_skill ux-writing) and consistency with the file's design system (unlinked tokens, hard-coded values, components that should have been used).",
          "Use check_design first, then find_nodes, get_node and get_components for what it does not cover, and export_node to look at it if the Figma window is visible.",
          "Report findings in a table ordered by severity, with node ids, layer paths and concrete fixes. Then ask which ones to fix.",
          "",
          "---",
          "",
          skillText("accessibility"),
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "setup_design_system",
    {
      title: "Set up a design system",
      description: "Create or extend variables, styles and components in the open Figma file.",
      argsSchema: {
        brief: z.string().optional().describe("Brand colours, fonts, the components needed, or what to extend."),
      },
    },
    ({ brief }) =>
      promptResult(
        "Set up a design system",
        [
          "Set up or extend the design system in the Figma file that is open through figma-bridge.",
          brief ? `\nBrief: ${brief}\n` : "",
          "Start by reading what already exists (get_styles, get_components) and summarise it with your plan: collections and modes, token names, text and effect styles, components and their variants. If the brief leaves major choices open, ask before creating; otherwise go ahead, following the skill below, and verify the result with get_styles and get_components.",
          "",
          "---",
          "",
          skillText("design-system"),
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "review_copy",
    {
      title: "Review interface copy",
      description: "Review and improve the text in a frame; changes are proposed first and applied only after approval.",
      argsSchema: {
        nodeId: z.string().optional().describe("Frame whose text to review. Default: the current selection."),
        language: z.string().optional().describe('Language and tone, for example "Indonesian, informal (kamu)".'),
      },
    },
    ({ nodeId, language }) =>
      promptResult(
        "Review interface copy",
        [
          `Review the interface text in ${target(nodeId)}.`,
          language ? `Language and tone: ${language}.` : "Keep the language the design already uses.",
          "List every text with find_nodes, then propose changes as a table (where, current, proposed, why), following the skill below. Do not change anything until the user approves; then apply with update_nodes and check the result.",
          "",
          "---",
          "",
          skillText("ux-writing"),
        ].join("\n"),
      ),
  );
}

bridge.start();
await server.connect(new StdioServerTransport());

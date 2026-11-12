// Shared by the MCP server (Node) and the Figma plugin (Figma's sandbox).
// Keep this file free of Node and Figma APIs: types and constants only.

/** Version of the plugin this server was built with. Both sides must match. */
export const PLUGIN_VERSION = "0.4.1";

export const DEFAULT_PORT = 3055;

/** Sent by the plugin right after it connects, and again when the page changes. */
export interface PluginHello {
  fileName: string;
  pageName: string;
  editorType: string;
  pluginVersion: string;
}

/** Parameters of each command the server can send to the plugin. */
export interface CommandParams {
  get_status: Record<string, never>;
  get_document_info: Record<string, never>;
  get_selection: { depth: number };
  get_node: { nodeId: string; depth: number };
  get_styles: { includeVariables: boolean; includeLibraries: boolean };
  get_components: { query?: string; limit: number; includeUsed: boolean };
  /** Keys, names and properties of this file's components and styles, for save_library_catalog. */
  library_snapshot: Record<string, never>;
  check_design: { nodeId?: string; maxIssues: number; minSeverity: "error" | "warning" | "info" };
  find_nodes: { query?: string; text?: string; types?: string[]; withinNodeId?: string; allPages: boolean; limit: number };
  place_image: {
    base64: string;
    name: string;
    nodeId?: string;
    parentId?: string;
    width?: number;
    scaleMode: "FILL" | "FIT" | "CROP" | "TILE";
    screenshot?: boolean;
  };
  export_node: { nodeId?: string; scale: number; maxSize: number };
  /** `compiled` defines `__figmaBridgeMain`, produced by the server's compileSnippet. */
  execute_code: { compiled: string; timeoutMs: number; screenshot?: boolean };
  save_checkpoint: { title: string; description?: string };
  build_design: { spec: unknown; parentId?: string; index?: number; screenshot?: boolean };
  update_nodes: { updates: unknown; screenshot?: boolean };
}

/** Time limit for build_design and update_nodes inside the plugin. */
export const BUILD_TIMEOUT_MS = 60000;

/** Attached to results of commands called with `screenshot: true`. */
export type ScreenshotResult = ExportResult | { skipped: string };

/** The server waits this much longer than a mutation's own time limit, so the plugin's rollback message arrives. */
export const PLUGIN_TIMEOUT_MARGIN_MS = 2000;

export type CommandName = keyof CommandParams;

export interface ExportResult {
  nodeId: string;
  name: string;
  width?: number;
  height?: number;
  scale: number;
  mimeType: "image/png";
  base64: string;
}

/** Messages on the WebSocket, server → plugin. */
export interface CommandMessage {
  type: "command";
  id: string;
  command: string;
  params: unknown;
}

/** Messages on the WebSocket, plugin → server. */
export type PluginMessage =
  | { type: "hello"; info: PluginHello }
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

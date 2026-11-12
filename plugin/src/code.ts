// Main thread of the Figma MCP Bridge plugin. It runs inside Figma's plugin
// sandbox, which has the `figma` API but no network access. The UI iframe
// (ui.html) owns the WebSocket and relays messages to and from this file.

const PLUGIN_VERSION = "0.1.1";
const MAX_CHILDREN = 200;
const MAX_TEXT_CHARS = 2000;
const MAX_LOG_LINES = 200;
const EXPORT_LIMIT_MS = 45000;
const EXPORT_LIMIT_HIDDEN_MS = 8000;

/**
 * Figma stops rendering while its window is minimized or fully covered, and
 * `exportAsync` then never settles. The UI iframe reports page visibility so
 * exports can fail quickly with an explanation instead of hanging.
 */
let windowHidden = false;
const HIDDEN_WINDOW_HELP =
  "Figma pauses rendering while its window is minimized or completely covered by other windows. " +
  "Ask the user to keep the Figma window visible on screen (for example next to the terminal), then try again.";

type Json = Record<string, unknown>;

interface CommandMessage {
  type: "command";
  id: string;
  command: string;
  params?: Json;
}

figma.showUI(__html__, { width: 300, height: 240, themeColors: true });

function toServer(payload: unknown): void {
  figma.ui.postMessage({ type: "to-server", payload });
}

function sendHello(): void {
  toServer({
    type: "hello",
    info: {
      fileName: figma.root.name,
      pageName: figma.currentPage.name,
      editorType: figma.editorType,
      pluginVersion: PLUGIN_VERSION,
    },
  });
}

figma.on("currentpagechange", sendHello);

figma.ui.onmessage = async (msg: any) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ws-open") sendHello();
  else if (msg.type === "visibility") windowHidden = msg.hidden === true;
  else if (msg.type === "command") await handleCommand(msg as CommandMessage);
};

async function handleCommand(msg: CommandMessage): Promise<void> {
  try {
    const handler = handlers[msg.command];
    if (!handler) throw new Error(`Unknown command: ${msg.command}`);
    const result = await handler(msg.params || {});
    toServer({ id: msg.id, ok: true, result });
  } catch (err) {
    toServer({ id: msg.id, ok: false, error: errorMessage(err) });
  }
}

const handlers: Record<string, (params: any) => Promise<unknown>> = {
  get_status: async () => ({
    fileName: figma.root.name,
    editorType: figma.editorType,
    pluginVersion: PLUGIN_VERSION,
    // export_node only works while this is true.
    figmaWindowVisible: !windowHidden,
    currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
    selection: figma.currentPage.selection.map(summarize),
  }),

  get_document_info: async () => {
    const children = figma.currentPage.children;
    return {
      fileName: figma.root.name,
      currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
      pages: figma.root.children.map((page) => ({ id: page.id, name: page.name })),
      topLevelNodeCount: children.length,
      topLevelNodes: children.slice(0, MAX_CHILDREN).map(summarize),
    };
  },

  get_selection: async (params) => {
    const nodes = [];
    for (const node of figma.currentPage.selection) nodes.push(await serializeNode(node, depthOf(params)));
    return nodes;
  },

  get_node: async (params) => serializeNode(await requireNode(params.nodeId), depthOf(params)),

  get_styles: getStyles,
  export_node: exportNode,
  execute_code: executeCode,
};

// ---------------------------------------------------------------- helpers

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

function depthOf(params: any): number {
  const depth = Number(params && params.depth);
  return Number.isFinite(depth) ? Math.max(0, Math.min(10, Math.floor(depth))) : 2;
}

function round(value: number, digits = 2): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/** Numeric properties that can hold `figma.mixed` (a symbol, which JSON cannot carry). */
function orMixed(value: unknown): unknown {
  if (value === figma.mixed) return "mixed";
  return typeof value === "number" ? round(value) : value;
}

/** Some properties throw on certain node types instead of being absent. */
function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (_) {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function requireNode(nodeId: unknown): Promise<BaseNode> {
  if (typeof nodeId !== "string" || !nodeId) throw new Error("nodeId is required");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`No node with id "${nodeId}" exists in this file`);
  return node;
}

function channelToHex(channel: number): string {
  const value = Math.max(0, Math.min(255, Math.round(channel * 255)));
  return (value < 16 ? "0" : "") + value.toString(16).toUpperCase();
}

function colorToHex(color: { r: number; g: number; b: number; a?: number }): string {
  const hex = "#" + channelToHex(color.r) + channelToHex(color.g) + channelToHex(color.b);
  return color.a !== undefined && color.a < 1 ? hex + channelToHex(color.a) : hex;
}

/** True for nodes, styles, variables and other live API objects (they all have `remove`). */
function isApiObject(value: any): boolean {
  return typeof value === "object" && value !== null && typeof value.id === "string" && typeof value.remove === "function";
}

/** Short description of a node or other API object. */
function summarize(value: any): Json {
  try {
    const out: Json = { id: value.id, name: value.name };
    if (typeof value.type === "string") out.type = value.type;
    if (typeof value.resolvedType === "string") out.resolvedType = value.resolvedType;
    if (typeof value.x === "number") {
      out.x = round(value.x);
      out.y = round(value.y);
    }
    if (typeof value.width === "number") {
      out.width = round(value.width);
      out.height = round(value.height);
    }
    return out;
  } catch (_) {
    // Reading a property of a node that was removed throws.
    return { removed: true };
  }
}

// ---------------------------------------------------------- serialization

function serializePaint(paint: Paint): Json {
  const out: Json = { type: paint.type };
  if (paint.visible === false) out.visible = false;
  if (paint.opacity !== undefined && paint.opacity !== 1) out.opacity = round(paint.opacity);
  if (paint.type === "SOLID") {
    out.color = colorToHex(paint.color);
    const bound = paint.boundVariables && paint.boundVariables.color;
    if (bound) out.colorVariable = bound.id;
  } else if (
    paint.type === "GRADIENT_LINEAR" ||
    paint.type === "GRADIENT_RADIAL" ||
    paint.type === "GRADIENT_ANGULAR" ||
    paint.type === "GRADIENT_DIAMOND"
  ) {
    out.stops = paint.gradientStops.map((stop) => ({ position: round(stop.position), color: colorToHex(stop.color) }));
  } else if (paint.type === "IMAGE") {
    out.scaleMode = paint.scaleMode;
    out.imageHash = paint.imageHash;
  }
  return out;
}

function serializePaints(paints: unknown): unknown {
  if (paints === figma.mixed) return "mixed";
  return Array.isArray(paints) ? paints.map(serializePaint) : undefined;
}

function serializeEffect(effect: Effect): Json {
  const e = effect as any;
  const out: Json = { type: effect.type };
  if (e.visible === false) out.visible = false;
  if (typeof e.radius === "number") out.radius = round(e.radius);
  if (typeof e.spread === "number" && e.spread !== 0) out.spread = round(e.spread);
  if (e.offset) out.offset = { x: round(e.offset.x), y: round(e.offset.y) };
  if (e.color) out.color = colorToHex(e.color);
  return out;
}

/** Variable bindings reduced to `{ property: variableId }`. */
function serializeBoundVariables(bound: any): Json | undefined {
  if (!bound) return undefined;
  const out: Json = {};
  for (const key of Object.keys(bound)) {
    const value = bound[key];
    if (Array.isArray(value)) out[key] = value.map((alias) => alias && alias.id);
    else if (value && typeof value.id === "string") out[key] = value.id;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Describe a node using Plugin API property names, leaving out defaults so
 * that large trees stay readable.
 */
async function serializeNode(node: BaseNode, depth: number): Promise<Json> {
  const n = node as any;
  const out: Json = { id: node.id, name: node.name, type: node.type };

  if (n.visible === false) out.visible = false;
  if (n.locked === true) out.locked = true;
  if (typeof n.x === "number") {
    out.x = round(n.x);
    out.y = round(n.y);
  }
  if (typeof n.width === "number") {
    out.width = round(n.width);
    out.height = round(n.height);
  }
  if (typeof n.rotation === "number" && n.rotation !== 0) out.rotation = round(n.rotation);
  if (typeof n.opacity === "number" && n.opacity !== 1) out.opacity = round(n.opacity);

  if ("fills" in n) {
    const fills = serializePaints(n.fills);
    if (fills === "mixed" || (Array.isArray(fills) && fills.length > 0)) out.fills = fills;
  }
  if ("strokes" in n && Array.isArray(n.strokes) && n.strokes.length > 0) {
    out.strokes = serializePaints(n.strokes);
    out.strokeWeight = orMixed(n.strokeWeight);
    out.strokeAlign = n.strokeAlign;
  }
  if ("cornerRadius" in n) {
    if (n.cornerRadius === figma.mixed) {
      out.cornerRadius = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
    } else if (n.cornerRadius) {
      out.cornerRadius = round(n.cornerRadius);
    }
  }
  if ("effects" in n && Array.isArray(n.effects) && n.effects.length > 0) {
    out.effects = n.effects.map(serializeEffect);
  }
  if (n.clipsContent === true && node.type !== "COMPONENT_SET") out.clipsContent = true;

  for (const key of ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId"]) {
    const styleId = safe(() => n[key]);
    if (typeof styleId === "string" && styleId) out[key] = styleId;
    else if (styleId === figma.mixed) out[key] = "mixed";
  }
  const bound = serializeBoundVariables(safe(() => n.boundVariables));
  if (bound) out.boundVariables = bound;

  if ("layoutMode" in n && n.layoutMode !== "NONE") {
    out.layoutMode = n.layoutMode;
    if (n.layoutWrap === "WRAP") {
      out.layoutWrap = "WRAP";
      out.counterAxisSpacing = n.counterAxisSpacing;
    }
    out.itemSpacing = n.itemSpacing;
    for (const key of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) {
      if (n[key]) out[key] = n[key];
    }
    out.primaryAxisAlignItems = n.primaryAxisAlignItems;
    out.counterAxisAlignItems = n.counterAxisAlignItems;
  }
  for (const key of ["layoutSizingHorizontal", "layoutSizingVertical"]) {
    const sizing = safe(() => n[key]);
    if (sizing && sizing !== "FIXED") out[key] = sizing;
  }
  if (n.layoutPositioning === "ABSOLUTE") out.layoutPositioning = "ABSOLUTE";

  if (node.type === "TEXT") {
    const characters = node.characters;
    out.characters = characters.length > MAX_TEXT_CHARS ? characters.slice(0, MAX_TEXT_CHARS) + "…" : characters;
    out.fontName = orMixed(node.fontName);
    out.fontSize = orMixed(node.fontSize);
    out.lineHeight = orMixed(node.lineHeight);
    if (node.letterSpacing === figma.mixed) out.letterSpacing = "mixed";
    else if (node.letterSpacing.value !== 0) out.letterSpacing = node.letterSpacing;
    out.textAlignHorizontal = node.textAlignHorizontal;
    out.textAutoResize = node.textAutoResize;
  }

  if (node.type === "INSTANCE") {
    try {
      const main = await node.getMainComponentAsync();
      if (main) {
        const parent = main.parent;
        out.mainComponent = {
          id: main.id,
          name: main.name,
          key: main.key,
          remote: main.remote || undefined,
          componentSet: parent && parent.type === "COMPONENT_SET" ? parent.name : undefined,
        };
      }
    } catch (_) {
      // The main component can be missing (deleted library component).
    }
    const properties = safe(() => node.componentProperties);
    if (properties && Object.keys(properties).length > 0) {
      const values: Json = {};
      for (const key of Object.keys(properties)) values[key] = properties[key].value;
      out.componentProperties = values;
    }
  }

  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    out.key = node.key;
    if (node.description) out.description = node.description;
    // Throws on a variant inside a component set; the set itself carries the definitions.
    const definitions = safe(() => node.componentPropertyDefinitions);
    if (definitions && Object.keys(definitions).length > 0) {
      const defs: Json = {};
      for (const key of Object.keys(definitions)) {
        const def = definitions[key];
        defs[key] = { type: def.type, defaultValue: def.defaultValue, variantOptions: def.variantOptions };
      }
      out.componentPropertyDefinitions = defs;
    }
  }

  if ("children" in n) {
    // Pages other than the current one are not loaded until asked for.
    if (node.type === "PAGE" && depth > 0) await node.loadAsync();
    const children = safe(() => n.children as ReadonlyArray<SceneNode>);
    if (children && depth > 0) {
      const serialized = [];
      for (const child of children.slice(0, MAX_CHILDREN)) serialized.push(await serializeNode(child, depth - 1));
      out.children = serialized;
      if (children.length > MAX_CHILDREN) out.childrenOmitted = children.length - MAX_CHILDREN;
    } else if (children && children.length > 0) {
      out.childCount = children.length;
    }
  }

  return out;
}

/**
 * Convert whatever agent code returned (or logged) into plain JSON. Live API
 * objects become short summaries; `figma.mixed` becomes the string "mixed".
 */
function toPlain(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (value === figma.mixed) return "mixed";
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "function":
      return "[function]";
    case "object":
      break;
    default:
      return String(value);
  }
  if (isApiObject(value)) return summarize(value);
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (value instanceof Error) return { error: value.message };
  if (depth >= 8) return "[nested too deeply]";
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => toPlain(item, depth + 1));
  const out: Json = {};
  for (const key of Object.keys(value as object)) out[key] = toPlain((value as Json)[key], depth + 1);
  return out;
}

// ------------------------------------------------------- command handlers

function serializeVariableValue(value: any): unknown {
  if (value && typeof value === "object") {
    if (value.type === "VARIABLE_ALIAS") return { alias: value.id };
    if (typeof value.r === "number") return colorToHex(value);
  }
  return value;
}

async function getStyles(params: any): Promise<Json> {
  const paintStyles = await figma.getLocalPaintStylesAsync();
  const textStyles = await figma.getLocalTextStylesAsync();
  const effectStyles = await figma.getLocalEffectStylesAsync();

  const out: Json = {
    paintStyles: paintStyles.map((style) => ({ id: style.id, name: style.name, paints: serializePaints(style.paints) })),
    textStyles: textStyles.map((style) => ({
      id: style.id,
      name: style.name,
      fontName: style.fontName,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing.value !== 0 ? style.letterSpacing : undefined,
    })),
    effectStyles: effectStyles.map((style) => ({
      id: style.id,
      name: style.name,
      effects: style.effects.map(serializeEffect),
    })),
  };

  if (params.includeVariables !== false) {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync();
    out.variableCollections = collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      modes: collection.modes,
      variables: variables
        .filter((variable) => variable.variableCollectionId === collection.id)
        .map((variable) => {
          const valuesByMode: Json = {};
          for (const modeId of Object.keys(variable.valuesByMode)) {
            valuesByMode[modeId] = serializeVariableValue(variable.valuesByMode[modeId]);
          }
          return { id: variable.id, name: variable.name, type: variable.resolvedType, valuesByMode };
        }),
    }));
  }
  return out;
}

/** Size of everything on a page, which has no width or height of its own. */
function pageBounds(page: PageNode): { width: number; height: number } | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const child of page.children) {
    const box = ("absoluteRenderBounds" in child && child.absoluteRenderBounds) || child.absoluteBoundingBox;
    if (!box) continue;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return minX === Infinity ? undefined : { width: maxX - minX, height: maxY - minY };
}

async function exportNode(params: any): Promise<Json> {
  let node: BaseNode | undefined;
  if (params.nodeId) node = await requireNode(params.nodeId);
  else node = figma.currentPage.selection[0];
  if (!node) throw new Error("Nothing is selected in Figma. Pass a nodeId, or ask the user to select a node.");
  if (node.type === "DOCUMENT") throw new Error("The document itself cannot be exported. Export a page or a node.");

  let size: { width: number; height: number } | undefined;
  if (node.type === "PAGE") {
    await node.loadAsync();
    size = pageBounds(node);
    if (!size) throw new Error(`Page "${node.name}" is empty, so there is nothing to export.`);
  } else if (typeof (node as any).width === "number") {
    size = { width: (node as any).width, height: (node as any).height };
  }

  const requested = Number(params.scale);
  let scale = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 4) : 1;
  const maxSize = Number(params.maxSize) > 0 ? Number(params.maxSize) : 1600;
  if (size) {
    const longest = Math.max(size.width, size.height) * scale;
    if (longest > maxSize) scale = (scale * maxSize) / longest;
  }

  const exportedNode = node;
  const hiddenAtStart = windowHidden;
  const limitMs = hiddenAtStart ? EXPORT_LIMIT_HIDDEN_MS : EXPORT_LIMIT_MS;
  const bytes = await withTimeout(
    (node as SceneNode).exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } }),
    limitMs,
    () =>
      new Error(
        `Figma did not finish rendering "${exportedNode.name}" within ${limitMs / 1000} s. ` +
          (hiddenAtStart || windowHidden
            ? "The Figma window is currently hidden. " + HIDDEN_WINDOW_HELP
            : "If the node is very large, lower the scale or export a smaller node. Otherwise: " + HIDDEN_WINDOW_HELP),
      ),
  );
  return {
    nodeId: node.id,
    name: node.name,
    width: size ? round(size.width) : undefined,
    height: size ? round(size.height) : undefined,
    scale: round(scale, 3),
    mimeType: "image/png",
    base64: figma.base64Encode(bytes),
  };
}

/** `console` replacement handed to agent code so its output travels back with the result. */
function captureConsole(logs: string[]): Json {
  const method = (level: string) => (...args: unknown[]) => {
    if (logs.length >= MAX_LOG_LINES) return;
    const text = args
      .map((arg) => (typeof arg === "string" ? arg : safe(() => JSON.stringify(toPlain(arg))) || String(arg)))
      .join(" ");
    const line = (level === "log" ? "" : `[${level}] `) + text;
    logs.push(line.length > MAX_TEXT_CHARS ? line.slice(0, MAX_TEXT_CHARS) + "…" : line);
  };
  return { log: method("log"), info: method("info"), warn: method("warn"), error: method("error"), debug: method("debug") };
}

/**
 * `params.compiled` is produced by the MCP server and defines
 * `__figmaBridgeMain`, an async function taking `(figma, console)`.
 */
function loadSnippet(compiled: string): (api: PluginAPI, console: Json) => Promise<unknown> {
  const source = compiled + "\nreturn __figmaBridgeMain;";
  try {
    return new Function(source)();
  } catch (err) {
    if (err instanceof SyntaxError) throw err;
    // Fall back to indirect eval in case the sandbox does not expose the Function constructor.
    return (0, eval)("(function () {" + source + "\n})()");
  }
}

async function executeCode(params: any): Promise<Json> {
  if (typeof params.compiled !== "string") throw new Error("No code was provided");
  const logs: string[] = [];
  try {
    const main = loadSnippet(params.compiled);
    const result = await main(figma, captureConsole(logs));
    const out: Json = { result: toPlain(result) };
    if (logs.length > 0) out.logs = logs;
    return out;
  } catch (err) {
    let message = errorMessage(err);
    if (logs.length > 0) message += "\nconsole output before the error:\n" + logs.join("\n");
    throw new Error(message);
  } finally {
    // Makes each agent call its own undo step in Figma.
    figma.commitUndo();
  }
}

// Main thread of the Figma MCP Bridge plugin. It runs inside Figma's plugin
// sandbox, which has the `figma` API but no network access. The UI iframe
// (ui.html) owns the WebSocket and relays messages to and from this file.

import { BUILD_TIMEOUT_MS, PLUGIN_VERSION, type CommandMessage, type CommandName, type CommandParams } from "../../src/protocol";
import { buildDesign, describeCreated, updateNodes } from "./builder";
import { executeCode } from "./execute";
import { exportNode, findNodeIn, isWindowHidden, screenshotOf, setWindowHidden, topLevelOf } from "./export";
import { placeImage } from "./images";
import { getComponents, libraryVariables, librarySnapshot } from "./library";
import { runMutation } from "./mutation";
import { MAX_CHILDREN, serializeEffect, serializeNode, serializePaints, serializeVariableValue, summarize } from "./serialize";
import { clampDepth, errorMessage, requireNode, type Json } from "./util";

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
  else if (msg.type === "visibility") setWindowHidden(msg.hidden === true);
  else if (msg.type === "command") await handleCommand(msg as CommandMessage);
};

type Handlers = { [K in CommandName]: (params: CommandParams[K]) => Promise<unknown> };

const handlers: Handlers = {
  get_status: async () => ({
    fileName: figma.root.name,
    editorType: figma.editorType,
    pluginVersion: PLUGIN_VERSION,
    // export_node only works while this is true.
    figmaWindowVisible: !isWindowHidden(),
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
    for (const node of figma.currentPage.selection) nodes.push(await serializeNode(node, clampDepth(params.depth)));
    return nodes;
  },

  get_node: async (params) => serializeNode(await requireNode(params.nodeId), clampDepth(params.depth)),
  get_styles: getStyles,
  get_components: getComponents,
  library_snapshot: librarySnapshot,
  export_node: exportNode,

  // Commands that change the document go through runMutation: one at a time,
  // one undo step each, rolled back on failure.
  execute_code: async (params) => {
    const outcome = await runMutation(() => executeCode(params), params.timeoutMs);
    if (params.screenshot) {
      const node = findNodeIn(outcome.raw) || figma.currentPage.selection[0];
      outcome.json.screenshot = await screenshotOf(node && topLevelOf(node));
    }
    return outcome.json;
  },

  save_checkpoint: (params) => runMutation(() => saveCheckpoint(params), 60000),

  build_design: async (params) => {
    const built = await runMutation(async () => {
      const result = await buildDesign(params);
      // Show new top-level designs to the user.
      if (result.root.parent === figma.currentPage) {
        figma.currentPage.selection = [result.root];
        figma.viewport.scrollAndZoomIntoView([result.root]);
      }
      return result;
    }, BUILD_TIMEOUT_MS);
    const out: Json = { root: summarize(built.root), ...describeCreated(built) };
    if (params.screenshot) out.screenshot = await screenshotOf(topLevelOf(built.root));
    return out;
  },

  update_nodes: async (params) => {
    const nodes = await runMutation(() => updateNodes(params.updates), BUILD_TIMEOUT_MS);
    const out: Json = { updated: nodes.map(summarize) };
    if (params.screenshot) out.screenshot = await screenshotOf(topLevelOf(nodes[0]));
    return out;
  },

  place_image: async (params) => {
    const placed = await runMutation(() => placeImage(params), BUILD_TIMEOUT_MS);
    if (params.screenshot) placed.json.screenshot = await screenshotOf(topLevelOf(placed.node));
    return placed.json;
  },
};

async function saveCheckpoint(params: CommandParams["save_checkpoint"]): Promise<Json> {
  // Figma's docs: changes made right before saving may be missing from the
  // version unless it waits a moment.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const version = await figma.saveVersionHistoryAsync(params.title, params.description);
  return {
    versionId: version.id,
    title: params.title,
    hint: "Restore it from File → Show version history in Figma if needed.",
  };
}

async function handleCommand(msg: CommandMessage): Promise<void> {
  try {
    if (!Object.prototype.hasOwnProperty.call(handlers, msg.command)) {
      throw new Error(`Unknown command: ${msg.command}`);
    }
    const handler = handlers[msg.command as CommandName] as (params: unknown) => Promise<unknown>;
    const result = await handler(msg.params || {});
    toServer({ id: msg.id, ok: true, result });
  } catch (err) {
    toServer({ id: msg.id, ok: false, error: errorMessage(err) });
  }
}

async function getStyles(params: CommandParams["get_styles"]): Promise<Json> {
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
  if (params.includeLibraries) out.libraryVariables = await libraryVariables();
  return out;
}

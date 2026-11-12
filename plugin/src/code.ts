// Main thread of the Figma MCP Bridge plugin. It runs inside Figma's plugin
// sandbox, which has the `figma` API but no network access. The UI iframe
// (ui.html) owns the WebSocket and relays messages to and from this file.

import { PLUGIN_VERSION, type CommandMessage, type CommandName, type CommandParams } from "../../src/protocol";
import { executeCode } from "./execute";
import { exportNode, isWindowHidden, setWindowHidden } from "./export";
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
  export_node: exportNode,
  execute_code: executeCode,
};

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
  return out;
}

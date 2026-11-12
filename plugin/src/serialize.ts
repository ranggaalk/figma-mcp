// Turning live Figma objects into plain JSON for the agent.

import { colorToHex, isApiObject, orMixed, round, safe, type Json } from "./util";

export const MAX_CHILDREN = 200;
export const MAX_TEXT_CHARS = 2000;

/** Short description of a node or other API object. */
export function summarize(value: any): Json {
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

export function serializePaint(paint: Paint): Json {
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

export function serializePaints(paints: unknown): unknown {
  if (paints === figma.mixed) return "mixed";
  return Array.isArray(paints) ? paints.map(serializePaint) : undefined;
}

export function serializeEffect(effect: Effect): Json {
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
export function serializeBoundVariables(bound: any): Json | undefined {
  if (!bound) return undefined;
  const out: Json = {};
  for (const key of Object.keys(bound)) {
    const value = bound[key];
    if (Array.isArray(value)) out[key] = value.map((alias) => alias && alias.id);
    else if (value && typeof value.id === "string") out[key] = value.id;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function serializeVariableValue(value: any): unknown {
  if (value && typeof value === "object") {
    if (value.type === "VARIABLE_ALIAS") return { alias: value.id };
    if (typeof value.r === "number") return colorToHex(value);
  }
  return value;
}

/** Component property definitions reduced to `{ name: { type, defaultValue, variantOptions } }`. */
export function serializePropertyDefinitions(node: ComponentNode | ComponentSetNode): Json | undefined {
  // Throws on a variant inside a component set; the set itself carries the definitions.
  const definitions = safe(() => node.componentPropertyDefinitions);
  if (!definitions || Object.keys(definitions).length === 0) return undefined;
  const out: Json = {};
  for (const key of Object.keys(definitions)) {
    const def = definitions[key];
    out[key] = { type: def.type, defaultValue: def.defaultValue, variantOptions: def.variantOptions };
  }
  return out;
}

/**
 * Describe a node using Plugin API property names, leaving out defaults so
 * that large trees stay readable.
 */
export async function serializeNode(node: BaseNode, depth: number): Promise<Json> {
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
    const definitions = serializePropertyDefinitions(node);
    if (definitions) out.componentPropertyDefinitions = definitions;
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
export function toPlain(value: unknown, depth = 0): unknown {
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

// Declarative builder behind build_design, update_nodes and the `h` helpers.
//
// Work happens in two passes. The plan pass checks the whole spec and
// resolves everything it refers to (fonts, …) without touching the document,
// so a mistake anywhere is reported with its path before any node exists.
// The build pass then creates or changes nodes in the order Figma requires.

import {
  checkWeight,
  fontRequestKey,
  fontsOfTextNode,
  isItalicStyle,
  loadFonts,
  resolveFont,
  weightOfStyle,
  type FontRequest,
} from "./fonts";
import { parseColor, shadowEffect, solid, SHADOW_KEYS, type ShadowSpec } from "./paint";
import { errorMessage, safe, type Json } from "./util";

export class SpecError extends Error {}

function fail(path: string, message: string): never {
  throw new SpecError(`${path}: ${message}`);
}

type Size = number | "fill" | "hug";
type Layout = "VERTICAL" | "HORIZONTAL" | "NONE";
type Kind = "frame" | "component" | "text" | "rect" | "ellipse" | "line" | "svg" | "shape" | "group" | "instance";

// ------------------------------------------------------------------ keys

const COMMON_KEYS = ["name", "width", "height", "x", "y", "absolute", "opacity", "visible"];
const BOX_KEYS = ["fill", "stroke", "strokeWeight", "radius", "shadow"];
const FRAME_KEYS = ["layout", "gap", "padding", "align", "crossAlign", "wrap", "rowGap", "clip"];
const TEXT_KEYS = ["text", "spans", "font", "weight", "italic", "size", "color", "lineHeight", "letterSpacing", "align", "decoration"];
const SPAN_KEYS = ["text", "font", "weight", "italic", "size", "color", "decoration"];
const without = (keys: string[], ...removed: string[]) => keys.filter((key) => removed.indexOf(key) === -1);

/** Keys a spec may use when creating each type of node. */
const SPEC_KEYS: Record<string, string[]> = {
  frame: ["type", ...COMMON_KEYS, ...BOX_KEYS, ...FRAME_KEYS, "children"],
  component: ["type", ...COMMON_KEYS, ...BOX_KEYS, ...FRAME_KEYS, "children"],
  text: ["type", ...COMMON_KEYS, ...TEXT_KEYS],
  rect: ["type", ...COMMON_KEYS, ...BOX_KEYS],
  ellipse: ["type", ...without(COMMON_KEYS), ...without(BOX_KEYS, "radius")],
  line: ["type", ...COMMON_KEYS, ...without(BOX_KEYS, "radius")],
  svg: ["type", ...COMMON_KEYS, "svg", "color"],
};

/** Keys update_nodes accepts for each kind of existing node. */
const UPDATE_KEYS: Record<Kind, string[]> = {
  frame: [...COMMON_KEYS, ...BOX_KEYS, ...FRAME_KEYS],
  component: [...COMMON_KEYS, ...BOX_KEYS, ...FRAME_KEYS],
  instance: [...COMMON_KEYS, ...BOX_KEYS, ...FRAME_KEYS],
  text: [...COMMON_KEYS, ...TEXT_KEYS],
  rect: [...COMMON_KEYS, ...BOX_KEYS],
  ellipse: [...COMMON_KEYS, ...without(BOX_KEYS, "radius")],
  line: [...COMMON_KEYS, ...without(BOX_KEYS, "radius")],
  shape: [...COMMON_KEYS, ...without(BOX_KEYS, "radius")],
  svg: [...COMMON_KEYS],
  group: without(COMMON_KEYS, "width", "height"),
};

function kindOfNode(node: BaseNode): Kind | undefined {
  switch (node.type) {
    case "FRAME":
    case "COMPONENT_SET":
      return "frame";
    case "COMPONENT":
      return "component";
    case "INSTANCE":
      return "instance";
    case "TEXT":
      return "text";
    case "RECTANGLE":
      return "rect";
    case "ELLIPSE":
      return "ellipse";
    case "LINE":
    case "VECTOR":
    case "POLYGON":
    case "STAR":
    case "BOOLEAN_OPERATION":
      return "shape";
    case "GROUP":
    case "SECTION":
      return "group";
    default:
      return undefined;
  }
}

// ------------------------------------------------------------ validation

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

function closest(word: string, options: string[]): string | undefined {
  const lower = word.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const option of options) {
    const score = editDistance(lower, option.toLowerCase());
    if (score < bestScore) {
      best = option;
      bestScore = score;
    }
  }
  return bestScore <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

const SYNONYMS: Record<string, string> = {
  background: "fill",
  backgroundColor: "fill",
  bg: "fill",
  border: "stroke",
  borderColor: "stroke",
  borderWidth: "strokeWeight",
  borderRadius: "radius",
  cornerRadius: "radius",
  fontSize: "size",
  fontWeight: "weight",
  fontFamily: "font",
  characters: "text",
  content: "text",
  itemSpacing: "gap",
  spacing: "gap",
  direction: "layout",
  layoutMode: "layout",
  justify: "align",
  justifyContent: "align",
  alignItems: "crossAlign",
  fills: "fill",
  textColor: "color",
  textAlign: "align",
  boxShadow: "shadow",
};

function checkKeys(object: Record<string, unknown>, allowed: string[], path: string, what: string): void {
  for (const key of Object.keys(object)) {
    if (allowed.indexOf(key) !== -1) continue;
    const synonym = SYNONYMS[key];
    const hint = synonym && allowed.indexOf(synonym) !== -1 ? synonym : closest(key, allowed);
    fail(
      `${path}.${key}`,
      `unknown property for ${what}` + (hint ? ` (did you mean "${hint}"?)` : "") + `. Allowed: ${allowed.join(", ")}`,
    );
  }
}

function number(value: unknown, path: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, `must be a number, got ${JSON.stringify(value)}`);
  if (value < min || value > max) fail(path, `must be between ${min} and ${max}, got ${value}`);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, `must be true or false, got ${JSON.stringify(value)}`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, `must be a string, got ${JSON.stringify(value)}`);
  return value;
}

function oneOf<T extends string>(value: unknown, options: Record<string, T>, path: string): T {
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(options, value)) {
    fail(path, `must be one of ${Object.keys(options).map((o) => JSON.stringify(o)).join(", ")}, got ${JSON.stringify(value)}`);
  }
  return options[value];
}

function paints(value: unknown, path: string): Paint[] {
  if (value === null || value === "none") return [];
  if (typeof value !== "string") fail(path, 'must be a color string such as "#1E293B", or null for none');
  try {
    return [solid(parseColor(value))];
  } catch (err) {
    fail(path, errorMessage(err));
  }
}

const LAYOUTS: Record<string, Layout> = { vertical: "VERTICAL", horizontal: "HORIZONTAL", none: "NONE" };
const ALIGN: Record<string, "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN"> = {
  start: "MIN",
  center: "CENTER",
  end: "MAX",
  "space-between": "SPACE_BETWEEN",
};
const CROSS_ALIGN: Record<string, "MIN" | "CENTER" | "MAX" | "BASELINE"> = {
  start: "MIN",
  center: "CENTER",
  end: "MAX",
  baseline: "BASELINE",
};
const TEXT_ALIGN: Record<string, "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED"> = {
  left: "LEFT",
  center: "CENTER",
  right: "RIGHT",
  justified: "JUSTIFIED",
};
const DECORATION: Record<string, "NONE" | "UNDERLINE" | "STRIKETHROUGH"> = {
  none: "NONE",
  underline: "UNDERLINE",
  strikethrough: "STRIKETHROUGH",
};

function lineHeight(value: unknown, path: string): LineHeight {
  if (value === "auto") return { unit: "AUTO" };
  if (typeof value === "string" && /^\d+(\.\d+)?%$/.test(value)) return { unit: "PERCENT", value: parseFloat(value) };
  if (typeof value === "number" && value > 0) {
    // CSS habit: 1.5 means 150%.
    return value <= 3 ? { unit: "PERCENT", value: Math.round(value * 1000) / 10 } : { unit: "PIXELS", value };
  }
  fail(path, 'must be pixels (24), a multiplier up to 3 (1.5), a percentage ("150%") or "auto"');
}

function letterSpacing(value: unknown, path: string): LetterSpacing {
  if (typeof value === "number" && Number.isFinite(value)) return { unit: "PIXELS", value };
  if (typeof value === "string" && /^-?\d+(\.\d+)?%$/.test(value)) return { unit: "PERCENT", value: parseFloat(value) };
  fail(path, 'must be pixels (0.5) or a percentage ("-2%")');
}

// ----------------------------------------------------------------- plans

/** Fonts and other things a spec refers to, resolved before anything is built. */
class Resources {
  private readonly fontRequests: Record<string, { request: FontRequest; path: string }> = {};
  private readonly fonts: Record<string, FontName> = {};
  /** Fonts already used by text that is about to change; they must be loaded too. */
  readonly existingFonts: FontName[] = [];

  requestFont(request: FontRequest, path: string): string {
    const key = fontRequestKey(request);
    if (!this.fontRequests[key]) this.fontRequests[key] = { request, path };
    return key;
  }

  font(key: string): FontName {
    return this.fonts[key];
  }

  async resolve(): Promise<void> {
    for (const key of Object.keys(this.fontRequests)) {
      const { request, path } = this.fontRequests[key];
      try {
        this.fonts[key] = await resolveFont(request);
      } catch (err) {
        fail(path, errorMessage(err));
      }
    }
    const all = Object.keys(this.fonts).map((key) => this.fonts[key]);
    await loadFonts(all.concat(this.existingFonts));
  }
}

interface SpanPlan {
  length: number;
  font?: string;
  size?: number;
  fills?: Paint[];
  decoration?: TextDecoration;
}

interface TextPlan {
  characters?: string;
  spans?: SpanPlan[];
  font?: string;
  size?: number;
  fills?: Paint[];
  lineHeight?: LineHeight;
  letterSpacing?: LetterSpacing;
  align?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  decoration?: TextDecoration;
}

interface Plan {
  path: string;
  kind: Kind;
  name?: string;
  width?: Size;
  height?: Size;
  x?: number;
  y?: number;
  absolute?: boolean;
  opacity?: number;
  visible?: boolean;
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  radius?: number | [number, number, number, number];
  effects?: Effect[];
  layout?: Layout;
  gap?: number;
  padding?: [number, number, number, number];
  align?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  crossAlign?: "MIN" | "CENTER" | "MAX" | "BASELINE";
  wrap?: boolean;
  rowGap?: number;
  clip?: boolean;
  text?: TextPlan;
  svg?: string;
  svgFills?: Paint[];
  children?: Plan[];
}

interface Context {
  /** Layout of the parent the node goes into; NONE for pages and plain frames. */
  parentLayout: Layout;
  /** True when building a new node, false when updating an existing one. */
  creating: boolean;
  /** The node being updated, when updating. */
  existing?: SceneNode;
  resources: Resources;
}

function planCommon(spec: Record<string, any>, plan: Plan, ctx: Context): void {
  const { path } = plan;
  if (spec.name !== undefined) plan.name = string(spec.name, `${path}.name`);
  if (spec.opacity !== undefined) plan.opacity = number(spec.opacity, `${path}.opacity`, 0, 1);
  if (spec.visible !== undefined) plan.visible = boolean(spec.visible, `${path}.visible`);
  if (spec.absolute !== undefined) {
    plan.absolute = boolean(spec.absolute, `${path}.absolute`);
    if (plan.absolute && ctx.parentLayout === "NONE") {
      fail(`${path}.absolute`, "only applies inside a parent with auto layout; elsewhere x and y already position the node");
    }
  }
  const absolute =
    plan.absolute !== undefined ? plan.absolute : ctx.existing ? safe(() => (ctx.existing as any).layoutPositioning) === "ABSOLUTE" : false;
  for (const axis of ["x", "y"] as const) {
    if (spec[axis] === undefined) continue;
    plan[axis] = number(spec[axis], `${path}.${axis}`);
    if (ctx.parentLayout !== "NONE" && !absolute) {
      fail(`${path}.${axis}`, "the parent has auto layout, which positions this node; set absolute: true to place it freely");
    }
  }
}

function planBox(spec: Record<string, any>, plan: Plan): void {
  const { path } = plan;
  if (spec.fill !== undefined) plan.fills = paints(spec.fill, `${path}.fill`);
  if (spec.stroke !== undefined) plan.strokes = paints(spec.stroke, `${path}.stroke`);
  if (spec.strokeWeight !== undefined) plan.strokeWeight = number(spec.strokeWeight, `${path}.strokeWeight`, 0, 1000);
  if (spec.radius !== undefined) {
    const radius = spec.radius;
    if (Array.isArray(radius)) {
      if (radius.length !== 4) fail(`${path}.radius`, "an array needs 4 values: [topLeft, topRight, bottomRight, bottomLeft]");
      plan.radius = radius.map((r, i) => number(r, `${path}.radius[${i}]`, 0)) as [number, number, number, number];
    } else {
      plan.radius = number(radius, `${path}.radius`, 0);
    }
  }
  if (spec.shadow !== undefined) {
    const list = spec.shadow === null ? [] : Array.isArray(spec.shadow) ? spec.shadow : [spec.shadow];
    plan.effects = list.map((shadow: unknown, i: number) => {
      const shadowPath = Array.isArray(spec.shadow) ? `${path}.shadow[${i}]` : `${path}.shadow`;
      if (!isObject(shadow)) fail(shadowPath, 'must be an object such as { "y": 4, "blur": 12, "color": "#0000001F" }');
      checkKeys(shadow, SHADOW_KEYS, shadowPath, "a shadow");
      for (const key of ["x", "y", "spread"]) if (shadow[key] !== undefined) number(shadow[key], `${shadowPath}.${key}`);
      if (shadow.blur !== undefined) number(shadow.blur, `${shadowPath}.blur`, 0);
      if (shadow.inner !== undefined) boolean(shadow.inner, `${shadowPath}.inner`);
      if (shadow.color !== undefined) paints(string(shadow.color, `${shadowPath}.color`), `${shadowPath}.color`);
      return shadowEffect(shadow as ShadowSpec);
    });
  }
}

function planFrame(spec: Record<string, any>, plan: Plan, ctx: Context): void {
  const { path } = plan;
  if (spec.layout !== undefined) plan.layout = oneOf(spec.layout, LAYOUTS, `${path}.layout`);
  else if (ctx.creating) plan.layout = "VERTICAL";
  const layout = plan.layout || (ctx.existing && (ctx.existing as FrameNode).layoutMode) || "NONE";
  const autoLayoutOnly = (key: string) => {
    if (layout === "NONE") fail(`${path}.${key}`, 'only applies with auto layout; set layout to "vertical" or "horizontal"');
  };

  if (spec.gap !== undefined) {
    autoLayoutOnly("gap");
    plan.gap = number(spec.gap, `${path}.gap`, 0);
  }
  if (spec.padding !== undefined) {
    autoLayoutOnly("padding");
    const p = spec.padding;
    const values = Array.isArray(p) ? p : [p];
    if ([1, 2, 4].indexOf(values.length) === -1) fail(`${path}.padding`, "must be a number, [vertical, horizontal] or [top, right, bottom, left]");
    const n = values.map((v: unknown, i: number) => number(v, Array.isArray(p) ? `${path}.padding[${i}]` : `${path}.padding`, 0));
    plan.padding = n.length === 1 ? [n[0], n[0], n[0], n[0]] : n.length === 2 ? [n[0], n[1], n[0], n[1]] : (n as [number, number, number, number]);
  }
  if (spec.align !== undefined) {
    autoLayoutOnly("align");
    plan.align = oneOf(spec.align, ALIGN, `${path}.align`);
  }
  if (spec.crossAlign !== undefined) {
    autoLayoutOnly("crossAlign");
    plan.crossAlign = oneOf(spec.crossAlign, CROSS_ALIGN, `${path}.crossAlign`);
    if (plan.crossAlign === "BASELINE" && layout !== "HORIZONTAL") fail(`${path}.crossAlign`, '"baseline" only applies to horizontal layouts');
  }
  if (spec.wrap !== undefined) {
    plan.wrap = boolean(spec.wrap, `${path}.wrap`);
    if (plan.wrap && layout !== "HORIZONTAL") fail(`${path}.wrap`, 'only applies to layout "horizontal"');
  }
  if (spec.rowGap !== undefined) {
    if (!plan.wrap && !(ctx.existing && (ctx.existing as FrameNode).layoutWrap === "WRAP")) fail(`${path}.rowGap`, "only applies with wrap: true");
    plan.rowGap = number(spec.rowGap, `${path}.rowGap`, 0);
  }
  if (spec.clip !== undefined) plan.clip = boolean(spec.clip, `${path}.clip`);
}

function planText(spec: Record<string, any>, plan: Plan, ctx: Context): void {
  const { path } = plan;
  const text: TextPlan = {};
  plan.text = text;

  if (spec.text !== undefined && spec.spans !== undefined) fail(path, 'use either "text" or "spans", not both');
  if (ctx.creating && spec.text === undefined && spec.spans === undefined) fail(path, 'a text node needs "text" (or "spans")');
  if (spec.text !== undefined) text.characters = string(spec.text, `${path}.text`);

  // Base font: when updating, unspecified parts come from the node's current font.
  let base: FontRequest = {};
  if (ctx.existing && ctx.existing.type === "TEXT") {
    const fonts = safe(() => (ctx.existing as TextNode).getRangeAllFontNames(0, Math.max(1, (ctx.existing as TextNode).characters.length)));
    const current = ctx.existing.fontName !== figma.mixed ? ctx.existing.fontName : fonts && fonts[0];
    if (current) {
      const weight = weightOfStyle(current.style);
      base = { family: current.family, weight: weight !== undefined ? weight : current.style, italic: isItalicStyle(current.style) };
    }
  }
  const fontChange = spec.font !== undefined || spec.weight !== undefined || spec.italic !== undefined;
  if (spec.font !== undefined) string(spec.font, `${path}.font`);
  if (spec.weight !== undefined) {
    const problem = checkWeight(spec.weight);
    if (problem) fail(`${path}.weight`, problem);
  }
  if (spec.italic !== undefined) boolean(spec.italic, `${path}.italic`);
  const baseRequest: FontRequest = {
    family: spec.font !== undefined ? spec.font : base.family,
    weight: spec.weight !== undefined ? spec.weight : base.weight,
    italic: spec.italic !== undefined ? spec.italic : base.italic,
  };
  if (ctx.creating || fontChange) text.font = ctx.resources.requestFont(baseRequest, path);

  if (spec.size !== undefined) text.size = number(spec.size, `${path}.size`, 1, 1000);
  else if (ctx.creating) text.size = 16;
  if (spec.color !== undefined) text.fills = paints(spec.color, `${path}.color`);
  if (spec.lineHeight !== undefined) text.lineHeight = lineHeight(spec.lineHeight, `${path}.lineHeight`);
  if (spec.letterSpacing !== undefined) text.letterSpacing = letterSpacing(spec.letterSpacing, `${path}.letterSpacing`);
  if (spec.align !== undefined) text.align = oneOf(spec.align, TEXT_ALIGN, `${path}.align`);
  if (spec.decoration !== undefined) text.decoration = oneOf(spec.decoration, DECORATION, `${path}.decoration`);

  if (spec.spans !== undefined) {
    if (!Array.isArray(spec.spans) || spec.spans.length === 0) fail(`${path}.spans`, 'must be a non-empty array of { "text": … }');
    let characters = "";
    text.spans = spec.spans.map((span: unknown, i: number) => {
      const spanPath = `${path}.spans[${i}]`;
      if (!isObject(span)) fail(spanPath, 'must be an object such as { "text": "Sign up", "weight": 600 }');
      checkKeys(span, SPAN_KEYS, spanPath, "a span");
      const value = string(span.text, `${spanPath}.text`);
      characters += value;
      const out: SpanPlan = { length: value.length };
      if (span.font !== undefined || span.weight !== undefined || span.italic !== undefined) {
        if (span.font !== undefined) string(span.font, `${spanPath}.font`);
        if (span.weight !== undefined) {
          const problem = checkWeight(span.weight);
          if (problem) fail(`${spanPath}.weight`, problem);
        }
        if (span.italic !== undefined) boolean(span.italic, `${spanPath}.italic`);
        out.font = ctx.resources.requestFont(
          {
            family: span.font !== undefined ? span.font : baseRequest.family,
            weight: span.weight !== undefined ? span.weight : baseRequest.weight,
            italic: span.italic !== undefined ? span.italic : baseRequest.italic,
          },
          spanPath,
        );
      }
      if (span.size !== undefined) out.size = number(span.size, `${spanPath}.size`, 1, 1000);
      if (span.color !== undefined) out.fills = paints(span.color, `${spanPath}.color`);
      if (span.decoration !== undefined) out.decoration = oneOf(span.decoration, DECORATION, `${spanPath}.decoration`);
      return out;
    });
    text.characters = characters;
  }

  if (ctx.existing && ctx.existing.type === "TEXT") {
    const touchesText = Object.keys(spec).some((key) => TEXT_KEYS.indexOf(key) !== -1 && key !== "color" && key !== "align");
    const touchesSize = spec.width !== undefined || spec.height !== undefined;
    if (touchesText || touchesSize) {
      try {
        ctx.resources.existingFonts.push(...fontsOfTextNode(ctx.existing));
      } catch (err) {
        fail(path, errorMessage(err));
      }
    }
  }
}

function isAutoLayout(node: BaseNode | null | undefined): boolean {
  return !!node && "layoutMode" in node && (node as FrameNode).layoutMode !== "NONE";
}

function planSize(spec: Record<string, any>, plan: Plan, ctx: Context): void {
  const { path } = plan;
  const absolute =
    plan.absolute !== undefined ? plan.absolute : ctx.existing ? safe(() => (ctx.existing as any).layoutPositioning) === "ABSOLUTE" : false;
  const inAutoLayout = ctx.parentLayout !== "NONE" && !absolute;
  const layout = plan.layout || (ctx.existing && "layoutMode" in ctx.existing ? (ctx.existing as FrameNode).layoutMode : "NONE");
  const isFrame = plan.kind === "frame" || plan.kind === "component";
  const canHug = (isFrame && layout !== "NONE") || plan.kind === "text" || plan.kind === "instance";

  for (const axis of ["width", "height"] as const) {
    const value = spec[axis];
    if (value === undefined) continue;
    const at = `${path}.${axis}`;
    if (typeof value === "number") {
      plan[axis] = number(value, at, 0.01);
    } else if (value === "fill") {
      if (!inAutoLayout) {
        fail(at, absolute ? '"fill" does not apply to absolute children' : '"fill" needs a parent with auto layout (layout "vertical" or "horizontal")');
      }
      if (plan.kind === "svg") fail(at, "icons keep their aspect ratio; give a number of pixels");
      plan[axis] = "fill";
    } else if (value === "hug") {
      if (!canHug) {
        fail(at, isFrame ? '"hug" needs auto layout; set layout to "vertical" or "horizontal", or give a number' : `"hug" only applies to auto-layout frames and text`);
      }
      plan[axis] = "hug";
    } else {
      fail(at, 'must be a number of pixels, "fill" or "hug"');
    }
  }

  if (!ctx.creating) {
    if (plan.kind === "text" && typeof plan.height !== "undefined" && plan.height !== "hug" && plan.width === undefined) {
      const current = safe(() => (ctx.existing as TextNode).textAutoResize);
      if (current === "WIDTH_AND_HEIGHT") fail(`${path}.height`, "a text with a fixed height also needs a fixed or fill width");
    }
    return;
  }

  // Defaults and requirements for new nodes.
  switch (plan.kind) {
    case "frame":
    case "component":
      if (layout !== "NONE") {
        if (plan.width === undefined) plan.width = "hug";
        if (plan.height === undefined) plan.height = "hug";
      } else if (plan.width === undefined || plan.height === undefined) {
        fail(path, 'a frame with layout "none" needs a width and a height');
      }
      break;
    case "text":
      if (plan.width === undefined) plan.width = "hug";
      if (plan.height === undefined) plan.height = "hug";
      if (plan.height !== "hug" && plan.width === "hug") fail(`${path}.height`, "a text with a fixed height also needs a fixed or fill width");
      break;
    case "rect":
    case "ellipse":
      if (plan.width === undefined || plan.height === undefined) fail(path, `a ${plan.kind} needs a width and a height`);
      break;
    case "line":
      if (plan.width === undefined) {
        if (!inAutoLayout) fail(path, 'a line outside auto layout needs a width');
        plan.width = "fill";
      }
      if (plan.height === undefined) plan.height = 1;
      break;
  }
}

function planNode(spec: unknown, path: string, ctx: Context): Plan {
  if (!isObject(spec)) fail(path, 'must be an object such as { "type": "frame", "children": [ … ] }');
  const type = spec.type;
  if (typeof type !== "string" || !SPEC_KEYS[type]) {
    fail(`${path}.type`, `must be one of ${Object.keys(SPEC_KEYS).map((t) => JSON.stringify(t)).join(", ")}, got ${JSON.stringify(type)}`);
  }
  checkKeys(spec, SPEC_KEYS[type], path, `a ${type}`);
  const plan: Plan = { path, kind: type as Kind };
  planCommon(spec, plan, ctx);

  switch (type) {
    case "frame":
    case "component": {
      planBox(spec, plan);
      planFrame(spec, plan, ctx);
      planSize(spec, plan, ctx);
      if (spec.children !== undefined) {
        if (!Array.isArray(spec.children)) fail(`${path}.children`, "must be an array of node specs");
        const childCtx: Context = { ...ctx, parentLayout: plan.layout || "NONE", existing: undefined };
        plan.children = spec.children.map((child: unknown, i: number) => planNode(child, `${path}.children[${i}]`, childCtx));
      }
      break;
    }
    case "text":
      planText(spec, plan, ctx);
      planSize(spec, plan, ctx);
      break;
    case "rect":
    case "ellipse":
    case "line":
      planBox(spec, plan);
      planSize(spec, plan, ctx);
      break;
    case "svg":
      plan.svg = string(spec.svg, `${path}.svg`);
      if (!/<svg[\s>]/i.test(plan.svg)) fail(`${path}.svg`, "must be SVG markup starting with <svg");
      if (spec.color !== undefined) plan.svgFills = paints(spec.color, `${path}.color`);
      planSize(spec, plan, ctx);
      break;
  }
  return plan;
}

function planUpdate(node: SceneNode, props: unknown, path: string, resources: Resources): Plan {
  const kind = kindOfNode(node);
  if (!kind) fail(path, `nodes of type ${node.type} cannot be updated with props; use execute_code`);
  if (!isObject(props)) fail(`${path}.props`, "must be an object of properties to change");
  checkKeys(props, UPDATE_KEYS[kind], `${path}.props`, `a ${node.type} node`);
  const parent = node.parent;
  const ctx: Context = {
    parentLayout: parent && parent.type !== "PAGE" && isAutoLayout(parent) ? (parent as FrameNode).layoutMode as Layout : "NONE",
    creating: false,
    existing: node,
    resources,
  };
  const plan: Plan = { path: `${path}.props`, kind };
  planCommon(props, plan, ctx);
  if (kind === "text") planText(props, plan, ctx);
  else if (kind !== "group" && kind !== "svg") planBox(props, plan);
  if (kind === "frame" || kind === "component" || kind === "instance") planFrame(props, plan, ctx);
  planSize(props, plan, ctx);
  return plan;
}

// ----------------------------------------------------------------- build

export interface CreatedNode {
  path: string;
  id: string;
  name: string;
  type: string;
}

type Container = BaseNode & ChildrenMixin;

function sizing(value: Size): "FIXED" | "HUG" | "FILL" {
  return value === "fill" ? "FILL" : value === "hug" ? "HUG" : "FIXED";
}

function currentSize(node: SceneNode, axis: "h" | "v"): Size {
  const mode = safe(() => (axis === "h" ? (node as any).layoutSizingHorizontal : (node as any).layoutSizingVertical));
  if (mode === "HUG") return "hug";
  if (mode === "FILL") return "fill";
  return axis === "h" ? node.width : node.height;
}

/** Sets size and sizing modes. Must run after the node is in its parent, since FILL depends on it. */
function applySize(node: SceneNode, plan: Plan, inAutoLayout: boolean): void {
  const { width, height } = plan;
  if (width === undefined && height === undefined) return;
  const n = node as any;
  const fixedW = typeof width === "number" ? width : undefined;
  const fixedH = typeof height === "number" ? height : undefined;

  if (plan.kind === "svg") {
    const scale = Math.min(fixedW !== undefined ? fixedW / node.width : Infinity, fixedH !== undefined ? fixedH / node.height : Infinity);
    if (Number.isFinite(scale) && Math.abs(scale - 1) > 0.001) (node as FrameNode).rescale(scale);
    return;
  }

  const setMode = (axis: "width" | "height", value: Size) => {
    try {
      if (axis === "width") n.layoutSizingHorizontal = sizing(value);
      else n.layoutSizingVertical = sizing(value);
    } catch (err) {
      fail(`${plan.path}.${axis}`, `${JSON.stringify(value)} could not be applied: ${errorMessage(err)}`);
    }
  };
  const canSetModes = node.type === "TEXT" || isAutoLayout(node) || inAutoLayout;
  const effectiveW = width !== undefined ? width : currentSize(node, "h");
  const effectiveH = height !== undefined ? height : currentSize(node, "v");

  // 1. Axes becoming fixed switch to FIXED first. Resizing a FILL or HUG axis
  //    would otherwise be overridden by the old mode.
  if (canSetModes) {
    if (fixedW !== undefined) setMode("width", width as number);
    if (fixedH !== undefined) setMode("height", height as number);
  }
  // 2. Then the pixel size.
  if (fixedW !== undefined || fixedH !== undefined) {
    n.resize(fixedW !== undefined ? fixedW : node.width, fixedH !== undefined ? fixedH : node.height);
  }
  // 3. Text decides its own box from its auto-resize mode.
  if (node.type === "TEXT") {
    node.textAutoResize = effectiveH !== "hug" ? "NONE" : effectiveW === "hug" ? "WIDTH_AND_HEIGHT" : "HEIGHT";
  }
  // 4. Finally the HUG and FILL modes.
  if (canSetModes) {
    if (width === "hug" || width === "fill") setMode("width", width);
    if (height === "hug" || height === "fill") setMode("height", height);
  }
}

function applyBox(node: SceneNode, plan: Plan, creating: boolean): void {
  const n = node as any;
  if (plan.fills !== undefined) n.fills = plan.fills;
  if (plan.strokes !== undefined) {
    n.strokes = plan.strokes;
    if (creating && plan.strokes.length > 0 && "strokeAlign" in n && node.type !== "LINE") n.strokeAlign = "INSIDE";
    if (creating && plan.strokes.length > 0 && plan.strokeWeight === undefined) n.strokeWeight = 1;
  }
  if (plan.strokeWeight !== undefined) n.strokeWeight = plan.strokeWeight;
  if (plan.radius !== undefined) {
    if (Array.isArray(plan.radius)) {
      [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius] = plan.radius;
    } else {
      n.cornerRadius = plan.radius;
    }
  }
  if (plan.effects !== undefined) n.effects = plan.effects;
}

function applyFrame(node: FrameNode | ComponentNode | InstanceNode, plan: Plan): void {
  if (plan.layout !== undefined && node.layoutMode !== plan.layout) node.layoutMode = plan.layout;
  if (plan.gap !== undefined) node.itemSpacing = plan.gap;
  if (plan.padding !== undefined) {
    [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft] = plan.padding;
  }
  if (plan.align !== undefined) node.primaryAxisAlignItems = plan.align;
  if (plan.crossAlign !== undefined) node.counterAxisAlignItems = plan.crossAlign;
  if (plan.wrap !== undefined) node.layoutWrap = plan.wrap ? "WRAP" : "NO_WRAP";
  if (plan.rowGap !== undefined) node.counterAxisSpacing = plan.rowGap;
  if (plan.clip !== undefined) node.clipsContent = plan.clip;
}

function applyText(node: TextNode, text: TextPlan, resources: Resources): void {
  if (text.font) node.fontName = resources.font(text.font);
  if (text.characters !== undefined) node.characters = text.characters;
  if (text.size !== undefined) node.fontSize = text.size;
  if (text.lineHeight !== undefined) node.lineHeight = text.lineHeight;
  if (text.letterSpacing !== undefined) node.letterSpacing = text.letterSpacing;
  if (text.align !== undefined) node.textAlignHorizontal = text.align;
  if (text.decoration !== undefined) node.textDecoration = text.decoration;
  if (text.fills !== undefined) node.fills = text.fills;
  if (text.spans) {
    let offset = 0;
    for (const span of text.spans) {
      const start = offset;
      const end = (offset += span.length);
      if (end === start) continue;
      if (span.font) node.setRangeFontName(start, end, resources.font(span.font));
      if (span.size !== undefined) node.setRangeFontSize(start, end, span.size);
      if (span.fills !== undefined) node.setRangeFills(start, end, span.fills);
      if (span.decoration !== undefined) node.setRangeTextDecoration(start, end, span.decoration);
    }
  }
}

function recolor(root: SceneNode, fills: Paint[]): void {
  const nodes = "findAll" in root ? (root as FrameNode).findAll() : [];
  for (const node of nodes) {
    const n = node as any;
    if (Array.isArray(n.fills) && n.fills.some((p: Paint) => p.type === "SOLID" && p.visible !== false)) n.fills = fills;
    if (Array.isArray(n.strokes) && n.strokes.some((p: Paint) => p.type === "SOLID" && p.visible !== false)) n.strokes = fills;
  }
}

function createNode(plan: Plan, resources: Resources, topLevel: boolean): SceneNode {
  switch (plan.kind) {
    case "frame":
    case "component": {
      const frame = plan.kind === "component" ? figma.createComponent() : figma.createFrame();
      frame.name = plan.name || (plan.kind === "component" ? "Component" : "Frame");
      // New frames: white and clipped at the top level, transparent and unclipped inside others.
      frame.fills = plan.fills !== undefined ? plan.fills : topLevel ? [solid(parseColor("#FFFFFF"))] : [];
      frame.clipsContent = topLevel;
      applyFrame(frame, plan);
      applyBox(frame, { ...plan, fills: undefined }, true);
      return frame;
    }
    case "text": {
      const text = figma.createText();
      applyText(text, plan.text as TextPlan, resources);
      text.name = plan.name || (text.characters.length > 40 ? text.characters.slice(0, 40) + "…" : text.characters) || "Text";
      return text;
    }
    case "rect":
    case "line": {
      const rect = figma.createRectangle();
      rect.name = plan.name || (plan.kind === "line" ? "Line" : "Rectangle");
      applyBox(rect, plan, true);
      return rect;
    }
    case "ellipse": {
      const ellipse = figma.createEllipse();
      ellipse.name = plan.name || "Ellipse";
      applyBox(ellipse, plan, true);
      return ellipse;
    }
    case "svg": {
      const svg = figma.createNodeFromSvg(plan.svg as string);
      svg.name = plan.name || "Icon";
      svg.fills = [];
      if (plan.svgFills) recolor(svg, plan.svgFills);
      return svg;
    }
    default:
      throw new Error(`cannot create ${plan.kind}`);
  }
}

function applyCommon(node: SceneNode, plan: Plan): void {
  if (plan.name !== undefined) node.name = plan.name;
  if (plan.opacity !== undefined) (node as any).opacity = plan.opacity;
  if (plan.visible !== undefined) node.visible = plan.visible;
}

function applyPosition(node: SceneNode, plan: Plan): void {
  if (plan.absolute !== undefined && "layoutPositioning" in node) {
    (node as FrameNode).layoutPositioning = plan.absolute ? "ABSOLUTE" : "AUTO";
  }
  if (plan.x !== undefined) node.x = plan.x;
  if (plan.y !== undefined) node.y = plan.y;
}

function buildPlan(plan: Plan, parent: Container, index: number | undefined, resources: Resources, created: CreatedNode[]): SceneNode {
  const topLevel = parent.type === "PAGE";
  const node = createNode(plan, resources, topLevel);
  applyCommon(node, plan);
  if (index !== undefined) parent.insertChild(index, node);
  else parent.appendChild(node);
  // Absolute positioning first: it decides whether FILL is allowed.
  if (plan.absolute) (node as FrameNode).layoutPositioning = "ABSOLUTE";
  applySize(node, plan, isAutoLayout(parent) && parent.type !== "PAGE" && !plan.absolute);
  if (plan.x !== undefined) node.x = plan.x;
  if (plan.y !== undefined) node.y = plan.y;
  created.push({ path: plan.path, id: node.id, name: node.name, type: node.type });
  for (const child of plan.children || []) buildPlan(child, node as FrameNode, undefined, resources, created);
  return node;
}

/** Top-left of free space to the right of everything on the page. */
export function freeSpot(page: PageNode): { x: number; y: number } {
  let right = -Infinity;
  let top = Infinity;
  for (const child of page.children) {
    const box = child.absoluteBoundingBox;
    if (!box) continue;
    right = Math.max(right, box.x + box.width);
    top = Math.min(top, box.y);
  }
  return right === -Infinity ? { x: 0, y: 0 } : { x: Math.round(right + 100), y: Math.round(top) };
}

async function resolveParent(parentId: string | undefined): Promise<Container> {
  if (parentId === undefined) return figma.currentPage;
  const parent = await figma.getNodeByIdAsync(parentId);
  if (!parent) fail("parentId", `no node with id "${parentId}" exists in this file`);
  if (parent.type === "PAGE") {
    await parent.loadAsync();
    return parent;
  }
  if (parent.type === "INSTANCE") fail("parentId", "nodes cannot be added inside an instance; add them to its main component or detach it");
  if (parent.type === "COMPONENT_SET") fail("parentId", "a component set can only contain variants; build a component and add it with execute_code");
  if (!("appendChild" in parent)) fail("parentId", `a ${parent.type} cannot contain other nodes`);
  return parent as Container;
}

export interface BuildResult {
  root: SceneNode;
  created: CreatedNode[];
}

export async function buildDesign(params: { spec: unknown; parentId?: string; index?: number }): Promise<BuildResult> {
  const parent = await resolveParent(params.parentId);
  if (params.index !== undefined) {
    const max = parent.children.length;
    if (!Number.isInteger(params.index) || params.index < 0 || params.index > max) fail("index", `must be a whole number from 0 to ${max}`);
  }
  const resources = new Resources();
  const parentLayout: Layout = parent.type !== "PAGE" && isAutoLayout(parent) ? (parent as FrameNode).layoutMode as Layout : "NONE";
  const plan = planNode(params.spec, "spec", { parentLayout, creating: true, resources });
  await resources.resolve();

  const spot = parent.type === "PAGE" && plan.x === undefined && plan.y === undefined ? freeSpot(parent as PageNode) : undefined;
  const created: CreatedNode[] = [];
  const root = buildPlan(plan, parent, params.index, resources, created);
  if (spot) {
    root.x = spot.x;
    root.y = spot.y;
  }
  return { root, created };
}

export async function updateNodes(
  updates: unknown,
  pathOf: (index: number) => string = (index) => `updates[${index}]`,
): Promise<SceneNode[]> {
  if (!Array.isArray(updates) || updates.length === 0) fail("updates", 'must be a non-empty array of { "nodeId": …, "props": { … } }');
  const resources = new Resources();
  const items: Array<{ node: SceneNode; plan: Plan }> = [];
  for (let i = 0; i < updates.length; i++) {
    const path = pathOf(i);
    const update = updates[i];
    if (!isObject(update)) fail(path, 'must be an object such as { "nodeId": "12:34", "props": { "fill": "#FFFFFF" } }');
    checkKeys(update, ["nodeId", "props"], path, "an update");
    const id = string(update.nodeId, `${path}.nodeId`);
    const node = await figma.getNodeByIdAsync(id);
    if (!node) fail(`${path}.nodeId`, `no node with id "${id}" exists in this file`);
    if (node.type === "PAGE" || node.type === "DOCUMENT") fail(`${path}.nodeId`, `${node.type} nodes cannot be updated with props`);
    items.push({ node: node as SceneNode, plan: planUpdate(node as SceneNode, update.props, path, resources) });
  }
  await resources.resolve();

  for (const { node, plan } of items) {
    applyCommon(node, plan);
    if (node.type === "TEXT") applyText(node, plan.text as TextPlan, resources);
    else applyBox(node, plan, false);
    if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "COMPONENT_SET") {
      applyFrame(node as FrameNode, plan);
    }
    applyPosition(node, plan);
    const parent = node.parent;
    applySize(node, plan, !!parent && parent.type !== "PAGE" && isAutoLayout(parent) && (node as any).layoutPositioning !== "ABSOLUTE");
  }
  return items.map((item) => item.node);
}

export function describeCreated(result: BuildResult, limit = 100): Json {
  const out: Json = { nodeCount: result.created.length, nodes: result.created.slice(0, limit) };
  if (result.created.length > limit) out.nodesOmitted = result.created.length - limit;
  return out;
}

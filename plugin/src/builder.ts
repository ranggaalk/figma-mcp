// Declarative builder behind build_design, update_nodes and the `h` helpers.
//
// Work happens in two passes. The plan pass checks the whole spec and
// resolves everything it refers to (fonts, variables, styles, components,
// images) without touching the document, so a mistake anywhere is reported
// with its path before any node exists. The build pass then creates or
// changes nodes in the order Figma requires.

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
import { findComponent, findStyle, findVariable, textLayerNames, type ComponentLike, type StyleKind } from "./library";
import { parseColor, shadowEffect, solid, SHADOW_KEYS, type ShadowSpec } from "./paint";
import { closest, errorMessage, safe, type Json } from "./util";

export class SpecError extends Error {}

function fail(path: string, message: string): never {
  throw new SpecError(`${path}: ${message}`);
}

type Size = number | "fill" | "hug";
type Layout = "VERTICAL" | "HORIZONTAL" | "NONE";
type Kind = "frame" | "component" | "text" | "rect" | "ellipse" | "line" | "svg" | "instance" | "shape" | "group";

// ------------------------------------------------------------------ keys

const COMMON_KEYS = ["name", "width", "height", "x", "y", "absolute", "opacity", "visible"];
const BOX_KEYS = ["fill", "stroke", "strokeWeight", "radius", "shadow", "effectStyle"];
const FRAME_KEYS = ["layout", "gap", "padding", "align", "crossAlign", "wrap", "rowGap", "clip"];
const TEXT_KEYS = [
  "text",
  "spans",
  "font",
  "weight",
  "italic",
  "size",
  "color",
  "lineHeight",
  "letterSpacing",
  "align",
  "decoration",
  "textStyle",
];
const SPAN_KEYS = ["text", "font", "weight", "italic", "size", "color", "decoration"];
const INSTANCE_KEYS = ["variant", "props", "texts"];
const without = (keys: string[], ...removed: string[]) => keys.filter((key) => removed.indexOf(key) === -1);

/** Keys a spec may use when creating each type of node. */
const SPEC_KEYS: Record<string, string[]> = {
  frame: ["type", ...COMMON_KEYS, ...BOX_KEYS, ...FRAME_KEYS, "children"],
  component: ["type", ...COMMON_KEYS, ...BOX_KEYS, ...FRAME_KEYS, "children"],
  text: ["type", ...COMMON_KEYS, ...TEXT_KEYS],
  rect: ["type", ...COMMON_KEYS, ...BOX_KEYS],
  ellipse: ["type", ...COMMON_KEYS, ...without(BOX_KEYS, "radius")],
  line: ["type", ...COMMON_KEYS, ...without(BOX_KEYS, "radius")],
  svg: ["type", ...COMMON_KEYS, "svg", "color"],
  instance: ["type", ...COMMON_KEYS, "component", ...INSTANCE_KEYS],
};

/** Keys update_nodes accepts for each kind of existing node. */
const UPDATE_KEYS: Record<Kind, string[]> = {
  frame: [...COMMON_KEYS, ...BOX_KEYS, ...FRAME_KEYS],
  component: [...COMMON_KEYS, ...BOX_KEYS, ...FRAME_KEYS],
  instance: [...COMMON_KEYS, ...BOX_KEYS, ...FRAME_KEYS, ...INSTANCE_KEYS],
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
  variants: "variant",
  properties: "props",
  overrides: "texts",
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
const SCALE_MODES: Record<string, "FILL" | "FIT" | "CROP" | "TILE"> = { fill: "FILL", fit: "FIT", crop: "CROP", tile: "TILE" };

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

// ------------------------------------------------------------- resources

interface FontEntry {
  request: FontRequest;
  path: string;
  /** Take the family from this text style once it is resolved. */
  styleKey?: string;
}

/**
 * Everything a spec refers to. Requests are collected while planning and
 * resolved together before anything is built, so a missing font, variable,
 * style or component is reported before the document changes.
 */
class Resources {
  private readonly fontEntries: Record<string, FontEntry> = {};
  private readonly fonts: Record<string, FontName> = {};
  private readonly variableRequests: Record<string, { ref: string; type: VariableResolvedDataType; path: string }> = {};
  private readonly variables: Record<string, Variable> = {};
  private readonly styleRequests: Record<string, { ref: string; kind: StyleKind; path: string }> = {};
  private readonly styles: Record<string, BaseStyle> = {};
  private readonly componentRequests: Record<string, { ref: string; path: string }> = {};
  private readonly components: Record<string, ComponentLike> = {};
  private readonly imageRequests: Record<string, string> = {};
  private readonly later: Array<() => Promise<void>> = [];
  /** Fonts of text that is about to change (or of a text style); they must be loaded too. */
  readonly existingFonts: FontName[] = [];

  requestFont(request: FontRequest, path: string, styleKey?: string): string {
    const key = fontRequestKey(request) + (styleKey ? "|" + styleKey : "");
    if (!this.fontEntries[key]) this.fontEntries[key] = { request, path, styleKey };
    return key;
  }

  requestVariable(ref: string, type: VariableResolvedDataType, path: string): string {
    const key = `${type}|${ref}`;
    if (!this.variableRequests[key]) this.variableRequests[key] = { ref, type, path };
    return key;
  }

  requestStyle(ref: string, kind: StyleKind, path: string): string {
    const key = `${kind}|${ref}`;
    if (!this.styleRequests[key]) this.styleRequests[key] = { ref, kind, path };
    return key;
  }

  requestComponent(ref: string, path: string): string {
    if (!this.componentRequests[ref]) this.componentRequests[ref] = { ref, path };
    return ref;
  }

  requestImage(hash: string, path: string): void {
    if (!this.imageRequests[hash]) this.imageRequests[hash] = path;
  }

  /** Work that needs the resolved resources (e.g. picking a component variant). */
  after(work: () => Promise<void>): void {
    this.later.push(work);
  }

  font(key: string): FontName {
    return this.fonts[key];
  }
  variable(key: string): Variable {
    return this.variables[key];
  }
  style(key: string): BaseStyle {
    return this.styles[key];
  }
  component(key: string): ComponentLike {
    return this.components[key];
  }

  async resolve(): Promise<void> {
    for (const key of Object.keys(this.variableRequests)) {
      const { ref, type, path } = this.variableRequests[key];
      try {
        this.variables[key] = await findVariable(ref, type);
      } catch (err) {
        fail(path, errorMessage(err));
      }
    }
    for (const key of Object.keys(this.styleRequests)) {
      const { ref, kind, path } = this.styleRequests[key];
      try {
        const style = await findStyle(ref, kind);
        this.styles[key] = style;
        if (style.type === "TEXT") this.existingFonts.push((style as TextStyle).fontName);
      } catch (err) {
        fail(path, errorMessage(err));
      }
    }
    for (const ref of Object.keys(this.componentRequests)) {
      try {
        this.components[ref] = await findComponent(ref);
      } catch (err) {
        fail(this.componentRequests[ref].path, errorMessage(err));
      }
    }
    for (const hash of Object.keys(this.imageRequests)) {
      if (!figma.getImageByHash(hash)) {
        fail(this.imageRequests[hash], `no image with hash "${hash}" in this file; add the image with place_image first and use the imageHash it returns`);
      }
    }
    for (const work of this.later) await work();

    for (const key of Object.keys(this.fontEntries)) {
      const { request, path, styleKey } = this.fontEntries[key];
      const fromStyle = styleKey ? (this.styles[styleKey] as TextStyle | undefined) : undefined;
      const effective = fromStyle && !request.family ? { ...request, family: fromStyle.fontName.family } : request;
      try {
        this.fonts[key] = await resolveFont(effective);
      } catch (err) {
        fail(path, errorMessage(err));
      }
    }
    const all = Object.keys(this.fonts).map((key) => this.fonts[key]);
    await loadFonts(all.concat(this.existingFonts));
  }
}

// ----------------------------------------------------------------- plans

/** A color, an image, or a binding to a color variable or paint style. */
type PaintPlan = { paints: Paint[] } | { variable: string } | { style: string };
/** A number, or a binding to a number variable. */
type NumberPlan = number | { variable: string };

interface SpanPlan {
  length: number;
  font?: string;
  size?: number;
  fills?: PaintPlan;
  decoration?: TextDecoration;
}

interface TextPlan {
  characters?: string;
  spans?: SpanPlan[];
  font?: string;
  textStyle?: string;
  size?: number;
  fills?: PaintPlan;
  lineHeight?: LineHeight;
  letterSpacing?: LetterSpacing;
  align?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  decoration?: TextDecoration;
}

interface InstancePlan {
  component?: string;
  variant?: Record<string, string>;
  props?: Record<string, string | boolean>;
  texts?: Record<string, string>;
  /** Filled in during resolve. */
  source?: ComponentNode;
  setProps?: Record<string, string | boolean>;
  textOverrides?: Array<[string, string]>;
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
  fills?: PaintPlan;
  strokes?: PaintPlan;
  strokeWeight?: NumberPlan;
  radius?: NumberPlan | [NumberPlan, NumberPlan, NumberPlan, NumberPlan];
  effects?: Effect[];
  effectStyle?: string;
  layout?: Layout;
  gap?: NumberPlan;
  padding?: [NumberPlan, NumberPlan, NumberPlan, NumberPlan];
  align?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  crossAlign?: "MIN" | "CENTER" | "MAX" | "BASELINE";
  wrap?: boolean;
  rowGap?: NumberPlan;
  clip?: boolean;
  text?: TextPlan;
  svg?: string;
  svgFills?: Paint[];
  instance?: InstancePlan;
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

const PAINT_FORMS = 'a color such as "#1E293B", { "variable": "color/primary" }, { "style": "Brand/Primary" }, { "image": "<imageHash>" } or null';

function planPaint(value: unknown, path: string, resources: Resources, allow: { style?: boolean; image?: boolean } = {}): PaintPlan {
  if (value === null || value === "none") return { paints: [] };
  if (typeof value === "string") {
    try {
      return { paints: [solid(parseColor(value))] };
    } catch (err) {
      fail(path, errorMessage(err));
    }
  }
  if (isObject(value)) {
    if ("variable" in value) {
      checkKeys(value, ["variable"], path, "a variable binding");
      return { variable: resources.requestVariable(string(value.variable, `${path}.variable`), "COLOR", path) };
    }
    if ("style" in value && allow.style !== false) {
      checkKeys(value, ["style"], path, "a style binding");
      return { style: resources.requestStyle(string(value.style, `${path}.style`), "PAINT", path) };
    }
    if ("image" in value && allow.image) {
      checkKeys(value, ["image", "scaleMode"], path, "an image fill");
      const hash = string(value.image, `${path}.image`);
      resources.requestImage(hash, path);
      const scaleMode = value.scaleMode === undefined ? "FILL" : oneOf(value.scaleMode, SCALE_MODES, `${path}.scaleMode`);
      return { paints: [{ type: "IMAGE", imageHash: hash, scaleMode, visible: true, opacity: 1, blendMode: "NORMAL" } as ImagePaint] };
    }
  }
  fail(path, `must be ${PAINT_FORMS}`);
}

function planNumber(value: unknown, path: string, resources: Resources, min = 0): NumberPlan {
  if (isObject(value)) {
    checkKeys(value, ["variable"], path, "a variable binding");
    return { variable: resources.requestVariable(string(value.variable, `${path}.variable`), "FLOAT", path) };
  }
  return number(value, path, min);
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

function planBox(spec: Record<string, any>, plan: Plan, ctx: Context): void {
  const { path } = plan;
  const { resources } = ctx;
  if (spec.fill !== undefined) plan.fills = planPaint(spec.fill, `${path}.fill`, resources, { image: true });
  if (spec.stroke !== undefined) plan.strokes = planPaint(spec.stroke, `${path}.stroke`, resources);
  if (spec.strokeWeight !== undefined) plan.strokeWeight = planNumber(spec.strokeWeight, `${path}.strokeWeight`, resources);
  if (spec.radius !== undefined) {
    const radius = spec.radius;
    if (Array.isArray(radius)) {
      if (radius.length !== 4) fail(`${path}.radius`, "an array needs 4 values: [topLeft, topRight, bottomRight, bottomLeft]");
      plan.radius = radius.map((r, i) => planNumber(r, `${path}.radius[${i}]`, resources)) as Plan["padding"];
    } else {
      plan.radius = planNumber(radius, `${path}.radius`, resources);
    }
  }
  if (spec.shadow !== undefined && spec.effectStyle !== undefined) fail(`${path}.effectStyle`, 'use either "shadow" or "effectStyle", not both');
  if (spec.effectStyle !== undefined) plan.effectStyle = resources.requestStyle(string(spec.effectStyle, `${path}.effectStyle`), "EFFECT", `${path}.effectStyle`);
  if (spec.shadow !== undefined) {
    const list = spec.shadow === null ? [] : Array.isArray(spec.shadow) ? spec.shadow : [spec.shadow];
    plan.effects = list.map((shadow: unknown, i: number) => {
      const shadowPath = Array.isArray(spec.shadow) ? `${path}.shadow[${i}]` : `${path}.shadow`;
      if (!isObject(shadow)) fail(shadowPath, 'must be an object such as { "y": 4, "blur": 12, "color": "#0000001F" }');
      checkKeys(shadow, SHADOW_KEYS, shadowPath, "a shadow");
      for (const key of ["x", "y", "spread"]) if (shadow[key] !== undefined) number(shadow[key], `${shadowPath}.${key}`);
      if (shadow.blur !== undefined) number(shadow.blur, `${shadowPath}.blur`, 0);
      if (shadow.inner !== undefined) boolean(shadow.inner, `${shadowPath}.inner`);
      if (shadow.color !== undefined) {
        try {
          parseColor(string(shadow.color, `${shadowPath}.color`));
        } catch (err) {
          fail(`${shadowPath}.color`, errorMessage(err));
        }
      }
      return shadowEffect(shadow as ShadowSpec);
    });
  }
}

function planFrame(spec: Record<string, any>, plan: Plan, ctx: Context): void {
  const { path } = plan;
  const { resources } = ctx;
  if (spec.layout !== undefined) plan.layout = oneOf(spec.layout, LAYOUTS, `${path}.layout`);
  else if (ctx.creating) plan.layout = "VERTICAL";
  const layout = plan.layout || (ctx.existing && (ctx.existing as FrameNode).layoutMode) || "NONE";
  const autoLayoutOnly = (key: string) => {
    if (layout === "NONE") fail(`${path}.${key}`, 'only applies with auto layout; set layout to "vertical" or "horizontal"');
  };

  if (spec.gap !== undefined) {
    autoLayoutOnly("gap");
    plan.gap = planNumber(spec.gap, `${path}.gap`, resources);
  }
  if (spec.padding !== undefined) {
    autoLayoutOnly("padding");
    const p = spec.padding;
    const values = Array.isArray(p) ? p : [p];
    if ([1, 2, 4].indexOf(values.length) === -1) fail(`${path}.padding`, "must be a number, [vertical, horizontal] or [top, right, bottom, left]");
    const n = values.map((v: unknown, i: number) => planNumber(v, Array.isArray(p) ? `${path}.padding[${i}]` : `${path}.padding`, resources));
    plan.padding = n.length === 1 ? [n[0], n[0], n[0], n[0]] : n.length === 2 ? [n[0], n[1], n[0], n[1]] : (n as Plan["padding"]);
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
    plan.rowGap = planNumber(spec.rowGap, `${path}.rowGap`, resources);
  }
  if (spec.clip !== undefined) plan.clip = boolean(spec.clip, `${path}.clip`);
}

const STYLE_CONFLICTS = ["font", "weight", "italic", "size", "lineHeight", "letterSpacing"];

function planText(spec: Record<string, any>, plan: Plan, ctx: Context): void {
  const { path } = plan;
  const { resources } = ctx;
  const text: TextPlan = {};
  plan.text = text;

  if (spec.text !== undefined && spec.spans !== undefined) fail(path, 'use either "text" or "spans", not both');
  if (ctx.creating && spec.text === undefined && spec.spans === undefined) fail(path, 'a text node needs "text" (or "spans")');
  if (spec.text !== undefined) text.characters = string(spec.text, `${path}.text`);

  if (spec.textStyle !== undefined) {
    for (const key of STYLE_CONFLICTS) {
      if (spec[key] !== undefined) fail(`${path}.${key}`, 'textStyle already sets the font, size, line height and letter spacing; remove this or the textStyle');
    }
    text.textStyle = resources.requestStyle(string(spec.textStyle, `${path}.textStyle`), "TEXT", `${path}.textStyle`);
  }

  // Base font: when updating, unspecified parts come from the node's current font.
  let base: FontRequest = {};
  if (ctx.existing && ctx.existing.type === "TEXT") {
    const node = ctx.existing;
    const fonts = safe(() => node.getRangeAllFontNames(0, Math.max(1, node.characters.length)));
    const current = node.fontName !== figma.mixed ? node.fontName : fonts && fonts[0];
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
  const baseRequest: FontRequest = text.textStyle
    ? {}
    : {
        family: spec.font !== undefined ? spec.font : base.family,
        weight: spec.weight !== undefined ? spec.weight : base.weight,
        italic: spec.italic !== undefined ? spec.italic : base.italic,
      };
  if (!text.textStyle && (ctx.creating || fontChange)) text.font = resources.requestFont(baseRequest, path);

  if (spec.size !== undefined) text.size = number(spec.size, `${path}.size`, 1, 1000);
  else if (ctx.creating && !text.textStyle) text.size = 16;
  if (spec.color !== undefined) text.fills = planPaint(spec.color, `${path}.color`, resources);
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
        out.font = resources.requestFont(
          {
            family: span.font !== undefined ? span.font : baseRequest.family,
            weight: span.weight !== undefined ? span.weight : baseRequest.weight,
            italic: span.italic !== undefined ? span.italic : baseRequest.italic,
          },
          spanPath,
          span.font === undefined ? text.textStyle : undefined,
        );
      }
      if (span.size !== undefined) out.size = number(span.size, `${spanPath}.size`, 1, 1000);
      if (span.color !== undefined) out.fills = planPaint(span.color, `${spanPath}.color`, resources, { style: false });
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
        resources.existingFonts.push(...fontsOfTextNode(ctx.existing));
      } catch (err) {
        fail(path, errorMessage(err));
      }
    }
  }
}

function friendlyName(fullName: string): string {
  const hash = fullName.lastIndexOf("#");
  return hash > 0 ? fullName.slice(0, hash) : fullName;
}

function findDefinition(
  definitions: ComponentPropertyDefinitions,
  name: string,
): [string, ComponentPropertyDefinitions[string]] | undefined {
  if (definitions[name]) return [name, definitions[name]];
  const keys = Object.keys(definitions);
  const exact = keys.find((key) => friendlyName(key) === name);
  if (exact) return [exact, definitions[exact]];
  const loose = keys.find((key) => friendlyName(key).toLowerCase() === name.toLowerCase());
  return loose ? [loose, definitions[loose]] : undefined;
}

function describeDefinitions(definitions: ComponentPropertyDefinitions): string {
  const keys = Object.keys(definitions);
  if (keys.length === 0) return "it has no properties";
  return keys
    .map((key) => {
      const def = definitions[key];
      return def.type === "VARIANT"
        ? `${friendlyName(key)} (variant: ${(def.variantOptions || []).join(" | ")})`
        : `${friendlyName(key)} (${def.type.toLowerCase()})`;
    })
    .join(", ");
}

function stringRecord(value: unknown, path: string, allowBoolean: boolean): Record<string, any> {
  if (!isObject(value)) fail(path, "must be an object of name → value");
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (typeof v !== "string" && !(allowBoolean && typeof v === "boolean")) {
      fail(`${path}.${key}`, `must be a string${allowBoolean ? " or true/false" : ""}, got ${JSON.stringify(v)}`);
    }
  }
  return value;
}

function planInstance(spec: Record<string, any>, plan: Plan, ctx: Context): void {
  const { path } = plan;
  const { resources } = ctx;
  const instance: InstancePlan = {};
  plan.instance = instance;
  if (ctx.creating) {
    if (spec.component === undefined) fail(path, 'an instance needs "component": a component name, id or library key');
    instance.component = resources.requestComponent(string(spec.component, `${path}.component`), `${path}.component`);
  }
  if (spec.variant !== undefined) instance.variant = stringRecord(spec.variant, `${path}.variant`, false);
  if (spec.props !== undefined) instance.props = stringRecord(spec.props, `${path}.props`, true);
  if (spec.texts !== undefined) instance.texts = stringRecord(spec.texts, `${path}.texts`, false);
  if (!ctx.creating && !instance.variant && !instance.props && !instance.texts) return;

  const existing = ctx.existing as InstanceNode | undefined;
  resources.after(async () => {
    let main: ComponentNode | null;
    let set: ComponentSetNode | null = null;
    if (existing) {
      main = await existing.getMainComponentAsync();
      if (!main) fail(path, "the instance's main component is missing, so its properties cannot be changed");
    } else {
      const found = resources.component(instance.component as string);
      main = found.type === "COMPONENT_SET" ? (found.defaultVariant as ComponentNode) : found;
      if (found.type === "COMPONENT_SET") set = found;
    }
    if (!set && main.parent && main.parent.type === "COMPONENT_SET") set = main.parent as ComponentSetNode;
    const label = `"${(set || main).name}"`;
    const definitions = (set || main).componentPropertyDefinitions;

    // Variant choices may come from `variant` or (leniently) from `props`.
    const variantWanted: Record<string, string> = {};
    const otherProps: Record<string, string | boolean> = {};
    const variantSource = instance.variant || {};
    if (!set && Object.keys(variantSource).length > 0) fail(`${path}.variant`, `${label} is a single component without variants`);
    for (const name of Object.keys(variantSource)) {
      const def = findDefinition(definitions, name);
      if (!def || def[1].type !== "VARIANT") {
        fail(`${path}.variant.${name}`, `${label} has no variant property "${name}"; ${describeDefinitions(definitions)}`);
      }
      variantWanted[def[0]] = variantSource[name];
    }
    const propsSource = instance.props || {};
    for (const name of Object.keys(propsSource)) {
      const def = findDefinition(definitions, name);
      if (!def) fail(`${path}.props.${name}`, `${label} has no property "${name}"; ${describeDefinitions(definitions)}`);
      const [fullName, definition] = def;
      const value = propsSource[name];
      if (definition.type === "VARIANT") variantWanted[fullName] = String(value);
      else if (definition.type === "BOOLEAN" && typeof value !== "boolean") fail(`${path}.props.${name}`, "must be true or false");
      else if (definition.type === "TEXT" && typeof value !== "string") fail(`${path}.props.${name}`, "must be a string");
      else if (definition.type === "INSTANCE_SWAP") {
        try {
          const swap = await findComponent(String(value));
          if (swap.type !== "COMPONENT") fail(`${path}.props.${name}`, "must name a single component, not a component set");
          otherProps[fullName] = swap.id;
        } catch (err) {
          if (err instanceof SpecError) throw err;
          fail(`${path}.props.${name}`, errorMessage(err));
        }
      } else otherProps[fullName] = value;
    }

    let target: ComponentNode = main;
    const setProps: Record<string, string | boolean> = { ...otherProps };
    if (Object.keys(variantWanted).length > 0) {
      if (!set) fail(`${path}.variant`, `${label} is a single component without variants`);
      for (const fullName of Object.keys(variantWanted)) {
        const options = definitions[fullName].variantOptions || [];
        if (options.indexOf(variantWanted[fullName]) === -1) {
          fail(`${path}.variant.${friendlyName(fullName)}`, `"${variantWanted[fullName]}" is not an option; options: ${options.join(", ")}`);
        }
      }
      const current = main.variantProperties || {};
      const wanted: Record<string, string> = { ...current, ...variantWanted };
      const match = set.children.find(
        (child) => child.type === "COMPONENT" && Object.keys(wanted).every((key) => (child.variantProperties || {})[key] === wanted[key]),
      ) as ComponentNode | undefined;
      if (!match) {
        fail(`${path}.variant`, `no variant of ${label} has ${JSON.stringify(wanted)}. Variants: ${set.children.slice(0, 12).map((c) => c.name).join("; ")}`);
      }
      target = match;
      if (existing) Object.assign(setProps, variantWanted);
    }
    instance.source = target;
    instance.setProps = setProps;

    // Text overrides: check the layers exist and load their fonts.
    const textRoot: ComponentNode | InstanceNode = existing && target === main ? existing : target;
    instance.textOverrides = [];
    const texts = instance.texts || {};
    for (const layer of Object.keys(texts)) {
      const node = textRoot.findOne((n) => n.type === "TEXT" && n.name === layer) as TextNode | null;
      if (!node) {
        const names = textLayerNames(textRoot);
        fail(`${path}.texts.${layer}`, `no text layer named "${layer}"; text layers: ${names.length ? names.join(", ") : "none"}`);
      }
      try {
        resources.existingFonts.push(...fontsOfTextNode(node));
      } catch (err) {
        fail(`${path}.texts.${layer}`, errorMessage(err));
      }
      instance.textOverrides.push([layer, texts[layer]]);
    }
    // Text properties rewrite text layers, which needs their fonts too.
    if (Object.keys(setProps).some((key) => definitions[key] && definitions[key].type === "TEXT")) {
      for (const node of textRoot.findAll((n) => n.type === "TEXT") as TextNode[]) {
        const fonts = safe(() => fontsOfTextNode(node));
        if (fonts) resources.existingFonts.push(...fonts);
      }
    }
  });
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
        fail(at, isFrame ? '"hug" needs auto layout; set layout to "vertical" or "horizontal", or give a number' : `"hug" only applies to auto-layout frames, instances and text`);
      }
      plan[axis] = "hug";
    } else {
      fail(at, 'must be a number of pixels, "fill" or "hug"');
    }
  }

  if (!ctx.creating) {
    if (plan.kind === "text" && plan.height !== undefined && plan.height !== "hug" && plan.width === undefined) {
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
        if (!inAutoLayout) fail(path, "a line outside auto layout needs a width");
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
      planBox(spec, plan, ctx);
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
      planBox(spec, plan, ctx);
      planSize(spec, plan, ctx);
      break;
    case "svg":
      plan.svg = string(spec.svg, `${path}.svg`);
      if (!/<svg[\s>]/i.test(plan.svg)) fail(`${path}.svg`, "must be SVG markup starting with <svg");
      if (spec.color !== undefined) {
        const paint = planPaint(spec.color, `${path}.color`, ctx.resources, { style: false });
        if (!("paints" in paint)) fail(`${path}.color`, 'must be a color such as "#4F46E5"');
        plan.svgFills = paint.paints;
      }
      planSize(spec, plan, ctx);
      break;
    case "instance":
      planInstance(spec, plan, ctx);
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
    parentLayout: parent && parent.type !== "PAGE" && isAutoLayout(parent) ? ((parent as FrameNode).layoutMode as Layout) : "NONE",
    creating: false,
    existing: node,
    resources,
  };
  const plan: Plan = { path: `${path}.props`, kind };
  planCommon(props, plan, ctx);
  if (kind === "text") planText(props, plan, ctx);
  else if (kind !== "group" && kind !== "svg") planBox(props, plan, ctx);
  if (kind === "frame" || kind === "component" || kind === "instance") planFrame(props, plan, ctx);
  if (kind === "instance") planInstance(props, plan, ctx);
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
    if (fixedW !== undefined) setMode("width", fixedW);
    if (fixedH !== undefined) setMode("height", fixedH);
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

async function applyPaint(node: any, field: "fills" | "strokes", plan: PaintPlan, resources: Resources): Promise<void> {
  if ("paints" in plan) {
    node[field] = plan.paints;
  } else if ("variable" in plan) {
    node[field] = [figma.variables.setBoundVariableForPaint(solid(parseColor("#000000")), "color", resources.variable(plan.variable))];
  } else {
    const id = resources.style(plan.style).id;
    if (field === "fills") await node.setFillStyleIdAsync(id);
    else await node.setStrokeStyleIdAsync(id);
  }
}

function applyNumber(node: any, field: VariableBindableNodeField, value: NumberPlan, resources: Resources): void {
  if (typeof value === "number") node[field] = value;
  else node.setBoundVariable(field, resources.variable(value.variable));
}

async function applyBox(node: SceneNode, plan: Plan, creating: boolean, resources: Resources): Promise<void> {
  const n = node as any;
  if (plan.fills !== undefined) await applyPaint(n, "fills", plan.fills, resources);
  if (plan.strokes !== undefined) {
    await applyPaint(n, "strokes", plan.strokes, resources);
    if (creating && "strokeAlign" in n && node.type !== "LINE") n.strokeAlign = "INSIDE";
    if (creating && plan.strokeWeight === undefined) n.strokeWeight = 1;
  }
  if (plan.strokeWeight !== undefined) applyNumber(n, "strokeWeight", plan.strokeWeight, resources);
  if (plan.radius !== undefined) {
    if (Array.isArray(plan.radius)) {
      const corners: VariableBindableNodeField[] = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
      corners.forEach((corner, i) => applyNumber(n, corner, (plan.radius as NumberPlan[])[i], resources));
    } else if (typeof plan.radius === "number") {
      n.cornerRadius = plan.radius;
    } else {
      for (const corner of ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"] as VariableBindableNodeField[]) {
        applyNumber(n, corner, plan.radius, resources);
      }
    }
  }
  if (plan.effects !== undefined) n.effects = plan.effects;
  if (plan.effectStyle !== undefined) await n.setEffectStyleIdAsync(resources.style(plan.effectStyle).id);
}

function applyFrame(node: FrameNode | ComponentNode | InstanceNode, plan: Plan, resources: Resources): void {
  if (plan.layout !== undefined && node.layoutMode !== plan.layout) node.layoutMode = plan.layout;
  if (plan.gap !== undefined) applyNumber(node, "itemSpacing", plan.gap, resources);
  if (plan.padding !== undefined) {
    const sides: VariableBindableNodeField[] = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
    sides.forEach((side, i) => applyNumber(node, side, (plan.padding as NumberPlan[])[i], resources));
  }
  if (plan.align !== undefined) node.primaryAxisAlignItems = plan.align;
  if (plan.crossAlign !== undefined) node.counterAxisAlignItems = plan.crossAlign;
  if (plan.wrap !== undefined) node.layoutWrap = plan.wrap ? "WRAP" : "NO_WRAP";
  if (plan.rowGap !== undefined) applyNumber(node, "counterAxisSpacing", plan.rowGap, resources);
  if (plan.clip !== undefined) node.clipsContent = plan.clip;
}

async function applyText(node: TextNode, text: TextPlan, resources: Resources): Promise<void> {
  if (text.textStyle) {
    const style = resources.style(text.textStyle) as TextStyle;
    // Switch to the style's (loaded) font before linking, then set the text.
    if (node.characters.length === 0) node.fontName = style.fontName;
    await node.setTextStyleIdAsync(style.id);
  }
  if (text.font) node.fontName = resources.font(text.font);
  if (text.characters !== undefined) node.characters = text.characters;
  if (text.size !== undefined) node.fontSize = text.size;
  if (text.lineHeight !== undefined) node.lineHeight = text.lineHeight;
  if (text.letterSpacing !== undefined) node.letterSpacing = text.letterSpacing;
  if (text.align !== undefined) node.textAlignHorizontal = text.align;
  if (text.decoration !== undefined) node.textDecoration = text.decoration;
  if (text.fills !== undefined) await applyPaint(node, "fills", text.fills, resources);
  if (text.spans) {
    let offset = 0;
    for (const span of text.spans) {
      const start = offset;
      const end = (offset += span.length);
      if (end === start) continue;
      if (span.font) node.setRangeFontName(start, end, resources.font(span.font));
      if (span.size !== undefined) node.setRangeFontSize(start, end, span.size);
      if (span.fills !== undefined) {
        const paints =
          "paints" in span.fills
            ? span.fills.paints
            : [figma.variables.setBoundVariableForPaint(solid(parseColor("#000000")), "color", resources.variable((span.fills as { variable: string }).variable))];
        node.setRangeFills(start, end, paints);
      }
      if (span.decoration !== undefined) node.setRangeTextDecoration(start, end, span.decoration);
    }
  }
}

function applyInstance(node: InstanceNode, instance: InstancePlan): void {
  if (instance.setProps && Object.keys(instance.setProps).length > 0) node.setProperties(instance.setProps);
  for (const [layer, value] of instance.textOverrides || []) {
    const text = node.findOne((n) => n.type === "TEXT" && n.name === layer) as TextNode | null;
    if (text) text.characters = value;
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

async function createNode(plan: Plan, resources: Resources, topLevel: boolean): Promise<SceneNode> {
  switch (plan.kind) {
    case "frame":
    case "component": {
      const frame = plan.kind === "component" ? figma.createComponent() : figma.createFrame();
      frame.name = plan.name || (plan.kind === "component" ? "Component" : "Frame");
      // New frames: white and clipped at the top level, transparent and unclipped inside others.
      if (plan.fills === undefined) frame.fills = topLevel ? [solid(parseColor("#FFFFFF"))] : [];
      frame.clipsContent = topLevel;
      applyFrame(frame, plan, resources);
      await applyBox(frame, plan, true, resources);
      return frame;
    }
    case "text": {
      const text = figma.createText();
      await applyText(text, plan.text as TextPlan, resources);
      text.name = plan.name || (text.characters.length > 40 ? text.characters.slice(0, 40) + "…" : text.characters) || "Text";
      return text;
    }
    case "rect":
    case "line": {
      const rect = figma.createRectangle();
      rect.name = plan.name || (plan.kind === "line" ? "Line" : "Rectangle");
      await applyBox(rect, plan, true, resources);
      return rect;
    }
    case "ellipse": {
      const ellipse = figma.createEllipse();
      ellipse.name = plan.name || "Ellipse";
      await applyBox(ellipse, plan, true, resources);
      return ellipse;
    }
    case "svg": {
      const svg = figma.createNodeFromSvg(plan.svg as string);
      svg.name = plan.name || "Icon";
      svg.fills = [];
      if (plan.svgFills) recolor(svg, plan.svgFills);
      return svg;
    }
    case "instance": {
      const instancePlan = plan.instance as InstancePlan;
      const instance = (instancePlan.source as ComponentNode).createInstance();
      applyInstance(instance, instancePlan);
      return instance;
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

async function buildPlan(
  plan: Plan,
  parent: Container,
  index: number | undefined,
  resources: Resources,
  created: CreatedNode[],
): Promise<SceneNode> {
  const topLevel = parent.type === "PAGE";
  const node = await createNode(plan, resources, topLevel);
  applyCommon(node, plan);
  if (index !== undefined) parent.insertChild(index, node);
  else parent.appendChild(node);
  // Absolute positioning first: it decides whether FILL is allowed.
  if (plan.absolute) (node as FrameNode).layoutPositioning = "ABSOLUTE";
  applySize(node, plan, isAutoLayout(parent) && parent.type !== "PAGE" && !plan.absolute);
  if (plan.x !== undefined) node.x = plan.x;
  if (plan.y !== undefined) node.y = plan.y;
  created.push({ path: plan.path, id: node.id, name: node.name, type: node.type });
  for (const child of plan.children || []) await buildPlan(child, node as FrameNode, undefined, resources, created);
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

export async function resolveParent(parentId: string | undefined, label = "parentId"): Promise<Container> {
  if (parentId === undefined) return figma.currentPage;
  const parent = await figma.getNodeByIdAsync(parentId);
  if (!parent) fail(label, `no node with id "${parentId}" exists in this file`);
  if (parent.type === "PAGE") {
    await parent.loadAsync();
    return parent;
  }
  if (parent.type === "INSTANCE") fail(label, "nodes cannot be added inside an instance; add them to its main component or detach it");
  if (parent.type === "COMPONENT_SET") fail(label, "a component set can only contain variants; build a component and add it with execute_code");
  if (!("appendChild" in parent)) fail(label, `a ${parent.type} cannot contain other nodes`);
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
  const parentLayout: Layout = parent.type !== "PAGE" && isAutoLayout(parent) ? ((parent as FrameNode).layoutMode as Layout) : "NONE";
  const plan = planNode(params.spec, "spec", { parentLayout, creating: true, resources });
  await resources.resolve();

  const spot = parent.type === "PAGE" && plan.x === undefined && plan.y === undefined ? freeSpot(parent as PageNode) : undefined;
  const created: CreatedNode[] = [];
  const root = await buildPlan(plan, parent, params.index, resources, created);
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
    if (node.type === "TEXT") await applyText(node, plan.text as TextPlan, resources);
    else await applyBox(node, plan, false, resources);
    if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "COMPONENT_SET") {
      applyFrame(node as FrameNode, plan, resources);
    }
    if (node.type === "INSTANCE" && plan.instance) applyInstance(node, plan.instance);
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

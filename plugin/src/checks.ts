// check_design: finds common problems in a design, so the agent does not
// have to rely on reading screenshots alone.

import { colorToHex, round, safe, type Json } from "./util";

export type Severity = "error" | "warning" | "info";

export interface Issue {
  severity: Severity;
  rule: string;
  nodeId: string;
  name: string;
  path: string;
  message: string;
  suggestion?: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const MAX_PER_RULE = 30;
const TOLERANCE = 1;
const DEFAULT_NAME = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Polygon|Star|Text|Component|Instance|Section) \d+$/;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Tokens {
  /** Hex → names of paint styles and color variables with that value. */
  colors: Record<string, string[]>;
  hasColorTokens: boolean;
  hasTextStyles: boolean;
  /** Local color variables by id, to compare what a paint shows with what its variable resolves to. */
  variables: Record<string, Variable>;
}

async function loadTokens(): Promise<Tokens> {
  const colors: Record<string, string[]> = {};
  const add = (hex: string, label: string) => {
    (colors[hex] = colors[hex] || []).push(label);
  };
  const paintStyles = await figma.getLocalPaintStylesAsync();
  for (const style of paintStyles) {
    const paint = style.paints[0];
    if (style.paints.length === 1 && paint.type === "SOLID") add(colorToHex(paint.color), `style "${style.name}"`);
  }
  const variables = await figma.variables.getLocalVariablesAsync("COLOR");
  const byId: Record<string, Variable> = {};
  for (const variable of variables) {
    byId[variable.id] = variable;
    const value = variable.valuesByMode[Object.keys(variable.valuesByMode)[0]] as any;
    if (value && typeof value.r === "number") add(colorToHex({ r: value.r, g: value.g, b: value.b }), `variable "${variable.name}"`);
  }
  const textStyles = await figma.getLocalTextStylesAsync();
  return { colors, hasColorTokens: paintStyles.length + variables.length > 0, hasTextStyles: textStyles.length > 0, variables: byId };
}

function boxOf(node: SceneNode, render = false): Box | null {
  const box = render && "absoluteRenderBounds" in node ? (node as any).absoluteRenderBounds || node.absoluteBoundingBox : node.absoluteBoundingBox;
  return box || null;
}

function sticksOut(child: Box, parent: Box): boolean {
  return (
    child.x < parent.x - TOLERANCE ||
    child.y < parent.y - TOLERANCE ||
    child.x + child.width > parent.x + parent.width + TOLERANCE ||
    child.y + child.height > parent.y + parent.height + TOLERANCE
  );
}

/** No part of the child is inside the parent. A zero-size side (a line) may sit on the far edge. */
function liesOutside(child: Box, parent: Box): boolean {
  return (
    child.x + Math.max(child.width, 1) <= parent.x ||
    child.y + Math.max(child.height, 1) <= parent.y ||
    (child.width > 0 ? child.x >= parent.x + parent.width : child.x > parent.x + parent.width) ||
    (child.height > 0 ? child.y >= parent.y + parent.height : child.y > parent.y + parent.height)
  );
}

function isAutoLayout(node: BaseNode | null): boolean {
  return !!node && "layoutMode" in node && (node as FrameNode).layoutMode !== "NONE";
}

function singleSolid(paints: unknown): SolidPaint | undefined {
  if (!Array.isArray(paints)) return undefined;
  const visible = paints.filter((p: Paint) => p.visible !== false);
  return visible.length === 1 && visible[0].type === "SOLID" ? (visible[0] as SolidPaint) : undefined;
}

function luminance(color: RGB): number {
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function blend(top: RGB, opacity: number, bottom: RGB): RGB {
  return {
    r: top.r * opacity + bottom.r * (1 - opacity),
    g: top.g * opacity + bottom.g * (1 - opacity),
    b: top.b * opacity + bottom.b * (1 - opacity),
  };
}

/** The solid color behind a node: the nearest ancestor with a single opaque solid fill. */
function backgroundOf(node: SceneNode): RGB | undefined {
  for (let current = node.parent; current && current.type !== "PAGE" && current.type !== "DOCUMENT"; current = current.parent) {
    const fills = (current as any).fills;
    if (!Array.isArray(fills) || fills.filter((p: Paint) => p.visible !== false).length === 0) continue;
    const solid = singleSolid(fills);
    if (!solid || (solid.opacity !== undefined && solid.opacity < 0.99)) return undefined;
    return solid.color;
  }
  return { r: 1, g: 1, b: 1 };
}

function isBold(node: TextNode): boolean {
  const font = node.fontName;
  return font !== figma.mixed && /bold|black|heavy|semi/i.test(font.style);
}

class Checker {
  readonly issues: Issue[] = [];
  readonly counts: Record<string, number> = {};
  checked = 0;

  constructor(
    private readonly root: SceneNode,
    private readonly tokens: Tokens,
    private readonly options: CheckOptions,
  ) {}

  private pathOf(node: SceneNode): string {
    const names: string[] = [];
    for (let current: BaseNode | null = node; current && current !== this.root.parent; current = current.parent) {
      names.unshift(current.name);
      if (current === this.root) break;
    }
    return names.join(" / ");
  }

  private add(severity: Severity, rule: string, node: SceneNode, message: string, suggestion?: string): void {
    this.counts[rule] = (this.counts[rule] || 0) + 1;
    if (this.counts[rule] > MAX_PER_RULE) return;
    this.issues.push({ severity, rule, nodeId: node.id, name: node.name, path: this.pathOf(node), message, suggestion });
  }

  run(): void {
    this.visit(this.root, false, false);
  }

  private visit(node: SceneNode, insideInstance: boolean, staleAbove: boolean): void {
    if (node.visible === false) return;
    this.checked++;
    this.checkNode(node, insideInstance);
    // One report per stale subtree: refreshing the top node fixes everything under it.
    const stale = staleAbove || (this.options.stale !== false && this.checkStale(node));
    // Contents of instances come from their main component, which is checked where it is defined.
    if (node.type === "INSTANCE") return;
    if ("children" in node) {
      for (const child of (node as FrameNode).children) this.visit(child, insideInstance, stale);
    }
  }

  /**
   * Found in Figma: a node cloned into a frame with another variable mode keeps the
   * colors of the mode it came from, in `fills` and on screen, although the binding is intact.
   */
  private checkStale(node: SceneNode): boolean {
    const n = node as any;
    for (const field of ["fills", "strokes"] as const) {
      const paints = field in n ? n[field] : undefined;
      if (!Array.isArray(paints)) continue;
      for (const paint of paints as Paint[]) {
        const id = paint.type === "SOLID" && paint.visible !== false && paint.boundVariables && paint.boundVariables.color ? paint.boundVariables.color.id : undefined;
        const variable = id ? this.tokens.variables[id] : undefined;
        if (!variable || paint.type !== "SOLID") continue;
        const resolved = safe(() => variable.resolveForConsumer(node).value) as RGBA | undefined;
        if (!resolved || typeof resolved.r !== "number") continue;
        const shown = paint.color;
        const off = Math.max(Math.abs(shown.r - resolved.r), Math.abs(shown.g - resolved.g), Math.abs(shown.b - resolved.b));
        if (off <= 0.02) continue;
        this.add(
          "warning",
          "stale-variable",
          node,
          `${field === "fills" ? (node.type === "TEXT" ? "Text color" : "Fill") : "Stroke"} is bound to variable "${variable.name}" but still shows ${colorToHex(shown)}; in this frame's mode the variable is ${colorToHex(resolved)}.`,
          "Run `await h.refreshVariables(node)` on it in execute_code. Copies made with node.clone() keep the colors of the mode they came from; h.clone avoids that.",
        );
        return true;
      }
    }
    return false;
  }

  private checkNode(node: SceneNode, insideInstance: boolean): void {
    const n = node as any;

    if (node.type === "TEXT") this.checkText(node);

    // Auto-layout frames still at Figma's 100 px default size on a fixed axis.
    if (isAutoLayout(node) && "children" in node && (node as FrameNode).children.length > 0) {
      for (const [axis, size] of [["Horizontal", node.width], ["Vertical", node.height]] as const) {
        const mode = safe(() => n[`layoutSizing${axis}`]);
        if (mode === "FIXED" && Math.abs(size - 100) < 0.01) {
          this.add(
            "warning",
            "default-size",
            node,
            `${axis === "Horizontal" ? "Width" : "Height"} is still Figma's default 100 px on a fixed axis.`,
            `Set ${axis === "Horizontal" ? "width" : "height"} to "hug" or "fill" (or the intended number).`,
          );
        }
      }
    }

    // Children cut off by a clipping frame, sticking out of an auto-layout parent, or not inside their frame at all.
    if ("children" in node && node.type !== "INSTANCE") {
      const box = boxOf(node);
      const clips = n.clipsContent === true;
      const isFrame = node.type === "FRAME" || node.type === "COMPONENT" || node.type === "COMPONENT_SET";
      const outside: Record<string, boolean> = {};
      if (box && isFrame) {
        for (const child of (node as FrameNode).children) {
          if (child.visible === false || (child as any).isMask === true) continue;
          const childBox = boxOf(child);
          if (!childBox || !liesOutside(childBox, box)) continue;
          outside[child.id] = true;
          if (clips) {
            this.add("warning", "clipped", child, `Hidden: it lies completely outside "${node.name}", which clips its content.`, "Move it inside the frame, or out of this frame if it belongs elsewhere.");
          } else {
            this.add("warning", "outside-parent", child, `Lies completely outside its parent "${node.name}".`, "Move it inside the frame, or out of this frame if it belongs elsewhere.");
          }
        }
      }
      if (box && (clips || isAutoLayout(node))) {
        for (const child of (node as FrameNode).children) {
          if (child.visible === false || outside[child.id]) continue;
          if (!clips && (child as any).layoutPositioning === "ABSOLUTE") continue;
          // Render bounds include shadows and other effects, which may extend past
          // a parent by design; only for text do they show real overflow (glyphs).
          const childBox = boxOf(child, child.type === "TEXT");
          if (!childBox || !sticksOut(childBox, box)) continue;
          if (clips) {
            this.add("warning", "clipped", child, `Partly hidden: it extends past "${node.name}", which clips its content.`, "Make the parent hug its content, enlarge it, or let the child fill it.");
          } else {
            this.add("warning", "overflow", child, `Sticks out of its auto-layout parent "${node.name}".`, "Let the parent hug its content, or make this child fill or shrink.");
          }
        }
      }
    }

    if (!insideInstance) {
      if (DEFAULT_NAME.test(node.name)) {
        this.add("info", "default-name", node, `Layer still has the default name "${node.name}".`, "Name layers after their role, e.g. \"Header\" or \"Primary button\".");
      }
      if (this.tokens.hasColorTokens && node.type !== "INSTANCE") this.checkColors(node);
    }
  }

  private checkText(node: TextNode): void {
    if (node.hasMissingFont) {
      this.add("error", "missing-font", node, "Uses a font that is not installed, so it cannot be edited and may render differently.", "Switch to an installed font.");
      return;
    }
    // Render bounds show glyphs past the box, except where a clipping frame
    // already hides them; overflow exactly at a clipping edge goes unnoticed.
    const truncates = safe(() => (node as any).textTruncation) === "ENDING";
    if (node.textAutoResize === "NONE" && !truncates) {
      const render = (node as any).absoluteRenderBounds as Box | null;
      const box = node.absoluteBoundingBox;
      if (render && box && (render.height > box.height + TOLERANCE || render.width > box.width + TOLERANCE)) {
        this.add("error", "text-overflow", node, `Text does not fit its fixed ${round(box.width)}×${round(box.height)} box.`, 'Set height to "hug" (auto height) or make the box larger.');
      }
    }
    if (this.tokens.hasTextStyles && !node.textStyleId) {
      this.add("info", "unstyled-text", node, "Text is not using a text style.", "Apply one of the file's text styles (textStyle).");
    }
    this.checkContrast(node);
  }

  private checkContrast(node: TextNode): void {
    const fill = singleSolid(node.fills);
    if (!fill) return;
    const background = backgroundOf(node);
    if (!background) return;
    const color = blend(fill.color, fill.opacity !== undefined ? fill.opacity : 1, background);
    const ratio = contrast(color, background);
    const size = node.fontSize === figma.mixed ? 16 : node.fontSize;
    const large = size >= 24 || (size >= 18.66 && isBold(node));
    const needed = large ? 3 : 4.5;
    if (ratio < needed) {
      this.add(
        "warning",
        "contrast",
        node,
        `Contrast ${round(ratio, 2)}:1 against ${colorToHex(background)} is below WCAG AA (${needed}:1 for ${large ? "large" : "normal"} text).`,
        "Darken the text or lighten the background (or the reverse on dark backgrounds).",
      );
    }
  }

  private checkColors(node: SceneNode): void {
    const n = node as any;
    const bound = safe(() => n.boundVariables) || {};
    for (const field of ["fills", "strokes"] as const) {
      if (!(field in n)) continue;
      const styleId = field === "fills" ? n.fillStyleId : n.strokeStyleId;
      if (styleId && styleId !== figma.mixed) continue;
      if (bound[field] && bound[field].length) continue;
      const solid = singleSolid(n[field]);
      if (!solid || (solid.boundVariables && solid.boundVariables.color)) continue;
      const hex = colorToHex(solid.color);
      const matches = this.tokens.colors[hex];
      const what = field === "fills" ? (node.type === "TEXT" ? "Text color" : "Fill") : "Stroke";
      if (matches) {
        this.add("warning", "unlinked-token", node, `${what} ${hex} equals ${matches[0]} but is not linked to it.`, `Use ${matches[0]} so it follows design-system changes.`);
      } else {
        this.add("info", "off-palette", node, `${what} ${hex} is not one of the file's color styles or variables.`, "Use a color from the design system, or add this one as a token.");
      }
    }
  }
}

export interface CheckOptions {
  /**
   * Compare variable-bound paints with what their variable resolves to. Off for checks
   * that run in the same call as a build: Figma stores the resolved color a moment later.
   */
  stale?: boolean;
}

export interface CheckResult {
  summary: { errors: number; warnings: number; infos: number };
  issues: Issue[];
  json: Json;
}

export async function checkDesign(root: SceneNode, maxIssues = 50, minSeverity: Severity = "info", options: CheckOptions = {}): Promise<CheckResult> {
  const checker = new Checker(root, await loadTokens(), options);
  checker.run();
  const all = checker.issues
    .filter((issue) => SEVERITY_ORDER[issue.severity] <= SEVERITY_ORDER[minSeverity])
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const count = (severity: Severity) => checker.issues.filter((issue) => issue.severity === severity).length;
  const summary = { errors: count("error"), warnings: count("warning"), infos: count("info") };
  const issues = all.slice(0, maxIssues);
  const json: Json = { root: { id: root.id, name: root.name }, nodesChecked: checker.checked, summary, issues };
  if (all.length > issues.length) json.issuesOmitted = all.length - issues.length;
  const capped = Object.keys(checker.counts).filter((rule) => checker.counts[rule] > MAX_PER_RULE);
  if (capped.length) json.note = `Only the first ${MAX_PER_RULE} issues per rule are listed (${capped.map((r) => `${r}: ${checker.counts[r]}`).join(", ")}).`;
  return { summary, issues, json };
}

/** Errors and warnings only, compact, for attaching to build_design / update_nodes results. */
export async function quickCheck(roots: SceneNode[]): Promise<Json | undefined> {
  const issues: Issue[] = [];
  const seen: Record<string, boolean> = {};
  for (const root of roots) {
    if (seen[root.id] || root.removed) continue;
    seen[root.id] = true;
    issues.push(...(await checkDesign(root, 10, "warning", { stale: false })).issues);
  }
  if (issues.length === 0) return undefined;
  return {
    problems: issues.slice(0, 10).map(({ severity, rule, nodeId, path, message, suggestion }) => ({ severity, rule, nodeId, path, message, suggestion })),
    hint: "Fix these with update_nodes, or run check_design for the full report.",
  };
}

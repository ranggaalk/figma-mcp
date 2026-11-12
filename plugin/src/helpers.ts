// The `h` object available to execute_code: the builder, for code that needs logic.

import { buildDesign, updateNodes } from "./builder";
import { resolveFont } from "./fonts";
import { parseColor, solid } from "./paint";

type NodeRef = BaseNode | string;

const idOf = (ref: NodeRef) => (typeof ref === "string" ? ref : ref.id);

export function createHelpers() {
  return {
    /** Builds a node tree from a spec (same format as build_design) and returns the root node. */
    async build(spec: unknown, options: { parent?: NodeRef; index?: number } = {}): Promise<SceneNode> {
      const { root } = await buildDesign({
        spec,
        parentId: options.parent !== undefined ? idOf(options.parent) : undefined,
        index: options.index,
      });
      return root;
    },

    /** Changes a node with builder props (same format as update_nodes) and returns it. */
    async apply(target: NodeRef, props: unknown): Promise<SceneNode> {
      const [node] = await updateNodes([{ nodeId: idOf(target), props }], () => "h.apply");
      return node;
    },

    /** Replaces a text node's characters, loading whatever fonts it uses first. */
    async setText(target: NodeRef, text: string): Promise<SceneNode> {
      const [node] = await updateNodes([{ nodeId: idOf(target), props: { text } }], () => "h.setText");
      return node;
    },

    /** Resolves and loads a font, e.g. `await h.font("Inter", 600)`. */
    async font(family?: string, weight?: number | string, italic?: boolean): Promise<FontName> {
      const font = await resolveFont({ family, weight, italic });
      await figma.loadFontAsync(font);
      return font;
    },

    /** `[SolidPaint]` from "#RRGGBB", "#RRGGBBAA" or "rgb(…)", ready for `fills` or `strokes`. */
    paint(color: string): Paint[] {
      return [solid(parseColor(color))];
    },

    /** `{ r, g, b }` (0–1 channels) from a color string. */
    color(color: string): RGB {
      const { r, g, b } = parseColor(color);
      return { r, g, b };
    },
  };
}

// The `h` object available to execute_code: the builder, for code that needs logic.

import { buildDesign, updateNodes } from "./builder";
import { resolveFont } from "./fonts";
import { parseColor, solid } from "./paint";

type NodeRef = BaseNode | string;

const idOf = (ref: NodeRef) => (typeof ref === "string" ? ref : ref.id);

async function nodeOf(ref: NodeRef, where: string): Promise<BaseNode> {
  if (typeof ref !== "string") return ref;
  const node = await figma.getNodeByIdAsync(ref);
  if (!node) throw new Error(`${where}: no node with id ${ref}`);
  return node;
}

async function sceneNode(ref: NodeRef, where: string): Promise<SceneNode> {
  const node = await nodeOf(ref, where);
  if (node.type === "DOCUMENT" || node.type === "PAGE") throw new Error(`${where}: expected a layer, got the ${node.type.toLowerCase()}`);
  return node as SceneNode;
}

async function container(ref: NodeRef, where: string): Promise<BaseNode & ChildrenMixin> {
  const node = await nodeOf(ref, where);
  if (!("appendChild" in node)) throw new Error(`${where}: ${node.type} "${node.name}" cannot contain other nodes`);
  return node as BaseNode & ChildrenMixin;
}

/**
 * Found in Figma: a node cloned and moved into a frame with another variable mode
 * keeps the colors of the mode it came from, both in `fills` and on screen, and
 * re-assigning the same paints does not help. Setting the mode it already resolves
 * to explicitly and then restoring what was there makes Figma resolve the whole
 * subtree again (fills, strokes, effects, text ranges).
 */
export async function refreshVariables(node: SceneNode): Promise<number> {
  if (!("resolvedVariableModes" in node) || !("setExplicitVariableModeForCollection" in node)) return 0;
  const resolved = node.resolvedVariableModes || {};
  const explicit = node.explicitVariableModes || {};
  let refreshed = 0;
  for (const collectionId of Object.keys(resolved)) {
    const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
    // One mode: nothing can be stale.
    if (!collection || collection.modes.length < 2) continue;
    try {
      node.setExplicitVariableModeForCollection(collection, resolved[collectionId]);
      if (explicit[collectionId]) node.setExplicitVariableModeForCollection(collection, explicit[collectionId]);
      else node.clearExplicitVariableModeForCollection(collection);
      refreshed++;
    } catch (error) {
      // Library collections the file cannot set modes for: leave them as they are.
    }
  }
  return refreshed;
}

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

    /**
     * Copies a node into `parent` (default: next to the original) and returns the copy.
     * Use this instead of `node.clone()` when the copy goes into a frame with another
     * variable mode (Light into Dark): a plain clone keeps the colors of the mode it came from.
     */
    async clone(target: NodeRef, options: { parent?: NodeRef; index?: number } = {}): Promise<SceneNode> {
      const source = await sceneNode(target, "h.clone");
      const parent = options.parent !== undefined ? await container(options.parent, "h.clone") : (source.parent as BaseNode & ChildrenMixin);
      const copy = source.clone();
      if (options.index !== undefined) parent.insertChild(options.index, copy);
      else if (options.parent !== undefined) parent.appendChild(copy);
      else parent.insertChild(parent.children.indexOf(source) + 1, copy);
      await refreshVariables(copy);
      return copy;
    },

    /**
     * Makes Figma work out variable-bound colors again for a node and everything in it.
     * Fixes copies that still show the colors of the mode they were cloned from.
     * Returns how many variable collections were refreshed.
     */
    async refreshVariables(target: NodeRef): Promise<number> {
      return refreshVariables(await sceneNode(target, "h.refreshVariables"));
    },

    /**
     * Adds an annotation (Dev Mode note) to a node, keeping the ones it has.
     * `category` is a category label such as "Development" or "Accessibility".
     */
    async annotate(target: NodeRef, markdown: string, category?: string): Promise<SceneNode> {
      const node = await sceneNode(target, "h.annotate");
      if (!("annotations" in node)) throw new Error(`h.annotate: ${node.type} nodes cannot carry annotations`);
      if (typeof markdown !== "string" || markdown.trim() === "") throw new Error("h.annotate: the note must be a non-empty string");
      const note: Record<string, unknown> = { labelMarkdown: markdown };
      if (category !== undefined) {
        const categories = await figma.annotations.getAnnotationCategoriesAsync();
        const match = categories.filter((c) => c.label.toLowerCase() === String(category).toLowerCase())[0];
        if (!match) {
          throw new Error(`h.annotate: no annotation category "${category}". This file has: ${categories.map((c) => c.label).join(", ") || "none"}`);
        }
        note.categoryId = match.id;
      }
      const target_ = node as SceneNode & { annotations: ReadonlyArray<Record<string, unknown>> };
      // Figma returns both `label` and `labelMarkdown` when reading, but accepts only one when writing.
      const existing = (target_.annotations || []).map((a) => {
        const { label, labelMarkdown, ...rest } = a as Record<string, unknown>;
        return labelMarkdown ? { ...rest, labelMarkdown } : label ? { ...rest, label } : rest;
      });
      target_.annotations = [...existing, note];
      return node;
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

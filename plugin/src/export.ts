// Rendering nodes to PNG.

import type { ExportResult } from "../../src/protocol";
import { requireNode, round, withTimeout } from "./util";

const EXPORT_LIMIT_MS = 45000;
const EXPORT_LIMIT_HIDDEN_MS = 8000;

/**
 * Figma stops rendering while its window is minimized or fully covered, and
 * `exportAsync` then never settles. The UI iframe reports page visibility so
 * exports can fail quickly with an explanation instead of hanging.
 */
let windowHidden = false;

export const HIDDEN_WINDOW_HELP =
  "Figma pauses rendering while its window is minimized or completely covered by other windows. " +
  "Ask the user to keep the Figma window visible on screen (for example next to the terminal), then try again.";

export function setWindowHidden(hidden: boolean): void {
  windowHidden = hidden;
}

export function isWindowHidden(): boolean {
  return windowHidden;
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

export async function exportNode(params: { nodeId?: string; scale?: number; maxSize?: number }): Promise<ExportResult> {
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

// place_image: adding image files to the document.

import type { CommandParams } from "../../src/protocol";
import { freeSpot, resolveParent } from "./builder";
import { requireNode, round, type Json } from "./util";

export interface PlacedImage {
  node: SceneNode;
  json: Json;
}

export async function placeImage(params: CommandParams["place_image"]): Promise<PlacedImage> {
  const image = figma.createImage(figma.base64Decode(params.base64));
  const size = await image.getSizeAsync();
  const paint: ImagePaint = { type: "IMAGE", imageHash: image.hash, scaleMode: params.scaleMode, visible: true, opacity: 1, blendMode: "NORMAL" } as ImagePaint;

  let node: SceneNode;
  if (params.nodeId) {
    const target = await requireNode(params.nodeId);
    if (!("fills" in target)) throw new Error(`a ${target.type} has no fills, so it cannot show an image`);
    (target as GeometryMixin).fills = [paint];
    node = target as SceneNode;
  } else {
    const parent = await resolveParent(params.parentId);
    // Measure free space before the new rectangle exists, or it would count itself.
    const spot = parent.type === "PAGE" ? freeSpot(parent as PageNode) : undefined;
    const rect = figma.createRectangle();
    rect.name = params.name;
    const scale = params.width ? params.width / size.width : 1;
    rect.resize(Math.max(1, Math.round(size.width * scale)), Math.max(1, Math.round(size.height * scale)));
    rect.fills = [paint];
    parent.appendChild(rect);
    if (spot) {
      rect.x = spot.x;
      rect.y = spot.y;
    }
    node = rect;
  }
  return {
    node,
    json: {
      imageHash: image.hash,
      imageWidth: size.width,
      imageHeight: size.height,
      node: { id: node.id, name: node.name, type: node.type, width: round(node.width), height: round(node.height) },
      hint: 'Reuse the image in build_design or update_nodes with fill: { "image": "<imageHash>", "scaleMode": "fill" }.',
    },
  };
}

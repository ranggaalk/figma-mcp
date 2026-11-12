// find_nodes: searching large files without reading whole trees.

import type { CommandParams } from "../../src/protocol";
import { ensureAllPagesLoaded, pageOf } from "./library";
import { requireNode, round, type Json } from "./util";

function pathOf(node: BaseNode): string {
  const names: string[] = [];
  for (let current = node.parent; current && current.type !== "PAGE" && current.type !== "DOCUMENT"; current = current.parent) {
    names.unshift(current.name);
  }
  return names.join(" / ");
}

/** Pages, the document and frame-like nodes all offer these two searches. */
interface Searchable {
  findAll(callback?: (node: any) => boolean): BaseNode[];
  findAllWithCriteria(criteria: { types: NodeType[] }): BaseNode[];
}

export async function findNodes(params: CommandParams["find_nodes"]): Promise<Json> {
  let scope: Searchable;
  if (params.withinNodeId) {
    const node = await requireNode(params.withinNodeId);
    if (!("findAllWithCriteria" in node)) throw new Error(`a ${node.type} has no children to search`);
    scope = node as unknown as Searchable;
  } else if (params.allPages) {
    await ensureAllPagesLoaded();
    scope = figma.root as unknown as Searchable;
  } else {
    scope = figma.currentPage as unknown as Searchable;
  }

  const types = params.types && params.types.length ? (params.types.map((t) => t.toUpperCase()) as NodeType[]) : undefined;
  const query = params.query ? params.query.toLowerCase() : undefined;
  const text = params.text ? params.text.toLowerCase() : undefined;
  if (text && types && types.indexOf("TEXT") === -1) throw new Error('"text" only matches TEXT nodes; add "TEXT" to types or leave types out');

  const candidates: SceneNode[] = types
    ? (scope.findAllWithCriteria({ types: types as any }) as SceneNode[])
    : text
      ? (scope.findAllWithCriteria({ types: ["TEXT"] }) as SceneNode[])
      : (scope.findAll() as SceneNode[]);

  const matches = candidates.filter((node) => {
    if (query && node.name.toLowerCase().indexOf(query) === -1) return false;
    if (text && (node.type !== "TEXT" || node.characters.toLowerCase().indexOf(text) === -1)) return false;
    return true;
  });

  const limit = Math.max(1, Math.min(500, params.limit || 50));
  const nodes = matches.slice(0, limit).map((node) => {
    const out: Json = { id: node.id, name: node.name, type: node.type, path: pathOf(node) };
    if (params.allPages) out.page = pageOf(node);
    if ("width" in node) {
      const box = node.absoluteBoundingBox;
      if (box) Object.assign(out, { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) });
    }
    if (node.type === "TEXT") out.characters = node.characters.length > 80 ? node.characters.slice(0, 80) + "…" : node.characters;
    return out;
  });
  const out: Json = { total: matches.length, nodes };
  if (matches.length > nodes.length) out.omitted = matches.length - nodes.length;
  return out;
}

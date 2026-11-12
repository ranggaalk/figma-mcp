// Finding variables, styles and components: in this file, by key from a
// published library, or (variables) through the team library API.

import { serializeEffect, serializePaints, serializePropertyDefinitions } from "./serialize";
import { errorMessage, similarNames, type Json } from "./util";

export const KEY_PATTERN = /^[0-9a-f]{40}$/i;
const NODE_ID_PATTERN = /^I?\d+:\d+(;\d+:\d+)*$/;

let allPagesLoaded = false;

/** Searching the whole document needs every page loaded (dynamic page loading). */
export async function ensureAllPagesLoaded(): Promise<void> {
  if (!allPagesLoaded) {
    await figma.loadAllPagesAsync();
    allPagesLoaded = true;
  }
}

export function pageOf(node: BaseNode): string | undefined {
  let current: BaseNode | null = node;
  while (current && current.type !== "PAGE") current = current.parent;
  return current ? current.name : undefined;
}

const didYouMean = (ref: string, names: string[]) => {
  const similar = similarNames(ref, names);
  return similar.length ? ` Similar: ${similar.map((s) => JSON.stringify(s)).join(", ")}.` : "";
};

// ------------------------------------------------------------- variables

export async function findVariable(ref: string, type: VariableResolvedDataType): Promise<Variable> {
  const wanted = type === "COLOR" ? "color" : "number";
  const checkType = (variable: Variable) => {
    if (variable.resolvedType !== type) {
      throw new Error(`variable "${variable.name}" is a ${variable.resolvedType} variable, but this property needs a ${wanted} (${type}) variable`);
    }
    return variable;
  };

  if (ref.indexOf("VariableID:") === 0) {
    const variable = await figma.variables.getVariableByIdAsync(ref);
    if (!variable) throw new Error(`no variable with id "${ref}"`);
    return checkType(variable);
  }

  const locals = await figma.variables.getLocalVariablesAsync();
  if (KEY_PATTERN.test(ref)) {
    const local = locals.find((v) => v.key === ref);
    return checkType(local || (await figma.variables.importVariableByKeyAsync(ref)));
  }

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collectionName: Record<string, string> = {};
  for (const c of collections) collectionName[c.id] = c.name;
  const fullName = (v: Variable) => `${collectionName[v.variableCollectionId] || "?"}/${v.name}`;

  let matches = locals.filter((v) => v.name === ref || fullName(v) === ref);
  if (matches.length === 0) matches = locals.filter((v) => v.name.toLowerCase() === ref.toLowerCase() || fullName(v).toLowerCase() === ref.toLowerCase());
  if (matches.length > 1) matches = matches.filter((v) => v.resolvedType === type);
  if (matches.length === 1) return checkType(matches[0]);
  if (matches.length > 1) {
    throw new Error(`"${ref}" matches several ${wanted} variables: ${matches.map(fullName).join(", ")}. Use "Collection/name" or the variable id`);
  }

  // Not local: look in the libraries enabled for this file.
  const library = await findLibraryVariable(ref);
  if (library) return checkType(await figma.variables.importVariableByKeyAsync(library.key));

  const names = locals.filter((v) => v.resolvedType === type).map((v) => v.name);
  throw new Error(`no ${wanted} variable named "${ref}" in this file or its enabled libraries.${didYouMean(ref, names)}`);
}

async function findLibraryVariable(ref: string): Promise<LibraryVariable | undefined> {
  try {
    for (const collection of await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()) {
      for (const variable of await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key)) {
        if (variable.name === ref || `${collection.name}/${variable.name}` === ref) return variable;
      }
    }
  } catch (_) {
    // No team library access (permission, offline, or no libraries).
  }
  return undefined;
}

/** Variables available from libraries enabled for this file. */
export async function libraryVariables(): Promise<Json[] | { error: string }> {
  try {
    const out: Json[] = [];
    for (const collection of await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()) {
      const variables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key);
      out.push({
        library: collection.libraryName,
        collection: collection.name,
        key: collection.key,
        variables: variables.map((v) => ({ name: v.name, key: v.key, type: v.resolvedType })),
      });
    }
    return out;
  } catch (err) {
    return { error: `Could not read library variables: ${errorMessage(err)}` };
  }
}

// ---------------------------------------------------------------- styles

export type StyleKind = "PAINT" | "TEXT" | "EFFECT";

async function localStyles(kind: StyleKind): Promise<BaseStyle[]> {
  if (kind === "PAINT") return figma.getLocalPaintStylesAsync();
  if (kind === "TEXT") return figma.getLocalTextStylesAsync();
  return figma.getLocalEffectStylesAsync();
}

export async function findStyle(ref: string, kind: StyleKind): Promise<BaseStyle> {
  const wanted = kind.toLowerCase();
  const checkType = (style: BaseStyle) => {
    if (style.type !== kind) throw new Error(`style "${style.name}" is a ${style.type.toLowerCase()} style, but this property needs a ${wanted} style`);
    return style;
  };
  const locals = await localStyles(kind);
  const exact = locals.find((s) => s.id === ref || s.key === ref || s.name === ref);
  if (exact) return exact;
  const loose = locals.filter((s) => s.name.toLowerCase() === ref.toLowerCase());
  if (loose.length === 1) return loose[0];
  if (KEY_PATTERN.test(ref)) return checkType(await figma.importStyleByKeyAsync(ref));
  if (ref.indexOf("S:") === 0) {
    const style = await figma.getStyleByIdAsync(ref);
    if (style) return checkType(style);
  }
  throw new Error(
    `no local ${wanted} style named "${ref}".${didYouMean(ref, locals.map((s) => s.name))} ` +
      "For a library style, pass its key (get_styles with includeLibraries lists saved library catalogs).",
  );
}

// ------------------------------------------------------------ components

export type ComponentLike = ComponentNode | ComponentSetNode;

/** Components and component sets in this file; variants are reached through their set. */
export async function localComponents(): Promise<ComponentLike[]> {
  await ensureAllPagesLoaded();
  return figma.root
    .findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })
    .filter((node) => !(node.type === "COMPONENT" && node.parent && node.parent.type === "COMPONENT_SET")) as ComponentLike[];
}

export async function findComponent(ref: string): Promise<ComponentLike> {
  if (NODE_ID_PATTERN.test(ref)) {
    const node = await figma.getNodeByIdAsync(ref);
    if (!node) throw new Error(`no node with id "${ref}"`);
    if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
      throw new Error(`node "${ref}" is a ${node.type}, not a component`);
    }
    return node;
  }

  const locals = await localComponents();
  if (KEY_PATTERN.test(ref)) {
    const local = locals.find((c) => c.key === ref);
    if (local) return local;
    try {
      return await figma.importComponentByKeyAsync(ref);
    } catch (componentError) {
      try {
        return await figma.importComponentSetByKeyAsync(ref);
      } catch (_) {
        throw new Error(`no published component or component set with key "${ref}" (${errorMessage(componentError)})`);
      }
    }
  }

  let matches = locals.filter((c) => c.name === ref);
  if (matches.length === 0) matches = locals.filter((c) => c.name.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `"${ref}" matches several components: ${matches.map((c) => `${c.id} on page "${pageOf(c)}"`).join(", ")}. Pass the id instead`,
    );
  }
  throw new Error(
    `no component named "${ref}" in this file.${didYouMean(ref, locals.map((c) => c.name))} ` +
      "Use get_components to list them; library components need their key.",
  );
}

export function describeComponent(node: ComponentLike, extra: Json = {}): Json {
  const out: Json = { id: node.id, key: node.key, name: node.name, type: node.type, ...extra };
  const page = pageOf(node);
  if (page) out.page = page;
  if (node.description) out.description = node.description;
  const properties = serializePropertyDefinitions(node);
  if (properties) out.properties = properties;
  if (node.type === "COMPONENT_SET") out.variantCount = node.children.length;
  out.width = Math.round(node.width);
  out.height = Math.round(node.height);
  return out;
}

const matchesQuery = (query: string | undefined, ...texts: Array<string | undefined>) =>
  !query || texts.some((text) => !!text && text.toLowerCase().indexOf(query.toLowerCase()) !== -1);

const MAX_INSTANCES_SCANNED = 2000;

export async function getComponents(params: { query?: string; limit: number; includeUsed: boolean }): Promise<Json> {
  const limit = Math.max(1, Math.min(500, params.limit || 50));
  const locals = (await localComponents()).filter((c) => matchesQuery(params.query, c.name, c.description));
  const out: Json = {
    local: locals.slice(0, limit).map((c) => describeComponent(c)),
    localTotal: locals.length,
  };

  if (params.includeUsed) {
    // Library components already used in this file, found through their instances.
    const used: Record<string, Json> = {};
    const instances = figma.root.findAllWithCriteria({ types: ["INSTANCE"] });
    for (const instance of instances.slice(0, MAX_INSTANCES_SCANNED)) {
      const main = await safeMain(instance);
      if (!main || !main.remote) continue;
      const set = main.parent && main.parent.type === "COMPONENT_SET" ? (main.parent as ComponentSetNode) : undefined;
      const source: ComponentLike = set || main;
      if (!matchesQuery(params.query, source.name, main.name)) continue;
      const entry = used[source.key];
      if (entry) entry.usedCount = (entry.usedCount as number) + 1;
      else used[source.key] = { key: source.key, name: source.name, type: source.type, remote: true, usedCount: 1 };
    }
    const list = Object.keys(used).map((key) => used[key]);
    out.usedFromLibraries = list.slice(0, limit);
    if (instances.length > MAX_INSTANCES_SCANNED) out.note = `Only the first ${MAX_INSTANCES_SCANNED} of ${instances.length} instances were scanned.`;
  }
  return out;
}

async function safeMain(instance: InstanceNode): Promise<ComponentNode | null> {
  try {
    return await instance.getMainComponentAsync();
  } catch (_) {
    return null;
  }
}

async function publishStatus(item: { getPublishStatusAsync?: () => Promise<PublishStatus> }): Promise<string | undefined> {
  try {
    return item.getPublishStatusAsync ? await item.getPublishStatusAsync() : undefined;
  } catch (_) {
    return undefined;
  }
}

/** Everything another file needs to use this file as a library: keys, names, properties. */
export async function librarySnapshot(): Promise<Json> {
  const components: Json[] = [];
  for (const component of await localComponents()) {
    components.push(describeComponent(component, { published: await publishStatus(component as any) }));
  }
  const styles: Json[] = [];
  const add = async (style: BaseStyle, summary: unknown) =>
    styles.push({ key: style.key, name: style.name, type: style.type, summary, published: await publishStatus(style as any) });
  for (const style of await figma.getLocalPaintStylesAsync()) await add(style, serializePaints(style.paints));
  for (const style of await figma.getLocalTextStylesAsync()) {
    await add(style, { fontName: style.fontName, fontSize: style.fontSize, lineHeight: style.lineHeight });
  }
  for (const style of await figma.getLocalEffectStylesAsync()) await add(style, style.effects.map(serializeEffect));
  return { fileName: figma.root.name, components, styles };
}

export function textLayerNames(root: BaseNode): string[] {
  const nodes = "findAll" in root ? (root as FrameNode).findAll((n) => n.type === "TEXT") : [];
  return nodes.map((n) => n.name);
}

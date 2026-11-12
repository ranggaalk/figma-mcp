// Library catalogs: snapshots of a library file's component and style keys,
// saved on disk so other files can find and import them by key. (The plugin
// API cannot list the contents of a team library, only import by key.)

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  return process.env.FIGMA_BRIDGE_DATA_DIR || join(homedir(), ".figma-mcp-bridge");
}

function catalogDir(): string {
  return join(dataDir(), "libraries");
}

export interface Catalog {
  library: string;
  savedAt: string;
  components: Array<Record<string, unknown> & { key: string; name: string }>;
  styles: Array<Record<string, unknown> & { key: string; name: string; type: string }>;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "library"
  );
}

export async function saveCatalog(snapshot: { fileName: string; components: any[]; styles: any[] }): Promise<string> {
  await mkdir(catalogDir(), { recursive: true });
  const catalog: Catalog = {
    library: snapshot.fileName,
    savedAt: new Date().toISOString(),
    // Node ids only mean something inside the library file itself.
    components: snapshot.components.map(({ id: _id, page: _page, ...rest }) => rest),
    styles: snapshot.styles,
  };
  const path = join(catalogDir(), `${slug(snapshot.fileName)}.json`);
  await writeFile(path, JSON.stringify(catalog, null, 2));
  return path;
}

export async function loadCatalogs(): Promise<Catalog[]> {
  let files: string[];
  try {
    files = (await readdir(catalogDir())).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const catalogs: Catalog[] = [];
  for (const file of files) {
    try {
      catalogs.push(JSON.parse(await readFile(join(catalogDir(), file), "utf8")));
    } catch {
      // Ignore unreadable files rather than failing every lookup.
    }
  }
  return catalogs;
}

const matches = (query: string | undefined, ...texts: unknown[]) =>
  !query || texts.some((text) => typeof text === "string" && text.toLowerCase().includes(query.toLowerCase()));

export async function searchCatalogComponents(query: string | undefined, limit: number) {
  return (await loadCatalogs())
    .map((catalog) => {
      const found = catalog.components.filter((c) => matches(query, c.name, c.description));
      return { library: catalog.library, savedAt: catalog.savedAt, total: found.length, components: found.slice(0, limit) };
    })
    .filter((entry) => entry.total > 0);
}

export async function catalogStyles() {
  return (await loadCatalogs())
    .filter((catalog) => catalog.styles.length > 0)
    .map((catalog) => ({ library: catalog.library, savedAt: catalog.savedAt, styles: catalog.styles }));
}

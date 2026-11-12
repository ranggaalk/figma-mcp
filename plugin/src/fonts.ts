// Finding installed fonts by family + weight, and loading them.

export const DEFAULT_FONT_FAMILY = "Inter";

interface FamilyEntry {
  family: string;
  styles: string[];
}

let fontIndex: Map<string, FamilyEntry> | undefined;

async function getFontIndex(): Promise<Map<string, FamilyEntry>> {
  if (!fontIndex) {
    const index = new Map<string, FamilyEntry>();
    for (const { fontName } of await figma.listAvailableFontsAsync()) {
      const key = fontName.family.toLowerCase();
      let entry = index.get(key);
      if (!entry) {
        entry = { family: fontName.family, styles: [] };
        index.set(key, entry);
      }
      entry.styles.push(fontName.style);
    }
    fontIndex = index;
  }
  return fontIndex;
}

const norm = (style: string) => style.toLowerCase().replace(/[\s_-]/g, "");

/** Style names fonts commonly use for each CSS weight, normalized. */
const WEIGHT_NAMES: Record<number, string[]> = {
  100: ["thin", "hairline"],
  200: ["extralight", "ultralight"],
  300: ["light"],
  400: ["regular", "normal", "book", "roman"],
  500: ["medium"],
  600: ["semibold", "demibold"],
  700: ["bold"],
  800: ["extrabold", "ultrabold"],
  900: ["black", "heavy"],
};

export function isItalicStyle(style: string): boolean {
  return /italic|oblique/i.test(style);
}

/** CSS weight of a style name such as "Semi Bold Italic", or undefined when it is not a known weight name. */
export function weightOfStyle(style: string): number | undefined {
  const base = norm(style).replace("italic", "").replace("oblique", "") || "regular";
  for (const weight of Object.keys(WEIGHT_NAMES)) {
    if (WEIGHT_NAMES[Number(weight)].indexOf(base) !== -1) return Number(weight);
  }
  return undefined;
}

export interface FontRequest {
  family?: string;
  /** CSS weight (100–900) or a style name such as "Semi Bold". */
  weight?: number | string;
  italic?: boolean;
}

export function fontRequestKey(request: FontRequest): string {
  return [request.family ?? DEFAULT_FONT_FAMILY, request.weight ?? 400, request.italic ? "italic" : ""].join("|").toLowerCase();
}

/** Checks the shape of a weight without needing the font list. Returns an error message or undefined. */
export function checkWeight(weight: unknown): string | undefined {
  if (weight === undefined) return undefined;
  if (typeof weight === "number") {
    return WEIGHT_NAMES[weight] ? undefined : `weight ${weight} must be one of 100, 200, … 900, or a style name such as "Semi Bold"`;
  }
  if (typeof weight === "string" && weight.trim()) return undefined;
  return 'weight must be a number (100–900) or a style name such as "Semi Bold"';
}

/** Resolves a family/weight/italic request to an installed FontName, or throws with the available options. */
export async function resolveFont(request: FontRequest): Promise<FontName> {
  const index = await getFontIndex();
  const family = request.family ?? DEFAULT_FONT_FAMILY;
  const entry = index.get(family.toLowerCase());
  if (!entry) {
    const prefix = family.toLowerCase().slice(0, 3);
    const similar: string[] = [];
    index.forEach((value, key) => {
      if (similar.length < 8 && key.indexOf(prefix) === 0) similar.push(value.family);
    });
    throw new Error(
      `font family "${family}" is not installed` + (similar.length ? `. Similar installed families: ${similar.join(", ")}` : ""),
    );
  }

  const italic = request.italic === true;
  let weight: number | string = request.weight ?? 400;
  if (typeof weight === "string" && /^\d{3}$/.test(weight.trim())) weight = Number(weight);

  let wanted: string[];
  if (typeof weight === "number") {
    const names = WEIGHT_NAMES[weight];
    if (!names) throw new Error(checkWeight(weight));
    wanted = italic ? names.map((name) => name + "italic").concat(weight === 400 ? ["italic"] : []) : names;
  } else {
    const base = norm(weight);
    wanted = italic && base.indexOf("italic") === -1 ? [base === "regular" ? "italic" : base + "italic", base + "italic"] : [base];
  }

  const match = entry.styles.find((style) => wanted.indexOf(norm(style)) !== -1);
  if (!match) {
    throw new Error(
      `font "${entry.family}" has no ${italic ? "italic " : ""}style for weight ${JSON.stringify(request.weight ?? 400)}. ` +
        `Installed styles: ${entry.styles.join(", ")}`,
    );
  }
  return { family: entry.family, style: match };
}

export async function loadFonts(fonts: FontName[]): Promise<void> {
  const seen: Record<string, FontName> = {};
  for (const font of fonts) seen[font.family + "|" + font.style] = font;
  await Promise.all(Object.keys(seen).map((key) => figma.loadFontAsync(seen[key])));
}

/** Fonts used anywhere in a text node. Throws when one is not installed, since such text cannot be edited. */
export function fontsOfTextNode(node: TextNode): FontName[] {
  if (node.hasMissingFont) {
    const font = node.fontName === figma.mixed ? "one of its fonts" : `"${node.fontName.family} ${node.fontName.style}"`;
    throw new Error(`text "${node.name}" uses ${font}, which is not installed on this computer, so its text cannot be edited`);
  }
  const length = node.characters.length;
  if (length === 0) return node.fontName === figma.mixed ? [] : [node.fontName];
  return node.getRangeAllFontNames(0, length);
}

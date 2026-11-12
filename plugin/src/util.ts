// Small helpers shared by the plugin modules.

export type Json = Record<string, unknown>;

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

export function round(value: number, digits = 2): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/** Numeric properties that can hold `figma.mixed` (a symbol, which JSON cannot carry). */
export function orMixed(value: unknown): unknown {
  if (value === figma.mixed) return "mixed";
  return typeof value === "number" ? round(value) : value;
}

/** Some properties throw on certain node types instead of being absent. */
export function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (_) {
    return undefined;
  }
}

export function clampDepth(value: unknown, fallback = 2): number {
  const depth = Number(value);
  return Number.isFinite(depth) ? Math.max(0, Math.min(10, Math.floor(depth))) : fallback;
}

function channelToHex(channel: number): string {
  const value = Math.max(0, Math.min(255, Math.round(channel * 255)));
  return (value < 16 ? "0" : "") + value.toString(16).toUpperCase();
}

export function colorToHex(color: { r: number; g: number; b: number; a?: number }): string {
  const hex = "#" + channelToHex(color.r) + channelToHex(color.g) + channelToHex(color.b);
  return color.a !== undefined && color.a < 1 ? hex + channelToHex(color.a) : hex;
}

/** True for nodes, styles, variables and other live API objects (they all have `remove`). */
export function isApiObject(value: any): boolean {
  return typeof value === "object" && value !== null && typeof value.id === "string" && typeof value.remove === "function";
}

export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/** The option closest to `word`, if it is close enough to be a likely typo. */
export function closest(word: string, options: string[]): string | undefined {
  const lower = word.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const option of options) {
    const score = editDistance(lower, option.toLowerCase());
    if (score < bestScore) {
      best = option;
      bestScore = score;
    }
  }
  return bestScore <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

/** Up to `limit` names that contain `word` or are close to it, for "did you mean" lists. */
export function similarNames(word: string, names: string[], limit = 5): string[] {
  const lower = word.toLowerCase();
  const scored = names
    .map((name) => {
      const n = name.toLowerCase();
      const score = n.indexOf(lower) !== -1 || lower.indexOf(n) !== -1 ? 0 : editDistance(lower, n);
      return { name, score };
    })
    .filter((entry) => entry.score <= Math.max(3, Math.floor(word.length / 2)))
    .sort((a, b) => a.score - b.score);
  const out: string[] = [];
  for (const entry of scored) {
    if (out.indexOf(entry.name) === -1) out.push(entry.name);
    if (out.length >= limit) break;
  }
  return out;
}

export async function requireNode(nodeId: unknown): Promise<BaseNode> {
  if (typeof nodeId !== "string" || !nodeId) throw new Error("nodeId is required");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`No node with id "${nodeId}" exists in this file`);
  return node;
}

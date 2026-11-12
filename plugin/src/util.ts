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

export async function requireNode(nodeId: unknown): Promise<BaseNode> {
  if (typeof nodeId !== "string" || !nodeId) throw new Error("nodeId is required");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`No node with id "${nodeId}" exists in this file`);
  return node;
}

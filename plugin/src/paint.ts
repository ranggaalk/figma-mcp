// Colors, paints and effects from the builder's compact notation.

export interface RGBAColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  white: "#FFFFFF",
  black: "#000000",
  transparent: "#00000000",
};

/** Parses "#RGB", "#RGBA", "#RRGGBB", "#RRGGBBAA", "rgb(…)", "rgba(…)", "white", "black" or "transparent". */
export function parseColor(input: string): RGBAColor {
  const value = (NAMED[input.trim().toLowerCase()] || input).trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = digits.split("").map((d) => d + d).join("");
    const channel = (i: number) => parseInt(digits.slice(i, i + 2), 16) / 255;
    return { r: channel(0), g: channel(2), b: channel(4), a: digits.length === 8 ? channel(6) : 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i.exec(value);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((c) => Math.min(255, Number(c)) / 255);
    let a = 1;
    if (rgb[4] !== undefined) a = rgb[4].endsWith("%") ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
    if ([r, g, b, a].every((c) => Number.isFinite(c))) return { r, g, b, a: Math.max(0, Math.min(1, a)) };
  }
  throw new Error(`${JSON.stringify(input)} is not a color; use "#RRGGBB", "#RRGGBBAA" (with alpha), "rgb(…)" or "transparent"`);
}

export function solid(color: RGBAColor): SolidPaint {
  return { type: "SOLID", color: { r: color.r, g: color.g, b: color.b }, opacity: color.a, visible: true, blendMode: "NORMAL" };
}

export interface ShadowSpec {
  x?: number;
  y?: number;
  blur?: number;
  spread?: number;
  color?: string;
  inner?: boolean;
}

export const SHADOW_KEYS = ["x", "y", "blur", "spread", "color", "inner"];

export function shadowEffect(spec: ShadowSpec): Effect {
  const color = parseColor(spec.color ?? "#0000001F");
  return {
    type: spec.inner ? "INNER_SHADOW" : "DROP_SHADOW",
    color,
    offset: { x: spec.x ?? 0, y: spec.y ?? 4 },
    radius: spec.blur ?? 12,
    spread: spec.spread ?? 0,
    visible: true,
    blendMode: "NORMAL",
  } as Effect;
}

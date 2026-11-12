// Input schemas for build_design and update_nodes. They document the spec
// format for the agent; the plugin validates every level in full (per node
// type, with paths and suggestions), so these stay permissive and pass
// unknown keys through for the plugin to report.

import { z } from "zod";

const color = z
  .string()
  .describe('"#RRGGBB", "#RRGGBBAA" (last pair is alpha), "rgb(…)"/"rgba(…)", "white", "black" or "transparent"');

const paint = z.union([color, z.null()]);

const size = z
  .union([z.number(), z.enum(["fill", "hug"])])
  .describe(
    'Pixels, "fill" (stretch inside an auto-layout parent) or "hug" (fit content). Auto-layout frames and text hug by default.',
  );

const shadow = z
  .looseObject({
    x: z.number().optional(),
    y: z.number().optional(),
    blur: z.number().optional(),
    spread: z.number().optional(),
    color: color.optional(),
    inner: z.boolean().optional(),
  })
  .describe('Drop shadow; defaults {"x":0,"y":4,"blur":12,"spread":0,"color":"#0000001F"}. inner: true for an inner shadow.');

const weight = z
  .union([z.number(), z.string()])
  .describe('100–900 (400 regular, 500 medium, 600 semibold, 700 bold) or a style name such as "Semi Bold".');

const span = z.looseObject({
  text: z.string(),
  font: z.string().optional(),
  weight: weight.optional(),
  italic: z.boolean().optional(),
  size: z.number().optional(),
  color: paint.optional(),
  decoration: z.enum(["none", "underline", "strikethrough"]).optional(),
});

/** Props shared by build_design specs and update_nodes. Which apply depends on the node type. */
const props = {
  name: z.string().optional().describe('Layer name; name meaningful layers ("Header", "Primary button").'),
  width: size.optional(),
  height: size.optional(),
  x: z.number().optional().describe("Position in a parent without auto layout, or with absolute: true."),
  y: z.number().optional(),
  absolute: z.boolean().optional().describe("Take the node out of its auto-layout flow and place it at x/y."),
  opacity: z.number().optional().describe("0 to 1."),
  visible: z.boolean().optional(),

  // frame, component, rect, ellipse, line
  fill: paint
    .optional()
    .describe("Background color, or null for none. Top-level frames default to white, nested frames to none."),
  stroke: paint.optional().describe("Border color (inside, 1px unless strokeWeight)."),
  strokeWeight: z.number().optional(),
  radius: z
    .union([z.number(), z.array(z.number())])
    .optional()
    .describe("Corner radius, or [topLeft, topRight, bottomRight, bottomLeft]."),
  shadow: z.union([shadow, z.array(shadow), z.null()]).optional(),

  // frame, component
  layout: z
    .enum(["vertical", "horizontal", "none"])
    .optional()
    .describe('Frames: auto layout direction, default "vertical". "none" places children by x/y and needs width and height.'),
  gap: z.number().optional().describe("Frames: space between children."),
  padding: z
    .union([z.number(), z.array(z.number())])
    .optional()
    .describe("Frames: all sides, [vertical, horizontal] or [top, right, bottom, left]."),
  align: z
    .enum(["start", "center", "end", "space-between", "left", "right", "justified"])
    .optional()
    .describe("Frames: start/center/end/space-between along the layout direction. Text: left/center/right/justified."),
  crossAlign: z.enum(["start", "center", "end", "baseline"]).optional().describe("Frames: alignment across the layout direction."),
  wrap: z.boolean().optional().describe("Horizontal frames: wrap children onto new rows."),
  rowGap: z.number().optional().describe("Space between wrapped rows."),
  clip: z.boolean().optional().describe("Frames: clip content. Default true at the top level, false when nested."),

  // text
  text: z.string().optional().describe("Text: the characters (\\n for line breaks)."),
  spans: z
    .array(span)
    .optional()
    .describe('Text, instead of text: runs with their own style, e.g. [{"text":"No account? "},{"text":"Sign up","weight":600,"color":"#4F46E5"}].'),
  font: z.string().optional().describe('Text: font family, default "Inter". Must be installed.'),
  weight: weight.optional(),
  italic: z.boolean().optional(),
  size: z.number().optional().describe("Text: font size, default 16."),
  color: paint.optional().describe("Text: color (default black). Svg: recolors every shape."),
  lineHeight: z
    .union([z.number(), z.string()])
    .optional()
    .describe('Text: pixels (24), a multiplier up to 3 (1.5), "150%" or "auto".'),
  letterSpacing: z.union([z.number(), z.string()]).optional().describe('Text: pixels (0.5) or "-2%".'),
  decoration: z.enum(["none", "underline", "strikethrough"]).optional(),
};

export const nodeSpecSchema = z
  .looseObject({
    type: z
      .enum(["frame", "component", "text", "rect", "ellipse", "line", "svg"])
      .describe('"component" is a frame that becomes a main component. "line" is a divider (width "fill", height 1, colored by fill).'),
    ...props,
    svg: z.string().optional().describe("Svg: the SVG markup (icons). width/height scale it, keeping the aspect ratio."),
    children: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe("Frames: child nodes, each with the same shape as this spec."),
  })
  .describe("The root node to create, with its children.");

export const updatePropsSchema = z
  .looseObject(props)
  .describe("Props to change, in the build_design format. Only the given props change.");

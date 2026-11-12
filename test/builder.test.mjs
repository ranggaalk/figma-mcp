// build_design, update_nodes and the `h` helpers.

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { connectPlugin, imageOf, jsonOf, loadFonts, startServer, textOf } from "./helpers.mjs";
import { createMockFigma } from "./mock-figma.mjs";

const PORT = 3904;
let server;
let plugin;
let figma;

const node = (id) => figma.getNodeByIdAsync(id);
const byPath = (result, path) => jsonOf(result).nodes.find((n) => n.path === path);
const pageCount = () => figma.currentPage.children.length;
const hex = (paint) =>
  "#" + ["r", "g", "b"].map((c) => Math.round(paint.color[c] * 255).toString(16).padStart(2, "0")).join("").toUpperCase();

before(async () => {
  server = await startServer({ port: PORT });
  figma = createMockFigma();
  plugin = await connectPlugin({ port: PORT, figma });
});
after(async () => {
  await plugin.close();
  await server.close();
});
beforeEach(() => {
  for (const child of figma.currentPage.children) figma._test.setup(() => child.remove());
  figma._test.resetUndo();
});

const CARD = {
  type: "frame",
  name: "Card",
  width: 360,
  padding: 24,
  gap: 12,
  fill: "#FFFFFF",
  radius: 16,
  stroke: "#E2E8F0",
  shadow: { y: 4, blur: 16, color: "#0F172A14" },
  children: [
    { type: "text", text: "Upgrade to Pro", size: 20, weight: 600, color: "#0F172A" },
    { type: "text", text: "Unlimited projects and priority support.", width: "fill", color: "#475569", lineHeight: 1.5 },
    { type: "line", fill: "#E2E8F0" },
    {
      type: "frame",
      name: "Actions",
      layout: "horizontal",
      width: "fill",
      align: "end",
      gap: 8,
      children: [
        {
          type: "frame",
          name: "Button",
          padding: [10, 16],
          radius: 8,
          fill: "#4F46E5",
          children: [{ type: "text", text: "Upgrade", weight: 600, color: "#FFFFFF" }],
        },
      ],
    },
  ],
};

test("build_design creates the whole tree with Figma's sizing rules applied", async () => {
  const result = await server.call("build_design", { spec: CARD });
  assert.equal(result.isError, undefined, textOf(result));
  const out = jsonOf(result);
  assert.equal(out.nodeCount, 7);
  assert.equal(out.root.name, "Card");

  const card = await node(out.root.id);
  assert.equal(card.layoutMode, "VERTICAL");
  assert.equal(card.layoutSizingHorizontal, "FIXED");
  assert.equal(card.width, 360);
  assert.equal(card.layoutSizingVertical, "HUG");
  assert.deepEqual([card.paddingTop, card.paddingRight, card.paddingBottom, card.paddingLeft], [24, 24, 24, 24]);
  assert.equal(card.itemSpacing, 12);
  assert.equal(card.cornerRadius, 16);
  assert.equal(card.strokeAlign, "INSIDE");
  assert.equal(card.effects[0].type, "DROP_SHADOW");
  assert.equal(card.clipsContent, true, "top-level frames clip");
  assert.deepEqual(figma.currentPage.selection.map((n) => n.id), [card.id]);

  const title = await node(byPath(result, "spec.children[0]").id);
  assert.deepEqual(title.fontName, { family: "Inter", style: "Semi Bold" });
  assert.equal(title.fontSize, 20);
  assert.equal(title.textAutoResize, "WIDTH_AND_HEIGHT");
  assert.equal(hex(title.fills[0]), "#0F172A");
  assert.equal(title.name, "Upgrade to Pro");

  const body = await node(byPath(result, "spec.children[1]").id);
  assert.equal(body.layoutSizingHorizontal, "FILL");
  assert.equal(body.textAutoResize, "HEIGHT");
  assert.deepEqual(body.lineHeight, { unit: "PERCENT", value: 150 });
  assert.equal(body.fontSize, 16, "default size");
  assert.deepEqual(body.fontName, { family: "Inter", style: "Regular" });

  const line = await node(byPath(result, "spec.children[2]").id);
  assert.equal(line.type, "RECTANGLE");
  assert.equal(line.layoutSizingHorizontal, "FILL");
  assert.equal(line.height, 1);

  const actions = await node(byPath(result, "spec.children[3]").id);
  assert.equal(actions.primaryAxisAlignItems, "MAX");
  assert.equal(actions.clipsContent, false, "nested frames do not clip");
  assert.deepEqual(actions.fills, [], "nested frames have no fill");
  const button = await node(byPath(result, "spec.children[3].children[0]").id);
  assert.deepEqual([button.paddingTop, button.paddingRight], [10, 16]);
  assert.equal(button.layoutSizingHorizontal, "HUG");
  assert.equal(figma._test.undoDepth(), 1, "one undo step");
});

test("new top-level designs go to free space right of existing content", async () => {
  figma._test.setup(() => {
    const existing = figma.createFrame();
    existing.resize(320, 200);
    existing.x = 0;
  });
  const out = jsonOf(await server.call("build_design", { spec: { type: "frame", name: "Next" } }));
  assert.equal(out.root.x, 420);
  assert.equal(out.root.y, 0);
  const placed = jsonOf(await server.call("build_design", { spec: { type: "frame", x: -500, y: 40 } }));
  assert.deepEqual([placed.root.x, placed.root.y], [-500, 40]);
});

test("spec mistakes are reported with their path, before anything is created", async () => {
  const cases = [
    [{ type: "frame", backgroundColor: "#fff" }, /spec\.backgroundColor: unknown property for a frame \(did you mean "fill"\?\)/],
    [{ type: "frame", children: [{ type: "text", text: "a", colour: "#000" }] }, /spec\.children\[0\]\.colour: .*did you mean "color"/],
    [
      { type: "frame", layout: "none", width: 100, height: 100, children: [{ type: "text", text: "a", width: "fill" }] },
      /spec\.children\[0\]\.width: "fill" needs a parent with auto layout/,
    ],
    [{ type: "frame", children: [{ type: "rect", width: 10, height: 10 }, { type: "rect", width: 1, height: 1, fill: "blue-500" }] }, /spec\.children\[1\]\.fill: "blue-500" is not a color/],
    [{ type: "text", text: "a", weight: 450 }, /spec\.weight: weight 450 must be one of/],
    [{ type: "text", text: "a", font: "Interr" }, /font family "Interr" is not installed\. Similar installed families: Inter/],
    [{ type: "text", text: "a", font: "Roboto", italic: true }, /font "Roboto" has no italic style .* Installed styles: Regular, Medium, SemiBold, Bold/],
    [{ type: "frame", layout: "none" }, /spec: a frame with layout "none" needs a width and a height/],
    [{ type: "frame", children: [{ type: "text" }] }, /spec\.children\[0\]: a text node needs "text"/],
    [{ type: "frame", children: [{ type: "rect", width: 5, height: 5, x: 10 }] }, /spec\.children\[0\]\.x: the parent has auto layout/],
    [{ type: "frame", padding: [1, 2, 3] }, /spec\.padding: must be a number, \[vertical, horizontal\]/],
    [{ type: "button" }, /one of "frame"[\s\S]*spec\.type|spec\.type: must be one of "frame"/],
    [{ type: "frame", children: [{ type: "button" }] }, /spec\.children\[0\]\.type: must be one of "frame"/],
    [{ type: "frame", gap: 8, layout: "none", width: 10, height: 10 }, /spec\.gap: only applies with auto layout/],
  ];
  for (const [spec, expected] of cases) {
    const result = await server.call("build_design", { spec });
    assert.equal(result.isError, true, JSON.stringify(spec));
    assert.match(textOf(result), expected);
  }
  assert.equal(pageCount(), 0, "nothing was created");
  assert.equal(figma._test.undoDepth(), 0, "no undo steps were added");
});

test("a failure in the middle of building rolls everything back", async () => {
  const original = figma.createEllipse;
  figma.createEllipse = () => {
    throw new Error("simulated Figma failure");
  };
  try {
    const result = await server.call("build_design", {
      spec: { type: "frame", children: [{ type: "rect", width: 4, height: 4 }, { type: "ellipse", width: 4, height: 4 }] },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /simulated Figma failure[\s\S]*undone/);
    assert.equal(pageCount(), 0);
  } finally {
    figma.createEllipse = original;
  }
});

test("spans, letter spacing and alignment on text", async () => {
  const out = jsonOf(
    await server.call("build_design", {
      spec: {
        type: "text",
        align: "center",
        letterSpacing: "-2%",
        spans: [{ text: "No account? " }, { text: "Sign up", weight: 700, color: "#4F46E5" }],
      },
    }),
  );
  const text = await node(out.root.id);
  assert.equal(text.characters, "No account? Sign up");
  assert.equal(text.fontName, figma.mixed);
  assert.deepEqual(text.getRangeAllFontNames(12, 19), [{ family: "Inter", style: "Bold" }]);
  assert.equal(hex(text.getRangeFills(12, 19)[0]), "#4F46E5");
  assert.equal(text.textAlignHorizontal, "CENTER");
  assert.deepEqual(text.letterSpacing, { unit: "PERCENT", value: -2 });
});

test("svg icons are scaled and recolored", async () => {
  const svg = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 12h16" stroke="#000"/></svg>';
  const out = jsonOf(await server.call("build_design", { spec: { type: "frame", children: [{ type: "svg", svg, width: 16, color: "#4F46E5" }] } }));
  const icon = await node(out.nodes[1].id);
  assert.equal(icon.name, "Icon");
  assert.equal(Math.round(icon.width), 16);
  const vector = icon.children[0];
  assert.equal(hex(vector.fills[0]), "#4F46E5");
  assert.equal(hex(vector.strokes[0]), "#4F46E5");
});

test("component type and parentId/index insertion", async () => {
  const comp = jsonOf(await server.call("build_design", { spec: { type: "component", name: "Badge", padding: 4, children: [{ type: "text", text: "New" }] } }));
  assert.equal(comp.root.type, "COMPONENT");

  const list = jsonOf(await server.call("build_design", { spec: { type: "frame", children: [{ type: "text", text: "A" }, { type: "text", text: "C" }] } }));
  const inserted = await server.call("build_design", { spec: { type: "text", text: "B", width: "fill" }, parentId: list.root.id, index: 1 });
  assert.equal(inserted.isError, undefined, textOf(inserted));
  const frame = await node(list.root.id);
  assert.deepEqual(frame.children.map((c) => c.characters), ["A", "B", "C"]);
  assert.equal(frame.children[1].layoutSizingHorizontal, "FILL");
  assert.equal(frame.clipsContent, true);

  const badIndex = await server.call("build_design", { spec: { type: "text", text: "x" }, parentId: list.root.id, index: 9 });
  assert.match(textOf(badIndex), /index: must be a whole number from 0 to 3/);
  const missing = await server.call("build_design", { spec: { type: "text", text: "x" }, parentId: "99:99" });
  assert.match(textOf(missing), /parentId: no node with id "99:99"/);
});

test("update_nodes changes props, loading the fonts text already uses", async () => {
  const out = jsonOf(await server.call("build_design", { spec: CARD }));
  const titleId = out.nodes[1].id;
  const cardId = out.root.id;
  // Forget loaded fonts, as after a plugin restart.
  figma._test.loadedFonts.clear();

  const result = await server.call("update_nodes", {
    updates: [
      { nodeId: cardId, props: { fill: "#F8FAFC", padding: [16, 20], gap: 4, radius: [8, 8, 0, 0] } },
      { nodeId: titleId, props: { text: "Go Pro", weight: 700, italic: true } },
    ],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const card = await node(cardId);
  assert.equal(hex(card.fills[0]), "#F8FAFC");
  assert.deepEqual([card.paddingTop, card.paddingRight, card.paddingBottom, card.paddingLeft], [16, 20, 16, 20]);
  assert.equal(card.cornerRadius, figma.mixed);
  const title = await node(titleId);
  assert.equal(title.characters, "Go Pro");
  assert.deepEqual(title.fontName, { family: "Inter", style: "Bold Italic" });
  assert.equal(figma._test.undoDepth(), 2, "build + update");

  // A style the family does not have is reported with the installed styles.
  const missing = await server.call("update_nodes", { updates: [{ nodeId: titleId, props: { weight: 600 } }] });
  assert.match(textOf(missing), /no italic style for weight 600\. Installed styles: Regular, Italic/);
});

test("update_nodes keeps the current weight when only italic changes", async () => {
  await loadFonts(figma, ["Bold"]);
  const id = figma._test.setup(() => {
    const t = figma.createText();
    t.fontName = { family: "Inter", style: "Bold" };
    t.characters = "Hello";
    return t.id;
  });
  const result = await server.call("update_nodes", { updates: [{ nodeId: id, props: { italic: true } }] });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual((await node(id)).fontName, { family: "Inter", style: "Bold Italic" });
});

test("update_nodes validates every update before applying any", async () => {
  const out = jsonOf(await server.call("build_design", { spec: CARD }));
  const result = await server.call("update_nodes", {
    updates: [
      { nodeId: out.root.id, props: { fill: "#000000" } },
      { nodeId: out.nodes[1].id, props: { padding: 4 } },
    ],
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /updates\[1\]\.props\.padding: unknown property for a TEXT node/);
  assert.equal(hex((await node(out.root.id)).fills[0]), "#FFFFFF", "the first update was not applied");

  const fillOnTop = await server.call("update_nodes", { updates: [{ nodeId: out.root.id, props: { width: "fill" } }] });
  assert.match(textOf(fillOnTop), /width: "fill" needs a parent with auto layout/);
  const missing = await server.call("update_nodes", { updates: [{ nodeId: "77:1", props: { name: "x" } }] });
  assert.match(textOf(missing), /updates\[0\]\.nodeId: no node with id "77:1"/);
});

test("update_nodes resizes text and switches fill to fixed", async () => {
  const out = jsonOf(await server.call("build_design", { spec: CARD }));
  const bodyId = out.nodes[2].id;
  await server.call("update_nodes", { updates: [{ nodeId: bodyId, props: { width: 200 } }] });
  const body = await node(bodyId);
  assert.equal(body.layoutSizingHorizontal, "FIXED");
  assert.equal(body.width, 200);
  assert.equal(body.textAutoResize, "HEIGHT");
});

test("h helpers in execute_code use the same builder", async () => {
  const result = await server.call("execute_code", {
    code: [
      "const list = await h.build({ type: 'frame', name: 'List', gap: 8 });",
      "for (const label of ['One', 'Two', 'Three']) {",
      "  await h.build({ type: 'text', text: label, width: 'fill' }, { parent: list });",
      "}",
      "await h.setText(list.children[0], 'First');",
      "await h.apply(list, { fill: '#F1F5F9', padding: 12 });",
      "const font = await h.font('Inter', 700);",
      "const dot = figma.createEllipse(); dot.fills = h.paint('#22C55E'); list.appendChild(dot);",
      "return { list, font, color: h.color('#FF0000') };",
    ].join("\n"),
  });
  assert.equal(result.isError, undefined, textOf(result));
  const out = jsonOf(result).result;
  assert.deepEqual(out.font, { family: "Inter", style: "Bold" });
  assert.deepEqual(out.color, { r: 1, g: 0, b: 0 });
  const list = await node(out.list.id);
  assert.deepEqual(list.children.slice(0, 3).map((c) => c.characters), ["First", "Two", "Three"]);
  assert.equal(list.paddingTop, 12);
  assert.equal(hex(list.children[3].fills[0]), "#22C55E");
  assert.equal(figma._test.undoDepth(), 1, "the whole script is one undo step");

  const bad = await server.call("execute_code", { code: "await h.build({ type: 'frame', colour: '#fff' });" });
  assert.match(textOf(bad), /spec\.colour: unknown property/);
});

test("screenshot: true returns an image, or a note while Figma is hidden", async () => {
  const result = await server.call("build_design", { spec: CARD, screenshot: true });
  assert.ok(imageOf(result), "image block");
  const out = jsonOf(result);
  assert.equal(out.screenshot.nodeId, out.root.id);
  assert.equal(out.screenshot.base64, undefined, "image data is not repeated in the text");

  const update = await server.call("update_nodes", { updates: [{ nodeId: out.nodes[1].id, props: { text: "Hi" } }], screenshot: true });
  assert.equal(jsonOf(update).screenshot.nodeId, out.root.id, "screenshots show the top-level frame");

  const exec = await server.call("execute_code", { code: `return await figma.getNodeByIdAsync("${out.nodes[1].id}");`, screenshot: true });
  assert.equal(jsonOf(exec).screenshot.nodeId, out.root.id);

  plugin.setHidden(true);
  try {
    const hidden = await server.call("build_design", { spec: { type: "frame" }, screenshot: true });
    assert.equal(hidden.isError, undefined);
    assert.equal(imageOf(hidden), undefined);
    assert.match(jsonOf(hidden).screenshot.skipped, /window is hidden/);
  } finally {
    plugin.setHidden(false);
  }
});

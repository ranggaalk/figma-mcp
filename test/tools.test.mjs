// Read tools, export and execute_code.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { connectPlugin, imageOf, jsonOf, loadFonts, sleep, startServer, textOf } from "./helpers.mjs";
import { createMockFigma, PNG_1X1 } from "./mock-figma.mjs";

const PORT = 3902;
let server;
let plugin;
let figma;
let ids;

async function buildFixture(figma) {
  await loadFonts(figma);
  const t = figma._test;
  const collection = t.makeCollection("Tokens");
  const bg = t.makeVariable("color/bg", collection, "COLOR");
  bg.setValueForMode(collection.defaultModeId, { r: 1, g: 1, b: 1, a: 1 });
  const surface = t.makeVariable("color/surface", collection, "COLOR");
  surface.setValueForMode(collection.defaultModeId, { type: "VARIABLE_ALIAS", id: bg.id });
  const brand = t.makeStyle("PAINT", "Brand/Primary", { paints: [figma.util.solidPaint("#3366FF")] });
  t.makeStyle("TEXT", "Heading", {
    fontName: { family: "Inter", style: "Bold" },
    fontSize: 24,
    lineHeight: { unit: "AUTO" },
    letterSpacing: { unit: "PERCENT", value: 0 },
  });

  return t.setup(() => {
    const card = figma.createFrame();
    card.name = "Card";
    card.layoutMode = "VERTICAL";
    card.layoutSizingHorizontal = "FIXED";
    card.resize(320, 200);
    card.layoutSizingVertical = "HUG";
    card.itemSpacing = 8;
    card.paddingTop = card.paddingRight = card.paddingBottom = card.paddingLeft = 16;
    card.strokes = [figma.util.solidPaint("#E6E6E6")];
    card.strokeWeight = figma.mixed;
    card.cornerRadius = 12;
    card.effects = [{ type: "DROP_SHADOW", radius: 8, offset: { x: 0, y: 2 }, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.15 }, visible: true, blendMode: "NORMAL" }];

    const title = figma.createText();
    title.fontName = { family: "Inter", style: "Bold" };
    title.characters = "Hello";
    title.fontSize = 18;
    card.appendChild(title);
    title.layoutSizingHorizontal = "FILL";
    title.fills = [figma.variables.setBoundVariableForPaint(figma.util.solidPaint("#000000"), "color", bg)];
    title._p.fillStyleId = brand.id;
    figma.currentPage.selection = [card];
    return { card: card.id, title: title.id };
  });
}

before(async () => {
  server = await startServer({ port: PORT });
  figma = createMockFigma();
  ids = await buildFixture(figma);
  plugin = await connectPlugin({ port: PORT, figma });
});
after(async () => {
  await plugin.close();
  await server.close();
});

test("all tools are registered", async () => {
  const { tools } = await server.client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of ["get_status", "get_document_info", "get_selection", "get_node", "get_styles", "export_node", "execute_code"]) {
    assert.ok(names.includes(name), `${name} missing from ${names}`);
  }
});

test("get_status reports file, page, window and versions", async () => {
  const status = jsonOf(await server.call("get_status"));
  assert.equal(status.connected, true);
  assert.equal(status.fileName, "Test File");
  assert.equal(status.figmaWindowVisible, true);
  assert.equal(status.bridge.connections[0].pageName, "Page 1");
  assert.equal(status.pluginVersion, status.bridge.serverVersion);
});

test("get_document_info lists pages and top-level nodes", async () => {
  const info = jsonOf(await server.call("get_document_info"));
  assert.equal(info.pages.length, 1);
  assert.equal(info.topLevelNodes[0].id, ids.card);
});

test("get_selection serializes layout, paints, effects, text and bindings", async () => {
  const [card] = jsonOf(await server.call("get_selection", { depth: 1 }));
  assert.equal(card.fills[0].color, "#FFFFFF");
  assert.equal(card.strokeWeight, "mixed");
  assert.equal(card.layoutMode, "VERTICAL");
  assert.equal(card.paddingTop, 16);
  assert.equal(card.itemSpacing, 8);
  assert.equal(card.effects[0].color, "#00000026");
  assert.equal(card.cornerRadius, 12);
  assert.equal(card.layoutSizingHorizontal, undefined, "FIXED is the default and left out");
  assert.equal(card.layoutSizingVertical, "HUG");
  const title = card.children[0];
  assert.equal(title.characters, "Hello");
  assert.deepEqual(title.fontName, { family: "Inter", style: "Bold" });
  assert.equal(title.layoutSizingHorizontal, "FILL");
  assert.match(title.boundVariables.fills[0], /^VariableID:/);
  assert.match(title.fillStyleId, /^S:/);
});

test("depth 0 gives a childCount instead of children", async () => {
  const [card] = jsonOf(await server.call("get_selection", { depth: 0 }));
  assert.equal(card.childCount, 1);
  assert.equal(card.children, undefined);
});

test("get_node accepts URL-style ids, pages and reports missing nodes", async () => {
  const title = jsonOf(await server.call("get_node", { nodeId: ids.title.replace(":", "-") }));
  assert.equal(title.id, ids.title);
  assert.equal(title.type, "TEXT");
  const page = jsonOf(await server.call("get_node", { nodeId: "0:1", depth: 1 }));
  assert.equal(page.children.length, 1);
  const missing = await server.call("get_node", { nodeId: "404:1" });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /No node with id/);
});

test("get_styles returns styles and variables (aliases resolved to ids)", async () => {
  const styles = jsonOf(await server.call("get_styles"));
  assert.equal(styles.paintStyles[0].paints[0].color, "#3366FF");
  assert.equal(styles.textStyles[0].fontSize, 24);
  const vars = styles.variableCollections[0].variables;
  assert.equal(Object.values(vars[0].valuesByMode)[0], "#FFFFFF");
  assert.equal(Object.values(vars[1].valuesByMode)[0].alias, vars[0].id);
  const without = jsonOf(await server.call("get_styles", { includeVariables: false }));
  assert.equal(without.variableCollections, undefined);
});

test("export_node returns a PNG and respects maxSize", async () => {
  const result = await server.call("export_node", { nodeId: ids.card, scale: 2, maxSize: 400 });
  const image = imageOf(result);
  assert.equal(image.mimeType, "image/png");
  assert.ok(Buffer.from(image.data, "base64").equals(PNG_1X1));
  assert.equal(JSON.parse(result.content[1].text).scale, 1.25);
  assert.equal(JSON.parse((await server.call("export_node")).content[1].text).nodeId, ids.card, "defaults to the selection");
  assert.equal(JSON.parse((await server.call("export_node", { nodeId: "0:1" })).content[1].text).width, 336, "a page uses its drawn bounds, shadow included");
});

test("export fails fast with an explanation while the Figma window is hidden", async () => {
  plugin.setHidden(true);
  const card = await figma.getNodeByIdAsync(ids.card);
  const realExport = card.exportAsync;
  card.exportAsync = () => new Promise(() => {});
  try {
    assert.equal(jsonOf(await server.call("get_status")).figmaWindowVisible, false);
    const started = Date.now();
    const result = await server.call("export_node", { nodeId: ids.card });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /currently hidden/);
    assert.ok(Date.now() - started < 12000);
  } finally {
    card.exportAsync = realExport;
    plugin.setHidden(false);
  }
  assert.ok(imageOf(await server.call("export_node", { nodeId: ids.card })));
});

test("execute_code runs modern syntax and TypeScript, returns nodes and logs", async () => {
  const result = await server.call("execute_code", {
    code: [
      "const opts: { name?: string } | undefined = undefined;",
      "const frame = figma.createFrame();",
      'frame.name = opts?.name ?? "Hero";',
      "const merged = { ...{ a: 1 }, b: 2 };",
      'console.log("created", frame);',
      'console.warn("careful");',
      "return { frame, merged, weight: figma.mixed, list: [frame.id] };",
    ].join("\n"),
  });
  const out = jsonOf(result);
  assert.equal(out.result.merged.b, 2);
  assert.equal(out.result.frame.name, "Hero");
  assert.equal(out.result.frame.width, 100);
  assert.equal(out.result.weight, "mixed");
  assert.match(out.logs[0], /^created \{/);
  assert.equal(out.logs[1], "[warn] careful");
});

test("execute_code reports syntax errors with the right line, and runtime errors with logs", async () => {
  const syntax = await server.call("execute_code", { code: "const a = 1;\nconst b = ;\nreturn a;" });
  assert.equal(syntax.isError, true);
  assert.match(textOf(syntax), /line 2/);
  assert.match(textOf(syntax), /not run/);

  const runtime = await server.call("execute_code", { code: 'console.log("step 1");\nthrow new Error("boom");' });
  assert.equal(runtime.isError, true);
  assert.match(textOf(runtime), /boom/);
  assert.match(textOf(runtime), /step 1/);
});

test("execute_code returns arrays of nodes as summaries, and tolerates no return", async () => {
  const out = jsonOf(await server.call("execute_code", { code: "return figma.currentPage.selection;" }));
  assert.equal(out.result[0].id, ids.card);
  const none = await server.call("execute_code", { code: "figma.currentPage.name;" });
  assert.equal(none.isError, undefined);
});

test("each execute_code call is its own undo step", async () => {
  const before = figma._test.undoDepth();
  await server.call("execute_code", { code: "figma.createRectangle();" });
  assert.equal(figma._test.undoDepth(), before + 1);
  await sleep(10);
});

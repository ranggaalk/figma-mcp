// Components, instances, variables, styles, team libraries, catalogs and images.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { connectPlugin, jsonOf, loadFonts, makePng, ROOT, startServer, textOf } from "./helpers.mjs";
import { createMockFigma } from "./mock-figma.mjs";

const PORT = 3905;
const DATA_DIR = mkdtempSync(join(tmpdir(), "figma-bridge-data-"));
const FILES = mkdtempSync(join(tmpdir(), "figma-bridge-files-"));
const LIB_COMPONENT_KEY = "a".repeat(40);
const LIB_STYLE_KEY = "b".repeat(40);

let server;
let plugin;
let figma;
const ids = {};

const node = (id) => figma.getNodeByIdAsync(id);
const build = (spec, extra = {}) => server.call("build_design", { spec, ...extra });
const hex = (paint) =>
  "#" + ["r", "g", "b"].map((c) => Math.round(paint.color[c] * 255).toString(16).padStart(2, "0")).join("").toUpperCase();

async function buildFixture() {
  await loadFonts(figma, ["Regular", "Medium", "Bold"]);
  const t = figma._test;
  const tokens = t.makeCollection("Tokens");
  const set = (variable, value) => variable.setValueForMode(tokens.defaultModeId, value);
  set(t.makeVariable("color/primary", tokens, "COLOR"), { r: 0.31, g: 0.27, b: 0.9, a: 1 });
  set(t.makeVariable("color/surface", tokens, "COLOR"), { r: 1, g: 1, b: 1, a: 1 });
  set(t.makeVariable("spacing/4", tokens, "FLOAT"), 16);
  set(t.makeVariable("radius/md", tokens, "FLOAT"), 8);
  const dark = t.makeCollection("Dark");
  t.makeVariable("color/primary", dark, "COLOR").setValueForMode(dark.defaultModeId, { r: 0.5, g: 0.5, b: 1, a: 1 });

  t.makeStyle("PAINT", "Brand/Accent", { paints: [figma.util.solidPaint("#F59E0B")], publishStatus: "CURRENT" });
  t.makeStyle("TEXT", "Heading/H2", {
    fontName: { family: "Inter", style: "Bold" },
    fontSize: 24,
    lineHeight: { unit: "PIXELS", value: 32 },
    letterSpacing: { unit: "PERCENT", value: 0 },
  });
  t.makeStyle("EFFECT", "Shadow/Card", {
    effects: [{ type: "DROP_SHADOW", radius: 16, offset: { x: 0, y: 4 }, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.1 }, visible: true, blendMode: "NORMAL" }],
  });

  t.setup(() => {
    // A Button component set with Size × State variants, a Label text property and a Show icon boolean.
    const variants = ["Size=Small, State=Default", "Size=Large, State=Default", "Size=Large, State=Hover"].map((name) => {
      const c = figma.createComponent();
      c.name = name;
      c.layoutMode = "HORIZONTAL";
      c.layoutSizingHorizontal = "HUG";
      c.layoutSizingVertical = "HUG";
      const label = figma.createText();
      label.name = "Label";
      label.fontName = { family: "Inter", style: "Medium" };
      label.characters = "Button";
      c.appendChild(label);
      return c;
    });
    const buttonSet = figma.combineAsVariants(variants, figma.currentPage);
    buttonSet.name = "Button";
    variants[0].addComponentProperty("Label", "TEXT", "Button");
    variants[0].addComponentProperty("Show icon", "BOOLEAN", true);
    ids.button = buttonSet.id;

    // A plain Avatar component on another page.
    const page = figma.createPage();
    page.name = "Components";
    const avatar = figma.createComponent();
    avatar.name = "Avatar";
    avatar.layoutMode = "VERTICAL";
    const initials = figma.createText();
    initials.name = "Initials";
    initials.characters = "AB";
    avatar.appendChild(initials);
    page.appendChild(avatar);
    ids.avatar = avatar.id;
  });

  // A library component already used in the file.
  const libraryComponent = await figma.importComponentByKeyAsync(LIB_COMPONENT_KEY);
  t.setup(() => libraryComponent.createInstance());
  t.resetUndo();
}

before(async () => {
  server = await startServer({ port: PORT, env: { FIGMA_BRIDGE_DATA_DIR: DATA_DIR } });
  figma = createMockFigma({
    library: {
      components: [{ key: LIB_COMPONENT_KEY, name: "Library Card", type: "COMPONENT", width: 200, height: 100 }],
      styles: [{ key: LIB_STYLE_KEY, type: "PAINT", name: "Lib/Danger", paints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 1, visible: true }] }],
      variableCollections: [
        {
          key: "c".repeat(40),
          name: "Lib Tokens",
          libraryName: "Design System",
          variables: [{ key: "d".repeat(40), name: "color/danger", resolvedType: "COLOR", value: { r: 0.9, g: 0.1, b: 0.1, a: 1 } }],
        },
      ],
    },
  });
  await buildFixture();
  plugin = await connectPlugin({ port: PORT, figma });
});
after(async () => {
  await plugin.close();
  await server.close();
});

test("get_components lists local components, variants, properties and used library components", async () => {
  const out = jsonOf(await server.call("get_components"));
  const button = out.local.find((c) => c.name === "Button");
  assert.equal(button.type, "COMPONENT_SET");
  assert.equal(button.variantCount, 3);
  assert.deepEqual(button.properties.Size.variantOptions, ["Small", "Large"]);
  assert.ok(Object.keys(button.properties).some((k) => k.startsWith("Label#")));
  const avatar = out.local.find((c) => c.name === "Avatar");
  assert.equal(avatar.page, "Components", "components on other pages are found");
  assert.deepEqual(out.usedFromLibraries.map((c) => [c.name, c.usedCount]), [["Library Card", 1]]);
  assert.match(out.libraryCatalogsHint, /save_library_catalog/);

  const filtered = jsonOf(await server.call("get_components", { query: "butt" }));
  assert.deepEqual(filtered.local.map((c) => c.name), ["Button"]);
});

test("instances pick a variant, set properties and override text layers", async () => {
  const result = await build({
    type: "frame",
    gap: 8,
    children: [
      { type: "instance", name: "Save", component: "Button", variant: { Size: "Large" }, props: { Label: "Save", "Show icon": false } },
      { type: "instance", component: "button", props: { State: "Hover", Size: "Large" }, width: "fill" },
      { type: "instance", component: "Avatar", texts: { Initials: "RA" } },
      { type: "instance", component: LIB_COMPONENT_KEY },
    ],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const out = jsonOf(result);
  const save = await node(out.nodes[1].id);
  assert.equal(save.name, "Save");
  assert.equal((await save.getMainComponentAsync()).name, "Size=Large, State=Default");
  const props = save.componentProperties;
  const label = Object.keys(props).find((k) => k.startsWith("Label#"));
  const icon = Object.keys(props).find((k) => k.startsWith("Show icon#"));
  assert.equal(props[label].value, "Save");
  assert.equal(props[icon].value, false);

  const hover = await node(out.nodes[2].id);
  assert.equal((await hover.getMainComponentAsync()).name, "Size=Large, State=Hover", "variant values given in props work too");
  assert.equal(hover.layoutSizingHorizontal, "FILL");

  const avatar = await node(out.nodes[3].id);
  assert.equal(avatar.findOne((n) => n.name === "Initials").characters, "RA");
  const card = await node(out.nodes[4].id);
  assert.equal((await card.getMainComponentAsync()).name, "Library Card", "imported by key");
});

test("instance mistakes list what is available", async () => {
  const cases = [
    [{ type: "instance", component: "Buton" }, /no component named "Buton" in this file\. Similar: "Button"/],
    [{ type: "instance", component: "Button", variant: { Size: "Huge" } }, /variant\.Size: "Huge" is not an option; options: Small, Large/],
    [{ type: "instance", component: "Button", variant: { Color: "Red" } }, /has no variant property "Color"; .*Size \(variant: Small \| Large\)/],
    [{ type: "instance", component: "Button", props: { Text: "x" } }, /props\.Text: "Button" has no property "Text"; .*Label \(text\)/],
    [{ type: "instance", component: "Button", props: { "Show icon": "no" } }, /props\.Show icon: must be true or false/],
    [{ type: "instance", component: "Button", variant: { Size: "Small", State: "Hover" } }, /no variant of "Button" has/],
    [{ type: "instance", component: "Avatar", variant: { Size: "Large" } }, /"Avatar" is a single component without variants/],
    [{ type: "instance", component: "Avatar", texts: { Name: "x" } }, /texts\.Name: no text layer named "Name"; text layers: Initials/],
    [{ type: "instance", component: "f".repeat(40) }, /no published component or component set with key/],
    [{ type: "instance" }, /an instance needs "component"/],
  ];
  const before = figma.currentPage.children.length;
  for (const [spec, expected] of cases) {
    const result = await build(spec);
    assert.equal(result.isError, true, JSON.stringify(spec));
    assert.match(textOf(result), expected);
  }
  assert.equal(figma.currentPage.children.length, before, "nothing was created");
});

test("colors, spacing and radii bind to variables; styles apply by name", async () => {
  const result = await build({
    type: "frame",
    fill: { variable: "Tokens/color/primary" },
    stroke: { style: "Brand/Accent" },
    gap: { variable: "spacing/4" },
    padding: [{ variable: "spacing/4" }, 24],
    radius: { variable: "radius/md" },
    effectStyle: "Shadow/Card",
    children: [
      { type: "text", text: "Title", textStyle: "Heading/H2", color: { variable: "color/surface" } },
      { type: "text", spans: [{ text: "Plain " }, { text: "bold", weight: 700, color: { variable: "color/surface" } }], textStyle: "Heading/H2" },
    ],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const out = jsonOf(result);
  const frame = await node(out.root.id);
  assert.match(frame.boundVariables.fills[0].id, /^VariableID:/);
  assert.equal(hex(frame.fills[0]), "#4F45E6");
  assert.match(frame.strokeStyleId, /^S:/);
  assert.equal(frame.itemSpacing, 16);
  assert.ok(frame.boundVariables.itemSpacing, "gap is bound");
  assert.equal(frame.paddingTop, 16);
  assert.ok(frame.boundVariables.paddingTop);
  assert.equal(frame.paddingRight, 24);
  assert.equal(frame.boundVariables.paddingRight, undefined);
  assert.equal(frame.topLeftRadius, 8);
  assert.ok(frame.boundVariables.bottomRightRadius);
  assert.match(frame.effectStyleId, /^S:/);
  const title = await node(out.nodes[1].id);
  assert.match(title.textStyleId, /^S:/);
  assert.deepEqual(title.fontName, { family: "Inter", style: "Bold" });
  assert.equal(title.fontSize, 24);
  assert.ok(title.boundVariables.fills);
});

test("token mistakes are explained", async () => {
  const cases = [
    [{ type: "frame", fill: { variable: "spacing/4" } }, /variable "spacing\/4" is a FLOAT variable, but this property needs a color \(COLOR\) variable/],
    [{ type: "frame", fill: { variable: "color/primary" } }, /"color\/primary" matches several color variables: Tokens\/color\/primary, Dark\/color\/primary/],
    [{ type: "frame", gap: { variable: "spacing/5" } }, /no number variable named "spacing\/5" .*Similar: "spacing\/4"/],
    [{ type: "frame", stroke: { style: "Brand/Accnt" } }, /no local paint style named "Brand\/Accnt"\. Similar: "Brand\/Accent"/],
    [{ type: "text", text: "x", textStyle: "Heading/H2", size: 30 }, /spec\.size: textStyle already sets the font/],
    [{ type: "frame", shadow: { y: 2 }, effectStyle: "Shadow/Card" }, /use either "shadow" or "effectStyle"/],
    [{ type: "frame", fill: { color: "#fff" } }, /spec\.fill: must be a color such as/],
  ];
  for (const [spec, expected] of cases) {
    const result = await build(spec);
    assert.equal(result.isError, true, JSON.stringify(spec));
    assert.match(textOf(result), expected);
  }
});

test("library variables and styles are imported when used", async () => {
  const result = await build({ type: "frame", fill: { variable: "color/danger" }, stroke: { style: LIB_STYLE_KEY } });
  assert.equal(result.isError, undefined, textOf(result));
  const frame = await node(jsonOf(result).root.id);
  const variable = await figma.variables.getVariableByIdAsync(frame.boundVariables.fills[0].id);
  assert.equal(variable.name, "color/danger");
  assert.equal(variable.remote, true);
  assert.equal(hex(frame.strokes[0]), "#FF0000");
});

test("update_nodes switches variants, sets properties and texts on instances", async () => {
  const out = jsonOf(await build({ type: "instance", component: "Button", variant: { Size: "Large" } }));
  const id = out.root.id;
  const result = await server.call("update_nodes", {
    updates: [{ nodeId: id, props: { variant: { Size: "Small" }, props: { Label: "Cancel" }, texts: { Label: "Cancel" } } }],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const instance = await node(id);
  assert.equal((await instance.getMainComponentAsync()).name, "Size=Small, State=Default");
  assert.equal(instance.findOne((n) => n.name === "Label").characters, "Cancel");

  const bad = await server.call("update_nodes", { updates: [{ nodeId: id, props: { variant: { Size: "XL" } } }] });
  assert.match(textOf(bad), /updates\[0\]\.props\.variant\.Size: "XL" is not an option/);
});

test("place_image adds image files and returns a reusable hash", async () => {
  const png = join(FILES, "hero.png");
  writeFileSync(png, makePng(400, 300));
  const placed = jsonOf(await server.call("place_image", { path: png, width: 200 }));
  assert.equal(placed.imageWidth, 400);
  assert.equal(placed.node.name, "hero");
  assert.deepEqual([placed.node.width, placed.node.height], [200, 150]);
  const rect = await node(placed.node.id);
  assert.equal(rect.fills[0].type, "IMAGE");
  assert.equal(rect.fills[0].imageHash, placed.imageHash);

  const card = jsonOf(
    await build({ type: "frame", children: [{ type: "rect", width: 120, height: 80, fill: { image: placed.imageHash, scaleMode: "fit" } }] }),
  );
  const filled = await node(card.nodes[1].id);
  assert.deepEqual([filled.fills[0].type, filled.fills[0].scaleMode], ["IMAGE", "FIT"]);

  const into = jsonOf(await server.call("place_image", { path: png, nodeId: card.root.id, scaleMode: "crop" }));
  assert.equal(into.node.id, card.root.id);
  assert.equal((await node(card.root.id)).fills[0].scaleMode, "CROP");

  const missingHash = await build({ type: "rect", width: 1, height: 1, fill: { image: "0".repeat(40) } });
  assert.match(textOf(missingHash), /no image with hash .* place_image first/);
  const missingFile = await server.call("place_image", { path: join(FILES, "nope.png") });
  assert.match(textOf(missingFile), /No file at/);
  writeFileSync(join(FILES, "notes.txt"), "hello");
  const notImage = await server.call("place_image", { path: join(FILES, "notes.txt") });
  assert.match(textOf(notImage), /not a PNG, JPEG or GIF/);
});

test("Windows paths are read through /mnt", async () => {
  const { normalizeImagePath } = await import(ROOT + "dist/images.js");
  assert.equal(normalizeImagePath("C:\\Users\\me\\logo.png"), "/mnt/c/Users/me/logo.png");
  assert.equal(normalizeImagePath("D:/art/x.jpg"), "/mnt/d/art/x.jpg");
});

test("save_library_catalog makes this file's components and styles findable elsewhere", async () => {
  const saved = jsonOf(await server.call("save_library_catalog"));
  assert.equal(saved.library, "Test File");
  assert.ok(saved.components >= 2);
  assert.ok(saved.unpublished > 0);
  assert.match(saved.hint, /not published yet/);
  const files = readdirSync(join(DATA_DIR, "libraries"));
  assert.deepEqual(files, ["test-file.json"]);
  const catalog = JSON.parse(readFileSync(join(DATA_DIR, "libraries", files[0]), "utf8"));
  const button = catalog.components.find((c) => c.name === "Button");
  assert.equal(button.key.length, 40);
  assert.equal(button.id, undefined, "node ids are dropped");
  assert.ok(button.properties.Size);
  assert.equal(catalog.styles.find((s) => s.name === "Brand/Accent").published, "CURRENT");

  const components = jsonOf(await server.call("get_components", { query: "avatar" }));
  assert.equal(components.libraryCatalogs[0].library, "Test File");
  assert.equal(components.libraryCatalogs[0].components[0].name, "Avatar");

  const styles = jsonOf(await server.call("get_styles", { includeLibraries: true }));
  assert.equal(styles.libraryVariables[0].library, "Design System");
  assert.equal(styles.libraryVariables[0].variables[0].name, "color/danger");
  assert.equal(styles.libraryCatalogStyles[0].library, "Test File");
});

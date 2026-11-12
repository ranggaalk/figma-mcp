// check_design, the automatic check in build_design / update_nodes, and find_nodes.

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { connectPlugin, jsonOf, loadFonts, startServer, textOf } from "./helpers.mjs";
import { createMockFigma } from "./mock-figma.mjs";

const PORT = 3906;
let server;
let plugin;
let figma;

const check = async (nodeId, extra = {}) => jsonOf(await server.call("check_design", { nodeId, ...extra }));
const rules = (report) => report.issues.map((i) => i.rule);

before(async () => {
  server = await startServer({ port: PORT });
  figma = createMockFigma();
  await loadFonts(figma, ["Regular", "Bold"]);
  plugin = await connectPlugin({ port: PORT, figma });
});
after(async () => {
  await plugin.close();
  await server.close();
});
beforeEach(() => {
  figma._test.setup(() => {
    for (const child of figma.currentPage.children) child.remove();
  });
});

/** A white screen frame without auto layout, for placing test content. */
function screen(build) {
  return figma._test.setup(() => {
    const frame = figma.createFrame();
    frame.name = "Screen";
    frame.resize(400, 400);
    frame.clipsContent = false;
    const ids = build(frame) || {};
    return { screen: frame.id, ...ids };
  });
}

function text(parent, characters, { name = "Label", size = 16, color = "#111111" } = {}) {
  const t = figma.createText();
  t.name = name;
  t.characters = characters;
  t.fontSize = size;
  t.fills = [figma.util.solidPaint(color)];
  parent.appendChild(t);
  return t;
}

test("finds the auto-layout frame left at the default 100 px", async () => {
  const ids = screen((s) => {
    const row = figma.createFrame();
    row.name = "Divider";
    row.fills = [];
    row.layoutMode = "HORIZONTAL"; // the counter axis stays fixed at 100
    s.appendChild(row);
    text(row, "or");
    return { row: row.id };
  });
  const report = await check(ids.screen);
  const issue = report.issues.find((i) => i.rule === "default-size");
  assert.ok(issue, JSON.stringify(report));
  assert.equal(issue.nodeId, ids.row);
  assert.equal(issue.path, "Screen / Divider");
  assert.match(issue.message, /Height is still Figma's default 100 px/);
  assert.match(issue.suggestion, /"hug"/);
});

test("finds text that does not fit its fixed box, and missing fonts", async () => {
  const ids = screen((s) => {
    const t = text(s, "A rather long sentence that cannot fit into ten pixels of height.");
    t.resize(100, 10);
    const missing = text(s, "Legacy", { name: "Legacy" });
    figma._test.forceFont(missing, { family: "Comic Neue", style: "Bold" });
    return { overflow: t.id, missing: missing.id };
  });
  const report = await check(ids.screen);
  const overflow = report.issues.find((i) => i.rule === "text-overflow");
  assert.equal(overflow.severity, "error");
  assert.equal(overflow.nodeId, ids.overflow);
  const missing = report.issues.find((i) => i.rule === "missing-font");
  assert.equal(missing.nodeId, ids.missing);
  assert.equal(report.issues[0].severity, "error", "errors come first");
});

test("finds clipped content and children sticking out of auto layout", async () => {
  const ids = screen((s) => {
    const clip = figma.createFrame();
    clip.name = "Clip";
    clip.resize(100, 50);
    clip.clipsContent = true;
    s.appendChild(clip);
    const wide = figma.createRectangle();
    wide.name = "Wide";
    wide.resize(200, 20);
    clip.appendChild(wide);

    const stack = figma.createFrame();
    stack.name = "Stack";
    stack.clipsContent = false;
    stack.layoutMode = "VERTICAL";
    stack.layoutSizingHorizontal = "FIXED";
    stack.resize(100, 100);
    stack.layoutSizingVertical = "HUG";
    s.appendChild(stack);
    const big = figma.createRectangle();
    big.name = "Big";
    big.resize(300, 20);
    stack.appendChild(big);
    return { wide: wide.id, big: big.id };
  });
  const report = await check(ids.screen);
  assert.equal(report.issues.find((i) => i.rule === "clipped").nodeId, ids.wide);
  assert.equal(report.issues.find((i) => i.rule === "overflow").nodeId, ids.big);
});

test("shadows that extend past a parent are not overflow", async () => {
  // Found in Figma: cards with a drop shadow were reported as sticking out,
  // because render bounds include the shadow.
  const out = jsonOf(
    await server.call("build_design", {
      spec: {
        type: "frame",
        width: 390,
        padding: 24,
        children: [
          {
            type: "frame",
            name: "Section",
            width: "fill",
            children: [{ type: "frame", name: "Card", width: "fill", padding: 16, shadow: { y: 2, blur: 8 }, children: [{ type: "text", text: "Row" }] }],
          },
        ],
      },
    }),
  );
  assert.equal(out.check, undefined, JSON.stringify(out.check));
  const card = await figma.getNodeByIdAsync(out.nodes[2].id);
  assert.ok(card.absoluteRenderBounds.width > card.width, "the mock draws the shadow outside the box, as Figma does");
});

test("flags low text contrast against the background it sits on", async () => {
  const ids = screen((s) => {
    const pale = text(s, "Pale", { name: "Pale", color: "#CCCCCC" });
    const dark = text(s, "Dark", { name: "Dark", color: "#111111" });
    const banner = figma.createFrame();
    banner.name = "Banner";
    banner.fills = [figma.util.solidPaint("#1E293B")];
    s.appendChild(banner);
    const onDark = text(banner, "Light on dark", { name: "OnDark", color: "#FFFFFF" });
    const big = text(s, "Large and grey", { name: "Large", color: "#949494", size: 28 });
    return { pale: pale.id, dark: dark.id, onDark: onDark.id, big: big.id };
  });
  const report = await check(ids.screen);
  const contrast = report.issues.filter((i) => i.rule === "contrast");
  assert.deepEqual(contrast.map((i) => i.nodeId), [ids.pale]);
  assert.match(contrast[0].message, /Contrast 1\.6\d?:1 against #FFFFFF is below WCAG AA \(4\.5:1/);
});

test("design-token rules only apply when the file has tokens", async () => {
  const plain = screen((s) => {
    const box = figma.createRectangle();
    box.fills = [figma.util.solidPaint("#4F46E5")];
    s.appendChild(box);
  });
  assert.ok(!rules(await check(plain.screen)).some((r) => r === "off-palette" || r === "unlinked-token"));

  const style = figma._test.makeStyle("PAINT", "Brand/Primary", { paints: [figma.util.solidPaint("#4F46E5")] });
  figma._test.makeStyle("TEXT", "Body", { fontName: { family: "Inter", style: "Regular" }, fontSize: 16, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 } });
  try {
    const ids = screen((s) => {
      const same = figma.createRectangle();
      same.name = "Same";
      same.fills = [figma.util.solidPaint("#4F46E5")];
      s.appendChild(same);
      const other = figma.createRectangle();
      other.name = "Other";
      other.fills = [figma.util.solidPaint("#123456")];
      s.appendChild(other);
      const linked = figma.createRectangle();
      linked.name = "Linked";
      s.appendChild(linked);
      return { same: same.id, other: other.id, linked: linked.id };
    });
    const linked = await figma.getNodeByIdAsync(ids.linked);
    await figma._test.setup(() => linked.setFillStyleIdAsync(style.id));
    const report = await check(ids.screen);
    const unlinked = report.issues.find((i) => i.rule === "unlinked-token");
    assert.equal(unlinked.nodeId, ids.same);
    assert.match(unlinked.message, /equals style "Brand\/Primary"/);
    assert.ok(report.issues.some((i) => i.rule === "off-palette" && i.nodeId === ids.other));
    assert.ok(!report.issues.some((i) => i.nodeId === ids.linked), "linked colors are fine");

    const withText = screen((s) => text(s, "Hello"));
    assert.ok(rules(await check(withText.screen)).includes("unstyled-text"));
    const errorsOnly = await check(ids.screen, { minSeverity: "warning" });
    assert.ok(!errorsOnly.issues.some((i) => i.severity === "info"));
  } finally {
    for (const s of [...(await figma.getLocalPaintStylesAsync()), ...(await figma.getLocalTextStylesAsync())]) s.remove();
  }
});

test("default layer names are reported, instance contents are not", async () => {
  const ids = screen((s) => {
    const unnamed = figma.createFrame();
    unnamed.name = "Frame 12";
    unnamed.resize(10, 10);
    s.appendChild(unnamed);
    const component = figma.createComponent();
    component.name = "Chip";
    component.resize(20, 20);
    const inner = figma.createRectangle();
    inner.name = "Rectangle 3";
    inner.resize(10, 10);
    component.appendChild(inner);
    const instance = component.createInstance();
    s.appendChild(instance);
    return { unnamed: unnamed.id };
  });
  const report = await check(ids.screen);
  const names = report.issues.filter((i) => i.rule === "default-name");
  assert.deepEqual(names.map((i) => i.nodeId), [ids.unnamed]);
});

test("build_design and update_nodes report problems right away", async () => {
  const bad = jsonOf(
    await server.call("build_design", {
      spec: { type: "frame", children: [{ type: "text", text: "Far too much text for this tiny box", width: 60, height: 10 }] },
    }),
  );
  assert.equal(bad.check.problems[0].rule, "text-overflow");
  assert.equal(bad.check.problems[0].nodeId, bad.nodes[1].id);

  const good = jsonOf(await server.call("build_design", { spec: { type: "frame", padding: 16, children: [{ type: "text", text: "Fine" }] } }));
  assert.equal(good.check, undefined, "no check field when nothing is wrong");

  const updated = jsonOf(await server.call("update_nodes", { updates: [{ nodeId: good.nodes[1].id, props: { color: "#EEEEEE" } }] }));
  assert.equal(updated.check.problems[0].rule, "contrast");
});

test("check_design checks the selection by default and refuses whole pages", async () => {
  const ids = screen(() => {});
  figma.currentPage.selection = [await figma.getNodeByIdAsync(ids.screen)];
  assert.equal((await check(undefined)).root.id, ids.screen);
  const page = await server.call("check_design", { nodeId: "0:1" });
  assert.match(textOf(page), /not a whole page/);
});

test("find_nodes searches by name, text and type, in a node or across pages", async () => {
  const ids = screen((s) => {
    const card = figma.createFrame();
    card.name = "Pricing card";
    s.appendChild(card);
    text(card, "Upgrade to Pro", { name: "Title" });
    text(card, "Cancel anytime", { name: "Note" });
    const other = figma.createPage();
    other.name = "Archive";
    const old = figma.createFrame();
    old.name = "Old pricing card";
    other.appendChild(old);
    return { card: card.id };
  });

  const byName = jsonOf(await server.call("find_nodes", { query: "pricing" }));
  assert.deepEqual(byName.nodes.map((n) => n.name), ["Pricing card"]);
  assert.equal(byName.nodes[0].path, "Screen");

  const byText = jsonOf(await server.call("find_nodes", { text: "upgrade" }));
  assert.equal(byText.nodes[0].name, "Title");
  assert.equal(byText.nodes[0].characters, "Upgrade to Pro");

  const texts = jsonOf(await server.call("find_nodes", { types: ["text"], withinNodeId: ids.card }));
  assert.deepEqual(texts.nodes.map((n) => n.name), ["Title", "Note"]);

  const everywhere = jsonOf(await server.call("find_nodes", { query: "pricing", allPages: true }));
  assert.deepEqual(everywhere.nodes.map((n) => [n.name, n.page]), [["Pricing card", "Page 1"], ["Old pricing card", "Archive"]]);

  const limited = jsonOf(await server.call("find_nodes", { types: ["TEXT"], limit: 1 }));
  assert.equal(limited.total, 2);
  assert.equal(limited.omitted, 1);

  const wrong = await server.call("find_nodes", { text: "x", types: ["FRAME"] });
  assert.match(textOf(wrong), /"text" only matches TEXT nodes/);
});

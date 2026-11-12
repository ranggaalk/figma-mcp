// Built-in skills: the get_skill tool, skill:// resources and prompts.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { connectPlugin, jsonOf, ROOT, startServer, textOf } from "./helpers.mjs";
import { createMockFigma } from "./mock-figma.mjs";

const PORT = 3907;
const SKILLS = ["accessibility", "design-direction", "design-system", "ux-writing"];
let server;

before(async () => {
  server = await startServer({ port: PORT });
});
after(() => server.close());

test("get_skill lists the skills and reads one", async () => {
  const list = jsonOf(await server.call("get_skill"));
  assert.deepEqual(list.skills.map((s) => s.name), SKILLS);
  for (const skill of list.skills) {
    assert.ok(skill.description.length > 40, `${skill.name} has a real description`);
    assert.equal(skill.uri, `skill://figma-bridge/${skill.name}`);
  }
  const text = textOf(await server.call("get_skill", { name: "design-direction" }));
  assert.match(text, /^# Designing a screen/);
  assert.doesNotMatch(text, /^---/, "frontmatter is stripped");

  const unknown = await server.call("get_skill", { name: "nope" });
  assert.equal(unknown.isError, true);
});

test("the tool description tells agents what each skill is for", async () => {
  const { tools } = await server.client.listTools();
  const tool = tools.find((t) => t.name === "get_skill");
  for (const name of SKILLS) assert.match(tool.description, new RegExp(`- ${name}: `));
  assert.deepEqual(tool.inputSchema.properties.name.enum, SKILLS);
});

test("skills are also MCP resources", async () => {
  const { resources } = await server.client.listResources();
  const skills = resources.filter((r) => r.uri.startsWith("skill://"));
  assert.deepEqual(skills.map((r) => r.uri).sort(), SKILLS.map((n) => `skill://figma-bridge/${n}`));
  assert.ok(skills.every((r) => r.mimeType === "text/markdown"));
  const read = await server.client.readResource({ uri: "skill://figma-bridge/accessibility" });
  assert.match(read.contents[0].text, /^# Accessibility in designs/);
});

test("prompts bring the brief and the matching skill", async () => {
  const { prompts } = await server.client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ["audit_design", "design_screen", "review_copy", "setup_design_system"]);

  const design = await server.client.getPrompt({ name: "design_screen", arguments: { brief: "Pricing page for teams", platform: "desktop 1440" } });
  const text = design.messages[0].content.text;
  assert.match(text, /Pricing page for teams/);
  assert.match(text, /Platform: desktop 1440/);
  assert.match(text, /# Designing a screen/);

  const audit = await server.client.getPrompt({ name: "audit_design", arguments: { nodeId: "12:34" } });
  assert.match(audit.messages[0].content.text, /Review the node 12:34 .* read-only: do not change anything/);
  assert.match(audit.messages[0].content.text, /# Accessibility in designs/);

  const copy = await server.client.getPrompt({ name: "review_copy", arguments: {} });
  assert.match(copy.messages[0].content.text, /the frame selected in Figma/);
  assert.match(copy.messages[0].content.text, /# Writing interface text/);

  const system = await server.client.getPrompt({ name: "setup_design_system", arguments: { brief: "Brand blue #0969DA" } });
  assert.match(system.messages[0].content.text, /Brief: Brand blue #0969DA/);
  assert.match(system.messages[0].content.text, /# Design systems in Figma/);
});

test("the design-system recipes run as written", async () => {
  // Runs the code blocks from skills/design-system/SKILL.md through execute_code
  // (against the mock), so the recipes cannot drift into broken code.
  const figma = createMockFigma();
  const plugin = await connectPlugin({ port: PORT, figma });
  try {
    const skill = readFileSync(join(ROOT, "skills", "design-system", "SKILL.md"), "utf8");
    const blocks = [...skill.matchAll(/^[ \t]*```js\n([\s\S]*?)^[ \t]*```/gm)].map((m) => m[1]);
    assert.equal(blocks.length, 5, "primitives/theme, dimensions, styles, components, property bindings");

    for (const code of blocks.slice(0, 3)) {
      const result = await server.call("execute_code", { code });
      assert.equal(result.isError, undefined, textOf(result));
    }
    const styles = jsonOf(await server.call("get_styles"));
    const theme = styles.variableCollections.find((c) => c.name === "Theme");
    assert.deepEqual(theme.modes.map((m) => m.name), ["Light", "Dark"]);
    const surface = theme.variables.find((v) => v.name === "bg/surface");
    assert.ok(Object.values(surface.valuesByMode).every((value) => value.alias), "semantic tokens alias primitives");
    assert.ok(styles.variableCollections.find((c) => c.name === "Dimension").variables.some((v) => v.name === "space/16"));
    assert.deepEqual(styles.textStyles.map((s) => s.name), ["Heading/H1", "Body/Base", "Label/Small"]);
    assert.equal(styles.effectStyles[0].name, "Elevation/1");

    // The component recipe needs two variants; build them the way the skill says.
    const built = jsonOf(
      await server.call("build_design", {
        spec: {
          type: "frame",
          name: "Components",
          layout: "horizontal",
          gap: 24,
          children: ["Primary", "Secondary"].map((kind) => ({
            type: "component",
            name: `Kind=${kind}`,
            padding: [10, 16],
            children: [{ type: "text", name: "Label", text: "Button" }],
          })),
        },
      }),
    );
    const [primary, secondary] = built.nodes.filter((n) => n.type === "COMPONENT").map((n) => n.id);
    const components = blocks[3].replace('"10:24"', `"${primary}"`).replace('"10:26"', `"${secondary}"`);
    const combined = await server.call("execute_code", { code: components });
    assert.equal(combined.isError, undefined, textOf(combined));
    const set = jsonOf(await server.call("get_components", { query: "Button" })).local[0];
    assert.equal(set.type, "COMPONENT_SET");
    assert.ok(Object.keys(set.properties).some((k) => k.startsWith("Label#")));
    assert.deepEqual(set.properties.Kind.variantOptions, ["Primary", "Secondary"]);

    const placed = await server.call("build_design", {
      spec: { type: "instance", component: "Button", variant: { Kind: "Secondary" }, props: { Label: "Save" } },
    });
    assert.equal(placed.isError, undefined, textOf(placed));

    // Found in Figma: assigning componentPropertyReferences replaces the object,
    // so the skill's binding line must keep the existing references.
    const bindings = await server.call("execute_code", {
      code: [
        `const set = await figma.getNodeByIdAsync("${set.id}");`,
        'const show = set.addComponentProperty("Show icon", "BOOLEAN", false);',
        `const icon = set.addComponentProperty("Icon", "INSTANCE_SWAP", "${primary}");`,
        'const layer = set.children[0].findOne((n) => n.name === "Label");',
        blocks[4],
        "return layer.componentPropertyReferences;",
      ].join("\n"),
    });
    assert.equal(bindings.isError, undefined, textOf(bindings));
    assert.deepEqual(Object.keys(jsonOf(bindings).result).sort(), ["characters", "mainComponent", "visible"]);
  } finally {
    await plugin.close();
  }
});

test("the theme recipe still works on plans that allow one mode", async () => {
  // Found in Figma: addMode throws "Limited to 1 modes only" on some plans.
  const figma = createMockFigma({ maxModes: 1 });
  const plugin = await connectPlugin({ port: PORT, figma });
  try {
    const skill = readFileSync(join(ROOT, "skills", "design-system", "SKILL.md"), "utf8");
    const theme = [...skill.matchAll(/^[ \t]*```js\n([\s\S]*?)^[ \t]*```/gm)][0][1];
    const result = await server.call("execute_code", { code: theme });
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(jsonOf(result).result.darkMode, false);
    const styles = jsonOf(await server.call("get_styles"));
    assert.deepEqual(styles.variableCollections.find((c) => c.name === "Theme").modes.map((m) => m.name), ["Light"]);
  } finally {
    await plugin.close();
  }
});

test("skills only mention tools that exist, and follow the SKILL.md format", async () => {
  const { tools } = await server.client.listTools();
  const toolNames = new Set(tools.map((t) => t.name));
  const dir = join(ROOT, "skills");
  for (const name of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
    const text = readFileSync(join(dir, name, "SKILL.md"), "utf8");
    const meta = /^---\n([\s\S]*?)\n---/.exec(text)[1];
    assert.match(meta, new RegExp(`^name: ${name}$`, "m"), `${name}: frontmatter name matches the folder`);
    const description = /^description: (.*)$/m.exec(meta)[1];
    assert.ok(description.length <= 1024, `${name}: description fits the 1024-character limit`);
    // Inline code that looks like a tool name must be one.
    for (const [, word] of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
      assert.ok(toolNames.has(word), `${name} mentions \`${word}\`, which is not a tool`);
    }
  }
});

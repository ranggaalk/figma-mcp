// Undo steps, automatic rollback, checkpoints and one-at-a-time mutations.
// The mock's undo follows what was observed in real Figma: triggerUndo()
// reverts the uncommitted changes AND the last committed step.

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { connectPlugin, jsonOf, ROOT, startServer, textOf } from "./helpers.mjs";
import { createMockFigma } from "./mock-figma.mjs";

const PORT = 3903;
let server;
let plugin;
let figma;

const names = () => figma.currentPage.children.map((n) => n.name);

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
  for (const node of figma.currentPage.children) figma._test.setup(() => node.remove());
  figma._test.resetUndo();
});

test("a failing call removes the nodes it created and keeps the previous step", async () => {
  await server.call("execute_code", { code: 'figma.createRectangle().name = "keep";' });
  const failed = await server.call("execute_code", {
    code: 'const r = figma.createRectangle(); r.name = "temp"; throw new Error("boom");',
  });
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /boom/);
  assert.match(textOf(failed), /All changes made by this call were undone/);
  assert.deepEqual(names(), ["keep"]);
});

test("a failing call without changes does not undo the previous step", async () => {
  // This is the case where a bare triggerUndo() would remove "keep".
  await server.call("execute_code", { code: 'figma.createRectangle().name = "keep";' });
  const failed = await server.call("execute_code", { code: 'throw new Error("nothing changed");' });
  assert.equal(failed.isError, true);
  assert.deepEqual(names(), ["keep"]);
});

test("property changes are reverted, and the user's own edits survive", async () => {
  const id = jsonOf(await server.call("execute_code", { code: 'const r = figma.createRectangle(); r.name = "box"; return r.id;' })).result;
  const box = await figma.getNodeByIdAsync(id);

  // The user edits the node by hand; Figma commits that as its own step.
  box.opacity = 0.5;
  figma.commitUndo();

  const failed = await server.call("execute_code", {
    code: `const n = await figma.getNodeByIdAsync("${id}"); n.x = 999; n.name = "renamed"; n.fills = []; throw new Error("late failure");`,
  });
  assert.equal(failed.isError, true);
  assert.equal(box.x, 0);
  assert.equal(box.name, "box");
  assert.equal(box.fills.length, 1);
  assert.equal(box.opacity, 0.5, "the user's edit is kept");
});

test("a call that changes nothing leaves no undo step", async () => {
  const before = figma._test.undoDepth();
  await server.call("execute_code", { code: "return figma.currentPage.children.length;" });
  assert.equal(figma._test.undoDepth(), before);
  await server.call("execute_code", { code: "figma.createEllipse();" });
  assert.equal(figma._test.undoDepth(), before + 1);
});

test("code that manages undo or closes the plugin is rejected before it runs", async () => {
  for (const call of ["figma.commitUndo()", "figma.triggerUndo()", "figma.closePlugin()"]) {
    const result = await server.call("execute_code", { code: `figma.createRectangle(); ${call};` });
    assert.equal(result.isError, true, call);
    assert.match(textOf(result), /was not run/);
  }
  assert.deepEqual(names(), []);
});

test("a call that never finishes is rolled back and does not block later calls", async () => {
  const hung = await server.call("execute_code", {
    code: 'figma.createRectangle().name = "half-done"; await new Promise(() => {});',
    timeoutMs: 1000,
  });
  assert.equal(hung.isError, true);
  assert.match(textOf(hung), /Did not finish within 1000 ms/);
  assert.deepEqual(names(), []);
  const next = await server.call("execute_code", { code: 'figma.createRectangle().name = "after"; return 1;' });
  assert.equal(next.isError, undefined, textOf(next));
  assert.deepEqual(names(), ["after"]);
});

test("mutations run one at a time and never interleave", async () => {
  const slow = server.call("execute_code", {
    code: 'figma.createRectangle().name = "slow-a"; await new Promise((r) => setTimeout(r, 200)); figma.createRectangle().name = "slow-b";',
  });
  const fast = server.call("execute_code", { code: 'figma.createRectangle().name = "fast";' });
  await Promise.all([slow, fast]);
  const order = names();
  assert.equal(order.length, 3);
  assert.equal(order.indexOf("slow-b"), order.indexOf("slow-a") + 1, `interleaved: ${order}`);
});

test("commands from an older server without a time limit still run", async () => {
  // Stand-in for an older server: it sends execute_code without timeoutMs.
  const { WebSocketServer } = await import("ws");
  const { compileSnippet } = await import(ROOT + "dist/compile.js");
  const wss = new WebSocketServer({ port: PORT + 50, host: "127.0.0.1" });
  const oldFigma = createMockFigma();
  const connected = new Promise((resolve) => wss.once("connection", resolve));
  const old = await connectPlugin({ port: PORT + 50, figma: oldFigma });
  const socket = await connected;
  try {
    const compiled = await compileSnippet('await new Promise((r) => setTimeout(r, 30)); figma.createRectangle().name = "late"; return "ok";');
    const reply = await new Promise((resolve) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === "old-1") resolve(msg);
      });
      socket.send(JSON.stringify({ type: "command", id: "old-1", command: "execute_code", params: { compiled } }));
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.result.result, "ok");
    assert.deepEqual(oldFigma.currentPage.children.map((n) => n.name), ["late"]);
  } finally {
    await old.close();
    wss.close();
  }
});

test("save_checkpoint saves a named version", async () => {
  const result = jsonOf(await server.call("save_checkpoint", { title: "Before restyle", description: "colors" }));
  assert.equal(result.title, "Before restyle");
  assert.ok(result.versionId);
  assert.deepEqual(figma._test.stats.versions.at(-1), { title: "Before restyle", description: "colors" });
});

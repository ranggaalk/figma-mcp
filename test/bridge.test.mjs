// Connection handling: origins, port conflicts, several plugins, disconnects,
// timeouts and plugin version mismatches.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { connectPlugin, jsonOf, sleep, startServer, textOf, tryConnect } from "./helpers.mjs";

const PORT = 3901;
let server;

before(async () => {
  server = await startServer({ port: PORT });
  await sleep(200);
});
after(() => server.close());

test("before the plugin connects, tools explain how to connect", async () => {
  const status = jsonOf(await server.call("get_status"));
  assert.equal(status.connected, false);
  assert.match(status.hint, /Figma MCP Bridge/);

  const read = await server.call("get_selection");
  assert.equal(read.isError, true);
  assert.match(textOf(read), /not connected/);

  const exec = await server.call("execute_code", { code: "return 1" });
  assert.equal(exec.isError, true);
  assert.match(textOf(exec), /not connected/);
});

test("web pages cannot connect, the plugin's null origin can", async () => {
  assert.equal(await tryConnect(PORT, "https://evil.example"), false);
  assert.equal(await tryConnect(PORT, "null"), true);
  assert.equal(await tryConnect(PORT, "https://www.figma.com"), true);
});

test("a second server on the same port explains the conflict", async () => {
  const second = await startServer({ port: PORT });
  try {
    await sleep(300);
    const text = textOf(await second.call("get_status"));
    assert.match(text, /already in use/);
  } finally {
    await second.close();
  }
});

test("commands go to the newest plugin and fall back when it leaves", async () => {
  const first = await connectPlugin({ port: PORT });
  const second = await connectPlugin({ port: PORT });
  second.figma.root.name = "Second File";
  try {
    assert.equal(jsonOf(await server.call("get_status")).fileName, "Second File");
    await second.close();
    await sleep(100);
    const status = jsonOf(await server.call("get_status"));
    assert.equal(status.fileName, "Test File");
    assert.equal(status.bridge.connections.length, 1);
  } finally {
    await first.close();
    await sleep(100);
  }
});

test("timeouts are reported and the bridge keeps working", async () => {
  const plugin = await connectPlugin({ port: PORT });
  try {
    const slow = await server.call("execute_code", { code: "await new Promise(() => {});", timeoutMs: 1000 });
    assert.equal(slow.isError, true);
    assert.match(textOf(slow), /Timed out after 1000 ms/);
    assert.equal(jsonOf(await server.call("get_status")).connected, true);
  } finally {
    await plugin.close();
    await sleep(100);
  }
});

test("a pending command fails fast when the plugin disconnects", async () => {
  const plugin = await connectPlugin({ port: PORT });
  const pending = server.call("execute_code", { code: "await new Promise(() => {});", timeoutMs: 10000 });
  await sleep(200);
  await plugin.close();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(textOf(result), /disconnected/);
  await sleep(100);
  assert.equal(jsonOf(await server.call("get_status")).connected, false);
});

test("oversized results are truncated", async () => {
  const plugin = await connectPlugin({ port: PORT });
  try {
    const text = textOf(await server.call("execute_code", { code: "return 'x'.repeat(200000);" }));
    assert.ok(text.length < 81000, `length ${text.length}`);
    assert.match(text, /truncated/);
  } finally {
    await plugin.close();
    await sleep(100);
  }
});

test("an outdated plugin is reported, and unknown commands explained", async () => {
  // Stand-in for an old plugin build: says hello with an old version and
  // knows no commands.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: "null" });
  await new Promise((resolve) => ws.on("open", resolve));
  ws.send(JSON.stringify({ type: "hello", info: { fileName: "Old", pageName: "P", editorType: "figma", pluginVersion: "0.0.1" } }));
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    ws.send(JSON.stringify({ id: msg.id, ok: false, error: `Unknown command: ${msg.command}` }));
  });
  await sleep(100);
  try {
    const result = await server.call("get_document_info");
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /outdated \(version 0\.0\.1/);
    assert.match(text, /run Plugins → Development/);
    assert.match(text, /Warning: the Figma plugin is version 0\.0\.1/);
  } finally {
    ws.close();
    await sleep(100);
  }
});

test("a matching plugin produces no version warning", async () => {
  const plugin = await connectPlugin({ port: PORT });
  try {
    const result = await server.call("get_status");
    assert.doesNotMatch(textOf(result), /Warning/);
    const mismatched = await connectPlugin({ port: PORT, helloVersion: "0.1.0" });
    try {
      assert.match(textOf(await server.call("get_status")), /Warning: the Figma plugin is version 0\.1\.0/);
    } finally {
      await mismatched.close();
    }
  } finally {
    await plugin.close();
    await sleep(100);
  }
});

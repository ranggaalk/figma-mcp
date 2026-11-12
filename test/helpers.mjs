// Test harness: a real MCP client talking to the real server (dist/server.js),
// which talks over WebSocket to the real plugin code (plugin/code.js) running
// against the mocked Figma API.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import { createMockFigma } from "./mock-figma.mjs";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function textOf(result) {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Parses the first text block of a tool result as JSON. */
export function jsonOf(result) {
  const first = result.content.find((c) => c.type === "text");
  try {
    return JSON.parse(first.text);
  } catch {
    throw new Error("Tool result is not JSON:\n" + textOf(result));
  }
}

export function imageOf(result) {
  return result.content.find((c) => c.type === "image");
}

export async function startServer({ port, env = {} }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ROOT + "dist/server.js"],
    env: { ...process.env, FIGMA_BRIDGE_PORT: String(port), ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return {
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    close: () => client.close(),
  };
}

/** Opens one WebSocket connection; resolves true when accepted, false when refused. */
export function tryConnect(port, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    ws.on("open", () => {
      ws.close();
      resolve(true);
    });
    ws.on("error", () => resolve(false));
    ws.on("unexpected-response", () => resolve(false));
  });
}

/**
 * Runs plugin/code.js against a mocked `figma` and connects it the way
 * ui.html does. Retries until the server is listening.
 */
export async function connectPlugin({ port, figma = createMockFigma(), origin = "null", helloVersion } = {}) {
  const code = readFileSync(ROOT + "plugin/code.js", "utf8");
  new Function("figma", "__html__", code)(figma, "");

  for (let attempt = 0; attempt < 50; attempt++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    const opened = await new Promise((resolve) => {
      ws.on("open", () => resolve(true));
      ws.on("error", () => resolve(false));
    });
    if (!opened) {
      await sleep(100);
      continue;
    }
    figma.ui.postMessage = (msg) => {
      if (msg.type !== "to-server" || ws.readyState !== WebSocket.OPEN) return;
      let payload = msg.payload;
      if (helloVersion && payload.type === "hello") payload = { ...payload, info: { ...payload.info, pluginVersion: helloVersion } };
      ws.send(JSON.stringify(payload));
    };
    ws.on("message", (data) => figma.ui.onmessage(JSON.parse(data.toString())));
    figma.ui.onmessage({ type: "ws-open" });
    figma.ui.onmessage({ type: "visibility", hidden: false });
    await sleep(50);
    return {
      ws,
      figma,
      setHidden: (hidden) => figma.ui.onmessage({ type: "visibility", hidden }),
      close: () =>
        new Promise((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) return resolve();
          ws.once("close", resolve);
          ws.close();
        }),
    };
  }
  throw new Error(`Could not connect to the bridge on port ${port}`);
}

/** A valid, all-black RGB PNG of the given size. */
export function makePng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Loads the fonts most fixtures use, so setup code may write text. */
export async function loadFonts(figma, styles = ["Regular", "Bold"]) {
  for (const style of styles) await figma.loadFontAsync({ family: "Inter", style });
}

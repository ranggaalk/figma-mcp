import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { PLUGIN_VERSION, type CommandName, type CommandParams, type PluginHello } from "./protocol.js";

interface PluginConnection {
  socket: WebSocket;
  hello: PluginHello | undefined;
  alive: boolean;
}

interface PendingRequest {
  socket: WebSocket;
  command: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const LISTEN_RETRY_MS = 3000;
const HEARTBEAT_MS = 30000;

const RERUN_PLUGIN =
  'Ask the user to close the plugin window in Figma and run Plugins → Development → "Figma MCP Bridge" again ' +
  "(and to copy the rebuilt plugin files again if they import the plugin from a Windows folder).";

// stdout carries the MCP stdio protocol, so all logging goes to stderr.
const log = (...args: unknown[]) => console.error("[figma-bridge]", ...args);

/**
 * Figma plugin iframes run with an opaque origin, which browsers send as the
 * literal string "null". Ordinary web pages send their real origin and are
 * refused, so a site open in the user's browser cannot pose as the plugin.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin || origin === "null") return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "figma.com" || hostname.endsWith(".figma.com");
  } catch {
    return false;
  }
}

/**
 * WebSocket server the Figma plugin connects to. Commands go out as
 * `{type: "command", id, command, params}` and come back as
 * `{id, ok: true, result}` or `{id, ok: false, error}`.
 */
export class FigmaBridge {
  private wss: WebSocketServer | undefined;
  private listenError: string | undefined;
  /** Ordered oldest → newest; commands go to the newest connection. */
  private readonly connections: PluginConnection[] = [];
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    readonly port: number,
    readonly host: string,
  ) {}

  start(): void {
    this.listen();
    setInterval(() => this.heartbeat(), HEARTBEAT_MS).unref();
  }

  private listen(): void {
    const wss = new WebSocketServer({
      port: this.port,
      host: this.host,
      maxPayload: 256 * 1024 * 1024,
      verifyClient: ({ origin }: { origin: string }) => {
        const allowed = isAllowedOrigin(origin);
        if (!allowed) log(`rejected connection from origin ${origin}`);
        return allowed;
      },
    });

    wss.on("listening", () => {
      this.wss = wss;
      this.listenError = undefined;
      log(`waiting for the Figma plugin on ws://${this.host}:${this.port}`);
    });

    wss.on("error", (err: NodeJS.ErrnoException) => {
      this.listenError =
        err.code === "EADDRINUSE"
          ? `Port ${this.port} is already in use, most likely by another running copy of this MCP server (another agent session). Close the other session, or set FIGMA_BRIDGE_PORT.`
          : `WebSocket server error: ${err.message}`;
      log(this.listenError);
      if (this.wss === wss) this.wss = undefined;
      wss.close();
      // Keep retrying so this instance takes over once the port frees up.
      setTimeout(() => this.listen(), LISTEN_RETRY_MS).unref();
    });

    wss.on("connection", (socket) => this.onConnection(socket));
  }

  private onConnection(socket: WebSocket): void {
    const connection: PluginConnection = { socket, hello: undefined, alive: true };
    this.connections.push(connection);
    log("plugin connected");

    socket.on("pong", () => {
      connection.alive = true;
    });

    socket.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.type === "hello") {
        connection.hello = msg.info;
        if (msg.info?.pluginVersion !== PLUGIN_VERSION) {
          log(`plugin version ${msg.info?.pluginVersion} does not match server version ${PLUGIN_VERSION}`);
        }
        return;
      }
      const request = typeof msg?.id === "string" ? this.pending.get(msg.id) : undefined;
      if (!request) return;
      this.pending.delete(msg.id);
      clearTimeout(request.timer);
      if (msg.ok) request.resolve(msg.result);
      else request.reject(new Error(this.explainError(String(msg.error ?? "Unknown error in the Figma plugin"), request)));
    });

    socket.on("error", (err) => log("socket error:", err.message));

    socket.on("close", () => {
      const index = this.connections.indexOf(connection);
      if (index !== -1) this.connections.splice(index, 1);
      log("plugin disconnected");
      for (const [id, request] of this.pending) {
        if (request.socket !== socket) continue;
        this.pending.delete(id);
        clearTimeout(request.timer);
        request.reject(
          new Error(
            "The Figma plugin disconnected before the command finished. The command may or may not have been applied.",
          ),
        );
      }
    });
  }

  /** An old plugin does not know newer commands; say so instead of "Unknown command". */
  private explainError(error: string, request: PendingRequest): string {
    if (error.startsWith("Unknown command")) {
      const version = this.connections.find((c) => c.socket === request.socket)?.hello?.pluginVersion ?? "unknown";
      return `The Figma plugin is outdated (version ${version}, this server needs ${PLUGIN_VERSION}) and does not support "${request.command}". ${RERUN_PLUGIN}`;
    }
    return error;
  }

  private heartbeat(): void {
    for (const connection of this.connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }

  get connected(): boolean {
    return this.connections.length > 0;
  }

  /** Warning text when the active plugin was built from a different version than this server. */
  versionWarning(): string | undefined {
    const hello = this.connections.at(-1)?.hello;
    if (!hello || hello.pluginVersion === PLUGIN_VERSION) return undefined;
    return (
      `Warning: the Figma plugin is version ${hello.pluginVersion} but this MCP server is ${PLUGIN_VERSION}. ` +
      `Newer tools and helpers may fail until the plugin is reloaded. ${RERUN_PLUGIN}`
    );
  }

  status() {
    return {
      listening: this.wss !== undefined,
      url: `ws://${this.host}:${this.port}`,
      serverVersion: PLUGIN_VERSION,
      listenError: this.listenError,
      connections: this.connections.map((connection, index) => ({
        ...connection.hello,
        active: index === this.connections.length - 1,
      })),
    };
  }

  notConnectedMessage(): string {
    if (this.listenError) return this.listenError;
    return (
      "The Figma plugin is not connected. Ask the user to open the design file in the Figma desktop app " +
      'and run Plugins → Development → "Figma MCP Bridge". The plugin window must stay open while you work.'
    );
  }

  /** Send a command to the active plugin and wait for its reply. */
  request<K extends CommandName>(command: K, params: CommandParams[K], timeoutMs: number): Promise<unknown> {
    const connection = this.connections.at(-1);
    if (!connection) return Promise.reject(new Error(this.notConnectedMessage()));

    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out after ${timeoutMs} ms waiting for Figma to finish "${command}". ` +
              "It may still complete inside Figma, so check the document before retrying.",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { socket: connection.socket, command, resolve, reject, timer });
      connection.socket.send(JSON.stringify({ type: "command", id, command, params }), (err) => {
        if (!err) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`Could not send the command to the Figma plugin: ${err.message}`));
      });
    });
  }
}

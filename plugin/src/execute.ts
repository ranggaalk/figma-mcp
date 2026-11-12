// Running agent-written code (execute_code).

import { MAX_TEXT_CHARS, toPlain } from "./serialize";
import { errorMessage, safe, type Json } from "./util";

const MAX_LOG_LINES = 200;

/** `console` replacement handed to agent code so its output travels back with the result. */
function captureConsole(logs: string[]): Json {
  const method =
    (level: string) =>
    (...args: unknown[]) => {
      if (logs.length >= MAX_LOG_LINES) return;
      const text = args
        .map((arg) => (typeof arg === "string" ? arg : safe(() => JSON.stringify(toPlain(arg))) || String(arg)))
        .join(" ");
      const line = (level === "log" ? "" : `[${level}] `) + text;
      logs.push(line.length > MAX_TEXT_CHARS ? line.slice(0, MAX_TEXT_CHARS) + "…" : line);
    };
  return { log: method("log"), info: method("info"), warn: method("warn"), error: method("error"), debug: method("debug") };
}

type SnippetMain = (api: PluginAPI, console: Json) => Promise<unknown>;

/**
 * `compiled` is produced by the MCP server and defines `__figmaBridgeMain`,
 * an async function taking `(figma, console)`.
 */
function loadSnippet(compiled: string): SnippetMain {
  const source = compiled + "\nreturn __figmaBridgeMain;";
  try {
    return new Function(source)();
  } catch (err) {
    if (err instanceof SyntaxError) throw err;
    // Fall back to indirect eval in case the sandbox does not expose the Function constructor.
    return (0, eval)("(function () {" + source + "\n})()");
  }
}

/** Runs inside runMutation, which makes the call one undo step and rolls it back on failure. */
export async function executeCode(params: { compiled: string }): Promise<Json> {
  if (typeof params.compiled !== "string") throw new Error("No code was provided");
  const logs: string[] = [];
  try {
    const main = loadSnippet(params.compiled);
    const result = await main(figma, captureConsole(logs));
    const out: Json = { result: toPlain(result) };
    if (logs.length > 0) out.logs = logs;
    return out;
  } catch (err) {
    let message = errorMessage(err);
    if (logs.length > 0) message += "\nconsole output before the error:\n" + logs.join("\n");
    throw new Error(message);
  }
}

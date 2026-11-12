import { transform } from "esbuild";

/**
 * Figma's plugin sandbox rejects some newer syntax (optional chaining, object
 * spread, …), so agent-written code is lowered to ES2017 before it is sent.
 * The TypeScript loader also strips any type annotations the agent adds.
 */
export async function compileSnippet(code: string): Promise<string> {
  const forbidden = /\b(commitUndo|triggerUndo|closePlugin)\s*\(/.exec(code);
  if (forbidden) {
    throw new Error(
      `The code calls figma.${forbidden[1]}(), which was not run. ` +
        (forbidden[1] === "closePlugin"
          ? "Closing the plugin disconnects this bridge."
          : "The bridge manages undo itself: each call is one undo step and is rolled back automatically if it fails.") +
        " Remove the call and try again.",
    );
  }
  const wrapped = `var __figmaBridgeMain = async function (figma, console) {\n${code}\n};`;
  try {
    const { code: compiled } = await transform(wrapped, { loader: "ts", target: "es2017" });
    return compiled;
  } catch (err) {
    const errors = (err as { errors?: Array<{ text: string; location?: { line: number; column: number } | null }> })
      .errors;
    if (!errors?.length) throw err;
    const details = errors
      // Line numbers are shifted by one because of the wrapper's first line.
      .map((e) => (e.location ? `line ${e.location.line - 1}, column ${e.location.column}: ${e.text}` : e.text))
      .join("\n");
    throw new Error(`The code has a syntax error and was not run.\n${details}`);
  }
}

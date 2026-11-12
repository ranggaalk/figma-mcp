// Running commands that change the document: one undo step per command,
// automatic rollback on failure, and one command at a time.

import { errorMessage, withTimeout } from "./util";

const ROLLBACK_MARKER_KEY = "mcpBridgeRollback";
const DEFAULT_TIMEOUT_MS = 30000;

/** Thrown when work failed and its changes were rolled back. */
export class RolledBackError extends Error {}

/**
 * Undo, as observed in Figma: `triggerUndo()` reverts the uncommitted changes
 * AND the last committed step, even when there are no uncommitted changes.
 * Calling it directly after a failed command would therefore also undo the
 * step before it (possibly the user's own edit).
 *
 * So on failure we add one change of our own, commit, and only then undo:
 * the committed step is exactly this command's changes plus the marker, and
 * nothing else is touched. On success we only commit, so commands that change
 * nothing leave no empty step in the user's undo history.
 */
function rollback(): boolean {
  try {
    figma.root.setPluginData(ROLLBACK_MARKER_KEY, String(Date.now()));
  } catch (_) {
    // Without our own change the undo could reach an earlier step; better to
    // leave the partial changes in place and say so.
    figma.commitUndo();
    return false;
  }
  figma.commitUndo();
  figma.triggerUndo();
  return true;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` after any mutation already in progress. Read-only commands do
 * not go through here, so they stay responsive while a mutation runs.
 */
export function runMutation<T>(work: () => Promise<T>, timeoutMs: number | undefined): Promise<T> {
  // Older servers do not send a time limit; without this default every
  // mutation would time out at once.
  const limit = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const run = queue.then(() => mutate(work, limit));
  // A failed or timed-out mutation must not block the ones behind it.
  queue = run.catch(() => undefined);
  return run;
}

async function mutate<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  // Close whatever came before, so it is never part of this command's step.
  figma.commitUndo();
  try {
    const result = await withTimeout(
      work(),
      timeoutMs,
      () => new Error(`Did not finish within ${timeoutMs} ms (for example an await that never resolves).`),
    );
    figma.commitUndo();
    return result;
  } catch (err) {
    const message = errorMessage(err);
    if (rollback()) {
      throw new RolledBackError(`${message}\n\nAll changes made by this call were undone; the file is as it was before the call.`);
    }
    throw new Error(
      `${message}\n\nThe changes made before the error could not be undone automatically and are still in the file. Inspect the document before retrying.`,
    );
  }
}

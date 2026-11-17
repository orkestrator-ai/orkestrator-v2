import { spawnSync } from "node:child_process";
import type { ElectronApplication } from "playwright";

/**
 * Names a lost window focus in a failed focus expectation.
 *
 * On a shared desktop another application can take the key window part-way
 * through a case: the user's own app, or another worktree's Electron run
 * calling `app.focus({ steal: true })`. Playwright then reports a focused
 * element as `inactive` and a webContents' `isFocused()` stays false, which
 * reads like a focus-handoff regression. These helpers read what the window
 * and, on macOS, the window server say at the moment of failure, and put it
 * in the failure message. They never turn a failure into a pass: a handoff
 * that really drops focus must still fail.
 */

/** The application macOS reports in front (`lsappinfo front`). */
export interface FrontApplication {
  name: string;
  pid: number;
}

export type FrontApplicationReading =
  | { kind: "front"; application: FrontApplication }
  | { kind: "unavailable"; reason: string }
  | { kind: "not-macos" };

export interface WindowFocusFacts {
  /** `BrowserWindow.isFocused()` of the case's host window. */
  windowFocused: boolean;
  /** Whether any of the app's windows is focused (`getFocusedWindow()`). */
  appHasFocusedWindow: boolean;
  /** The Electron main process, to compare with the front application. */
  electronPid: number | undefined;
  front: FrontApplicationReading;
}

type Run = (
  command: string,
  args: string[],
) => { status: number | null; stdout: string; error?: Error };

const runCommand: Run = (command, args) => {
  const run = spawnSync(command, args, { encoding: "utf8", timeout: 5_000 });
  return { status: run.status, stdout: run.stdout ?? "", error: run.error };
};

/** Reads the name and pid from `lsappinfo info <ASN>` output. */
export function parseLsappinfoInfo(output: string): FrontApplication | undefined {
  const name = /^\s*"([^"]*)"\s+ASN:/m.exec(output)?.[1];
  const pid = /\bpid = (\d+)\b/.exec(output)?.[1];
  if (name === undefined || pid === undefined) return undefined;
  return { name, pid: Number(pid) };
}

/** Which application macOS has in front, read the way `hidden-dialogs-electron.spec.ts` does. */
export function readFrontApplication(
  platform: NodeJS.Platform = process.platform,
  run: Run = runCommand,
): FrontApplicationReading {
  if (platform !== "darwin") return { kind: "not-macos" };
  const front = run("lsappinfo", ["front"]);
  const asn = front.stdout.trim();
  if (front.error || front.status !== 0 || !/^ASN:\S+$/.test(asn))
    return { kind: "unavailable", reason: "lsappinfo front named no application" };
  const info = run("lsappinfo", ["info", asn]);
  const application = info.status === 0 ? parseLsappinfoInfo(info.stdout) : undefined;
  if (!application)
    return {
      kind: "unavailable",
      reason: "lsappinfo info gave no name and pid for the front application",
    };
  return { kind: "front", application };
}

/** What the window and the desktop say about focus right now. */
export async function readWindowFocus(
  app: ElectronApplication,
  readFront: () => FrontApplicationReading = () => readFrontApplication(),
): Promise<WindowFocusFacts> {
  const windows = await app.evaluate(({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows()[0];
    return {
      windowFocused: host !== undefined && !host.isDestroyed() && host.isFocused(),
      appHasFocusedWindow: BrowserWindow.getFocusedWindow() !== null,
    };
  });
  return { ...windows, electronPid: app.process().pid, front: readFront() };
}

function describeFront(facts: WindowFocusFacts): string {
  const front = facts.front;
  if (front.kind === "not-macos") return "";
  if (front.kind === "unavailable")
    return ` The front application could not be read (${front.reason}).`;
  const { name, pid } = front.application;
  if (pid === facts.electronPid)
    return ` macOS still has this Electron app (pid ${pid}) in front, so the key window went to none of its windows or another of them.`;
  return ` macOS has "${name}" (pid ${pid}) in front, not this Electron app${
    facts.electronPid === undefined ? "" : ` (pid ${facts.electronPid})`
  }: another application took the key window.`;
}

/**
 * A sentence naming the lost focus, or `undefined` while the window still has
 * the key focus (then the failure is not explained by the desktop).
 *
 * `focusedAtStart` is what the case read after bringing its window forward.
 */
export function describeLostFocus(
  facts: WindowFocusFacts,
  focusedAtStart: boolean,
): string | undefined {
  if (facts.windowFocused) return undefined;
  const state = `BrowserWindow.isFocused() is false${
    facts.appHasFocusedWindow ? " (another of the app's windows is focused)" : ""
  }.`;
  const lead = focusedAtStart
    ? `Lost window focus: the window had the key focus at the start of the case and lost it before this failure; ${state}`
    : `No window focus: the window did not get the key focus at the start of the case and does not have it now; ${state}`;
  return `${lead}${describeFront(facts)} A focus expectation fails on a desktop shared with another application, so this failure is not by itself evidence of a focus-handoff regression.`;
}

/** The stack frames of an error, without its (possibly multi-line) message. */
function stackFrames(stack: string | undefined): string {
  if (!stack) return "";
  const at = stack.indexOf("\n    at ");
  return at === -1 ? "" : stack.slice(at);
}

/**
 * Returns the error to throw for a failure in a focus-dependent case: the same
 * error when the window still has the key focus (or focus could not be read),
 * else a new error whose message starts with the lost focus and keeps the
 * original message, stack frames and `cause`.
 */
export async function explainLostFocus(
  error: unknown,
  app: ElectronApplication,
  focusedAtStart: boolean | undefined,
  readFront?: () => FrontApplicationReading,
): Promise<unknown> {
  if (focusedAtStart === undefined || !(error instanceof Error)) return error;
  let facts: WindowFocusFacts;
  try {
    facts = await readWindowFocus(app, readFront);
  } catch {
    return error;
  }
  const note = describeLostFocus(facts, focusedAtStart);
  if (!note) return error;
  const explained = new Error(`${note}\n\n${error.message}`, { cause: error });
  explained.stack = `Error: ${explained.message}${stackFrames(error.stack)}`;
  return explained;
}

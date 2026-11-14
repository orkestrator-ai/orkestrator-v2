/**
 * Spot the browser approvals a release waits on and tell the person at once.
 *
 * A release can stop on links someone has to open in a browser: npm's web
 * sign-in for a local `bun publish` (it expires after about five minutes),
 * Tailscale SSH's check when reaching the Linux builder, and GitHub's review
 * of the `npm-publish` deployment (printed by `release-desktop.ts`, which
 * knows the run's address; it is not scanned for in output). Printed only into a
 * terminal or an agent's transcript, they were missed until they expired.
 * The release scripts pass their child's output through `ApprovalWatcher`,
 * which raises a desktop notification, rings the terminal bell, prints a
 * banner and, on macOS, opens the link in the default browser.
 *
 * Set `ORKESTRATOR_RELEASE_OPEN_APPROVAL=0` to keep the browser closed, or
 * `=1` to open it on Linux too. Notification failures never fail a release.
 */

export type ApprovalKind = "npm" | "tailscale" | "github";

export type ApprovalLink = { kind: ApprovalKind; url: string };

/**
 * Links are matched only when whitespace follows them, so a link split across
 * two output chunks is never reported half-read. The character classes keep
 * anything that is not part of a URL out of the notification text.
 */
const APPROVAL_PATTERNS: ReadonlyArray<{ kind: ApprovalKind; pattern: RegExp }> = [
  { kind: "npm", pattern: /https:\/\/www\.npmjs\.com\/auth\/cli\/[A-Za-z0-9._~-]+(?=\s)/g },
  { kind: "tailscale", pattern: /https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9._~-]+(?=\s)/g },
];

/** The most output kept between chunks; a link is far shorter. */
const CARRY_BYTES = 4096;

export function findApprovalLinks(text: string): ApprovalLink[] {
  const links: { index: number; link: ApprovalLink }[] = [];
  for (const { kind, pattern } of APPROVAL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      links.push({ index: match.index ?? 0, link: { kind, url: match[0] } });
    }
  }
  return links.sort((a, b) => a.index - b.index).map(({ link }) => link);
}

const DESCRIPTIONS: Record<ApprovalKind, { title: string; message: string }> = {
  npm: {
    title: "npm publish is waiting for you",
    message: "Approve the npm sign-in in your browser within about five minutes.",
  },
  tailscale: {
    title: "Tailscale is waiting for you",
    message: "Approve the SSH check to the Linux release builder in your browser.",
  },
  github: {
    title: "npm publish is waiting for your approval",
    message: "Approve the npm-publish deployment on GitHub so the package can be published.",
  },
};

export function approvalDescription(kind: ApprovalKind): { title: string; message: string } {
  return DESCRIPTIONS[kind];
}

/**
 * The command that shows a desktop notification on `platform`, or null where
 * there is none. Text goes in as arguments, never into a script, so nothing
 * in it is interpreted.
 */
export function notificationCommand(
  platform: NodeJS.Platform,
  title: string,
  message: string,
): string[] | null {
  if (platform === "darwin") {
    return [
      "osascript",
      "-e",
      "on run argv",
      "-e",
      'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
      "-e",
      "end run",
      title,
      message,
    ];
  }
  if (platform === "linux") {
    return ["notify-send", "--urgency=critical", "--app-name=Orkestrator release", title, message];
  }
  return null;
}

/** The command that opens `url` in the browser, or null when it should stay closed. */
export function openBrowserCommand(
  platform: NodeJS.Platform,
  url: string,
  env: NodeJS.ProcessEnv,
): string[] | null {
  const setting = env.ORKESTRATOR_RELEASE_OPEN_APPROVAL;
  if (setting === "0") return null;
  if (platform === "darwin") return ["open", url];
  if (platform === "linux" && setting === "1") return ["xdg-open", url];
  return null;
}

export type ApprovalAlertRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Starts a command and does not wait for it; must never throw. */
  launch: (command: string[]) => void;
  write: (text: string) => void;
};

function launchDetached(command: string[]): void {
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
    // A missing notifier exits non-zero; that is not the release's failure.
    child.exited.catch(() => undefined);
  } catch {
    // The notifier is not installed (no notify-send on a server). The banner
    // and bell below still reach the terminal.
  }
}

export const defaultApprovalAlertRuntime: ApprovalAlertRuntime = {
  platform: process.platform,
  env: process.env,
  launch: launchDetached,
  write: (text) => process.stderr.write(text),
};

/** Tell the person a link is waiting, by every means this machine has. */
export function alertApproval(
  link: ApprovalLink,
  runtime: ApprovalAlertRuntime = defaultApprovalAlertRuntime,
): void {
  const { title, message } = approvalDescription(link.kind);
  runtime.write(`\u0007\n>>> ${title}\n>>> ${message}\n>>> ${link.url}\n\n`);
  const notify = notificationCommand(runtime.platform, title, message);
  if (notify) runtime.launch(notify);
  const open = openBrowserCommand(runtime.platform, link.url, runtime.env);
  if (open) runtime.launch(open);
}

/**
 * Scans streamed output for approval links and reports each new one once.
 * It keeps only a bounded tail between chunks.
 */
export class ApprovalWatcher {
  private carry = "";
  private readonly seen = new Set<string>();
  private readonly found: ApprovalLink[] = [];

  constructor(private readonly onApproval: (link: ApprovalLink) => void) {}

  push(chunk: string): void {
    const text = this.carry + chunk;
    for (const link of findApprovalLinks(text)) {
      if (this.seen.has(link.url)) continue;
      this.seen.add(link.url);
      this.found.push(link);
      this.onApproval(link);
    }
    this.carry = text.slice(-CARRY_BYTES);
  }

  /** Every link reported so far, oldest first. */
  links(): readonly ApprovalLink[] {
    return this.found;
  }
}

/** Copies a child's stream to `sink` as it arrives, passing the decoded text to `onText`. */
export async function teeStream(
  stream: ReadableStream<Uint8Array>,
  sink: { write: (chunk: Uint8Array) => unknown },
  onText: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    sink.write(chunk);
    onText(decoder.decode(chunk, { stream: true }));
  }
  const rest = decoder.decode();
  if (rest) onText(rest);
}

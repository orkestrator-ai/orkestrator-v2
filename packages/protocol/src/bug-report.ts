import type { AgentPlatform } from "./agent-platforms.js";
import { COORDINATOR_CONTEXT_CLOSE_TAG, COORDINATOR_CONTEXT_OPEN_TAG } from "./coordinator.js";

/**
 * Reporting an Orkestrator bug with a coding agent's help.
 *
 * Two entry points share this module: `orkestrator --fix AGENT`, which opens an
 * agent's own terminal UI, and the desktop's Report a bug sheet, which runs a
 * native agent session on a backend host. Both hand the agent the same
 * interview, diagnostics and redaction instructions; only how the issue is
 * filed differs. Nothing here reads the machine; the facts are collected by
 * `node/bug-report-facts.ts` on the host being diagnosed.
 */

export const BUG_REPORT_ISSUE_REPOSITORY = "orkestrator-ai/orkestrator-v2";
export const BUG_REPORT_NEW_ISSUE_URL = `https://github.com/${BUG_REPORT_ISSUE_REPOSITORY}/issues/new`;

/** The agents the bug-report flows offer: the ones every host installs. */
export const BUG_REPORT_AGENTS = [
  "claude",
  "codex",
  "opencode",
] as const satisfies readonly AgentPlatform[];
export type BugReportAgent = (typeof BUG_REPORT_AGENTS)[number];

export function isBugReportAgent(value: unknown): value is BugReportAgent {
  return typeof value === "string" && (BUG_REPORT_AGENTS as readonly string[]).includes(value);
}

/**
 * A bug report's native-agent runtime id.
 *
 * A report has no environment row. Like a coordinator conversation, its
 * session is addressed by a synthetic runtime id that the backend resolves to
 * a local environment whose worktree is the report's scratch directory.
 */
export const BUG_REPORT_RUNTIME_PREFIX = "bug-report:" as const;

const BUG_REPORT_ID = /^[A-Za-z0-9-]{1,64}$/;

export function isBugReportId(value: unknown): value is string {
  return typeof value === "string" && BUG_REPORT_ID.test(value);
}

export function bugReportRuntimeId(reportId: string): string {
  return `${BUG_REPORT_RUNTIME_PREFIX}${reportId}`;
}

export function bugReportIdFromRuntimeId(runtimeId: string): string | null {
  if (!runtimeId.startsWith(BUG_REPORT_RUNTIME_PREFIX)) return null;
  const id = runtimeId.slice(BUG_REPORT_RUNTIME_PREFIX.length);
  return isBugReportId(id) ? id : null;
}

/** The draft file the agent writes in its scratch directory. */
export const BUG_REPORT_DRAFT_FILE = "issue.md";
/** Where window captures are saved inside the scratch directory. */
export const BUG_REPORT_SCREENSHOT_DIRECTORY = "screenshots";

export const MAX_BUG_REPORT_RENDERER_ERRORS = 30;
export const MAX_BUG_REPORT_RENDERER_ERROR_CHARS = 600;
export const MAX_BUG_REPORT_TITLE_CHARS = 256;
/** GitHub rejects larger issue bodies. */
export const MAX_BUG_REPORT_BODY_CHARS = 65_536;

/** One error the renderer saw. The agent redacts it before it reaches an issue. */
export interface BugReportRendererError {
  at: string;
  kind: "error" | "unhandledrejection" | "console";
  message: string;
}

/**
 * What the app knew when the report was started. Identifiers and categories
 * only: never prompts, transcripts or file contents.
 */
export interface BugReportClientContext {
  surface: "desktop" | "web";
  appVersion?: string;
  electronVersion?: string;
  channel?: string;
  userAgent?: string;
  /** The machine the report runs on, as the picker named it. */
  machine?: { id: string | null; label: string };
  view?: {
    route?: string;
    projectId?: string;
    environmentId?: string;
    environmentType?: string;
    environmentStatus?: string;
    activeTabType?: string;
  };
  rendererErrors?: BugReportRendererError[];
}

export interface BugReportFiled {
  url: string;
  filedAt: string;
}

/** A report as the renderer sees it. */
export interface BugReportSummary {
  id: string;
  runtimeId: string;
  /** The native tab id; the session key is `env-<runtimeId>:<tabId>`. */
  tabId: string;
  createdAt: string;
  scratchDir: string;
  agent?: BugReportAgent;
  providerSessionId?: string;
  filed?: BugReportFiled;
  screenshots: string[];
}

export interface BugReportDraft {
  title: string;
  body: string;
  updatedAt: string;
}

export interface BugReportSnapshot {
  report: BugReportSummary | null;
  draft: BugReportDraft | null;
}

export type BugReportFileResult =
  | { kind: "filed"; url: string }
  /** `gh` is unavailable or not signed in; the renderer opens `url`. */
  | { kind: "browser"; url: string; bodyInUrl: boolean; reason: string };

/**
 * Read the agent's draft: a `# Title` line, then the body.
 *
 * Tolerates a leading blank line or a front-matter-free preamble before the
 * title, but a draft without a level-one heading has no title and is not ready.
 */
export function parseBugReportDraft(markdown: string): { title: string; body: string } | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const index = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (index < 0) return null;
  const title = lines[index]!.replace(/^#\s+/, "").trim().slice(0, MAX_BUG_REPORT_TITLE_CHARS);
  const body = lines
    .slice(index + 1)
    .join("\n")
    .trim();
  if (!title || !body) return null;
  return { title, body };
}

/**
 * A prefilled new-issue URL. A body too long for a URL is left out, and the
 * caller tells the user to paste it (the renderer copies it to the clipboard).
 */
export function bugReportNewIssueUrl(
  title: string,
  body: string,
  maxUrlLength = 7_500,
): { url: string; bodyInUrl: boolean } {
  const withBody = `${BUG_REPORT_NEW_ISSUE_URL}?${new URLSearchParams({ title, body }).toString()}`;
  if (withBody.length <= maxUrlLength) return { url: withBody, bodyInUrl: true };
  return {
    url: `${BUG_REPORT_NEW_ISSUE_URL}?${new URLSearchParams({ title }).toString()}`,
    bodyInUrl: false,
  };
}

/** The non-secret description of the host being diagnosed. */
export interface BugReportMachineFacts {
  platform: string;
  osRelease: string;
  arch: string;
  bunVersion: string;
  now: string;
  dataDir: string;
  dataDirExists: boolean;
  logsDir: string;
  debugLogging: boolean;
  recentLogs: { name: string; bytes: number; modified: string }[];
  backend: { appVersion?: string; startedAt?: string; pid?: number; running: boolean } | null;
  toolchainBinDir: string | null;
  managedGh: string | null;
  desktopApp: string | null;
}

export function describeBugReportBackend(facts: Pick<BugReportMachineFacts, "backend">): string {
  const backend = facts.backend;
  if (!backend)
    return "no `backend-instance.json` (no backend has run with this data directory, or it was removed)";
  const parts = [
    backend.appVersion ? `version ${backend.appVersion}` : "version not recorded",
    backend.startedAt ? `started ${backend.startedAt}` : null,
    backend.pid !== undefined
      ? `pid ${backend.pid} ${backend.running ? "(running)" : "(not running)"}`
      : null,
  ];
  return parts.filter(Boolean).join(", ");
}

export function describeBugReportLogs(
  facts: Pick<BugReportMachineFacts, "debugLogging" | "logsDir" | "recentLogs">,
): string[] {
  const state = facts.debugLogging
    ? "on"
    : "off (Settings → Debug → Save Logs for Debugging); new events are not being written";
  const lines = [`- Logs directory: ${facts.logsDir} — debug logging is ${state}`];
  if (facts.recentLogs.length === 0) {
    lines.push("- Log files: none");
  } else {
    lines.push("- Most recent log files:");
    for (const log of facts.recentLogs) {
      lines.push(`  - ${log.name} (${log.bytes} bytes, modified ${log.modified})`);
    }
  }
  return lines;
}

export const BUG_REPORT_ABOUT_ORKESTRATOR = [
  "## About Orkestrator",
  "Orkestrator runs coding agents (Claude Code, Codex, OpenCode, Cursor, Grok Build, Pi) in isolated environments: local git worktrees or Docker containers. It is an Electron desktop app with a Bun backend. The backend can also run on its own through the `orkestrator` CLI (`orkestrator serve`, or as a launchd/systemd service) and be used from a browser or the iOS app, including from another computer over Tailscale. In that case the logs that matter are on the backend's computer.",
] as const;

export function bugReportUnderstandSection(screenshotHint: string): string[] {
  return [
    "## 1. Understand the problem",
    "Start with a one- or two-sentence introduction, then ask me to describe the problem in my own words. Follow up a few questions at a time, not as one long questionnaire, until you know:",
    `- what I was trying to do, what I expected, and what happened instead, with the exact error text (${screenshotHint});`,
    "- the steps that reproduce it, and whether it happens every time;",
    "- when it started, and whether it began after an Orkestrator update;",
    "- where it happens: desktop app, web client, iOS app or CLI; a local-worktree, Docker or remote-host environment; and which agent and model.",
  ];
}

/** `connectionLine` is the one source that differs: how to ask the backend about itself. */
export function bugReportDiagnosticsSection(connectionLine: string): string[] {
  return [
    "## 2. Collect diagnostics",
    "Gather evidence yourself instead of asking me to copy it. Before each command, say in one sentence what it checks. Stay read-only: do not edit, delete, move, restart, reinstall or update anything, and do not change Orkestrator's data directory or settings. If something needs changing, explain it and let me do it.",
    "Useful sources:",
    "- Log files: `orkestrator-ai-YYYY-MM-DD.log` is the desktop app (it includes its backend's output), `orkestrator-backend-YYYY-MM-DD.log` a standalone backend; JSON mode uses `.jsonl` instead of `.log`. A busy day continues in `.1.log`, `.2.log` (or `.1.jsonl`, `.2.jsonl`), and so on. Search around the time of the problem (errors, warnings, stack traces, the environment or session name) rather than reading whole files.",
    "- If debug logging is off or the logs predate the problem, ask me to turn on Settings → Debug → Save Logs for Debugging, reproduce the problem, and tell you when I have.",
    connectionLine,
    "- Docker environments: `docker version`, `docker ps -a`, and `docker logs --tail 200 <container>` for the affected container.",
    "- Versions: `<agent> --version` for the agents involved, `git --version`, `gh --version`; on macOS, `defaults read /Applications/OrkestratorV2.app/Contents/Info.plist CFBundleShortVersionString` for the desktop app.",
    "- `config.json` in the data directory holds settings. Read only the keys that bear on the problem.",
    "Never open credentials: `gateway-auth.json`, anything under `agent-accounts/`, the file an `authFile` field points to, `.env` files, keychains, or any other token or auth file.",
    "",
    "Then work out what is going on: tell me what you think the cause is, how confident you are, and what you ruled out. If it is clearly a problem with my setup (for example Docker is not running or an agent is not signed in), tell me how to fix it and ask whether I still want to file an issue. Name the part of Orkestrator that seems to be at fault if the evidence shows it, but do not guess source file names you have not seen.",
  ];
}

export const BUG_REPORT_REDACTION_RULES = [
  "GitHub issues on this repository are public. In everything you put in the issue:",
  "- remove API keys, tokens, passwords, cookies, auth headers, URLs that carry credentials, and anything read from a credential file;",
  "- replace my home directory with `~`, and my username, e-mail address, hostnames, Tailscale names, IP addresses, and private repository or project names with placeholders, unless I say they can stay;",
  "- leave out my prompts, agent conversations and project source code unless I explicitly agree to include them;",
  "- keep log excerpts to the lines that matter, with their timestamps: a few dozen lines in total.",
] as const;

/** The issue body's sections, as a fenced example ending in `footer`. */
export function bugReportIssueTemplate(footer: string): string[] {
  return [
    "```markdown",
    "## Summary",
    "## Steps to reproduce",
    "## Expected behavior",
    "## Actual behavior",
    "## Environment",
    "(Orkestrator desktop, backend and CLI versions; OS and architecture; desktop, web, iOS or CLI; local, Docker or remote host; agents, models and their versions; how often it happens; first seen; whether an update caused it)",
    "## Diagnostics",
    "(log excerpts and command output in fenced code blocks, each inside <details><summary>what it is</summary> … </details>)",
    "## Analysis",
    "(likely cause, confidence, what was ruled out)",
    "## Additional context",
    "",
    footer,
    "```",
  ];
}

function describeClientContext(client: BugReportClientContext | undefined): string[] {
  if (!client) return ["- Not recorded"];
  const lines = [
    `- Surface: ${client.surface === "desktop" ? "desktop app" : "web client"}`,
    `- Orkestrator app version: ${client.appVersion ?? "unknown"}${client.channel ? ` (${client.channel} channel)` : ""}`,
  ];
  if (client.electronVersion) lines.push(`- Electron: ${client.electronVersion}`);
  if (client.userAgent) lines.push(`- User agent: ${client.userAgent}`);
  if (client.machine) lines.push(`- Report started for machine: ${client.machine.label}`);
  const view = client.view;
  if (view) {
    const parts = [
      view.route ? `route ${view.route}` : null,
      view.projectId ? `project id ${view.projectId}` : null,
      view.environmentId ? `environment id ${view.environmentId}` : null,
      view.environmentType ? `environment type ${view.environmentType}` : null,
      view.environmentStatus ? `environment status ${view.environmentStatus}` : null,
      view.activeTabType ? `active tab ${view.activeTabType}` : null,
    ].filter(Boolean);
    if (parts.length > 0) lines.push(`- What was on screen: ${parts.join(", ")}`);
  }
  const errors = client.rendererErrors ?? [];
  if (errors.length === 0) {
    lines.push("- Recent app (renderer) errors: none recorded");
  } else {
    lines.push(
      `- Recent app (renderer) errors, oldest first (${errors.length}; they may contain private paths or names, so redact before quoting):`,
    );
    for (const error of errors) {
      lines.push(`  - ${error.at} [${error.kind}] ${error.message.replace(/\s+/g, " ").trim()}`);
    }
  }
  return lines;
}

export interface BugReportBriefingInput {
  agentLabel: string;
  facts: BugReportMachineFacts;
  client?: BugReportClientContext;
  scratchDir: string;
  /** Absolute path of the draft file inside `scratchDir`. */
  draftPath: string;
  screenshotDir: string;
}

/**
 * The instructions a desktop bug-report session works from.
 *
 * Saved as the scratch directory's `AGENTS.md` and `CLAUDE.md`, which every
 * offered agent loads from its working directory, so they survive resumes and
 * context compaction. The first prompt also points at them.
 */
export function buildBugReportBriefing(input: BugReportBriefingInput): string {
  const { facts } = input;
  return [
    "# Orkestrator bug report",
    "",
    `I opened you from Orkestrator's Report a bug button because something in Orkestrator is not working for me. Help me report it to the Orkestrator maintainers. Your job is to (1) understand the problem by talking with me, (2) collect the evidence a maintainer needs from this machine, and (3) draft a GitHub issue for https://github.com/${BUG_REPORT_ISSUE_REPOSITORY} detailed enough that the maintainer can understand, reproduce and fix the problem without coming back to me with questions. Orkestrator files the issue itself once I approve your draft; you never file it.`,
    "",
    ...BUG_REPORT_ABOUT_ORKESTRATOR,
    "",
    "## This machine (the backend host you are running on)",
    `- Collected: ${facts.now}`,
    `- OS: ${facts.platform} (${facts.osRelease}), ${facts.arch}; Bun ${facts.bunVersion}`,
    `- Desktop app: ${facts.desktopApp ?? "not found in /Applications (on Linux, or not installed)"}`,
    `- Data directory: ${facts.dataDir}${facts.dataDirExists ? "" : " (does not exist)"}`,
    `- Backend: ${describeBugReportBackend(facts)}`,
    ...describeBugReportLogs(facts),
    `- Managed agent binaries: ${facts.toolchainBinDir ?? "none installed"}`,
    `- You: ${input.agentLabel}, running as an Orkestrator native agent session`,
    `- Your working directory (scratch space for notes and the draft): ${input.scratchDir}`,
    "",
    "## The app I reported from",
    ...describeClientContext(input.client),
    "",
    "## How you are running",
    "Your sandbox lets you write only inside your working directory. Commands and anything outside it need my approval, so prefer reading files and searching logs over running commands, and say why before asking. Stay in this working directory: it is deleted once the issue is filed.",
    "",
    ...bugReportUnderstandSection(
      `I can attach screenshots to my messages, or capture the Orkestrator window into ${input.screenshotDir}`,
    ),
    "",
    ...bugReportDiagnosticsSection(
      "- If the `orkestrator` CLI is on PATH, `orkestrator host status --json` describes this backend without changing anything. Do not change CLI configuration.",
    ),
    "",
    "## 3. Draft the issue",
    ...BUG_REPORT_REDACTION_RULES,
    "",
    `Write the issue to ${input.draftPath}. Its first line is \`# \` followed by a specific title under 80 characters that says what fails and where; the body follows, using this structure:`,
    "",
    ...bugReportIssueTemplate("_Reported with Orkestrator's Report a bug button._"),
    "",
    "Orkestrator shows the saved draft above our conversation with a File issue button. When the draft is ready, show me the title and a short summary, and ask me to review it there or ask for changes. Rewrite the file for every change I ask for.",
    "",
    "## 4. Filing",
    "Never file the issue yourself: do not run `gh issue create`, `gh api`, or anything else that posts to GitHub. When I press File issue, Orkestrator files it with the host's `gh` login if it has one, and otherwise opens GitHub's new-issue page with the draft filled in.",
    "Screenshots cannot be attached automatically. If I captured or attached any, remind me to drag them into the issue on GitHub once it exists; Orkestrator shows where they are saved.",
  ].join("\n");
}

/**
 * The note prepended to the first message of a desktop bug-report session.
 *
 * Wrapped in the coordinator context tags so every place that hides a
 * server-authored preamble from the user's own transcript row hides this too.
 */
export function bugReportFirstPromptNote(briefingPath: string): string {
  return `${COORDINATOR_CONTEXT_OPEN_TAG}\nYou are helping me report an Orkestrator bug. Your instructions are in ${briefingPath}; read that file first if it is not already in your context, then follow it.\n${COORDINATOR_CONTEXT_CLOSE_TAG}\n\n`;
}

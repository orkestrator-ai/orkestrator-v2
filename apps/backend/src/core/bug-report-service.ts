/**
 * The desktop's Report a bug flow on the backend host.
 *
 * A report is a scratch directory and a native agent session that runs in it
 * under the synthetic runtime id `bug-report:<id>`. The agent interviews the
 * user, reads this host's logs and writes its draft to `issue.md`; the sheet
 * reads the draft back through `get_bug_report`, and filing happens here, never
 * in the agent. One report is open at a time. It lives until it is discarded,
 * which the sheet does when the user is done with a filed report.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import {
  BUG_REPORT_DRAFT_FILE,
  BUG_REPORT_ISSUE_REPOSITORY,
  BUG_REPORT_SCREENSHOT_DIRECTORY,
  MAX_BUG_REPORT_BODY_CHARS,
  MAX_BUG_REPORT_RENDERER_ERROR_CHARS,
  MAX_BUG_REPORT_RENDERER_ERRORS,
  MAX_BUG_REPORT_TITLE_CHARS,
  buildBugReportBriefing,
  bugReportNewIssueUrl,
  bugReportRuntimeId,
  isBugReportAgent,
  parseBugReportDraft,
  type BugReportAgent,
  type BugReportClientContext,
  type BugReportDraft,
  type BugReportFileResult,
  type BugReportRendererError,
  type BugReportSnapshot,
  type BugReportSummary,
} from "@orkestrator/protocol/bug-report";
import { collectBugReportMachineFacts } from "@orkestrator/protocol/node/bug-report-facts";
import { defaultToolchainBinDir, toolchainRootDir } from "@orkestrator/toolchain/layout";

import type { CommandContext } from "./commands-context.js";
import { stopLocalServer } from "./commands-servers.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { gitHubCli } from "./github-cli-binary.js";
import { gitHubCliEnv, resolveGitHubToken } from "./github-credentials.js";
import { runCommand } from "./shell.js";
import { writeConfinedFile } from "./path-safety.js";
import type { BugReportRecord } from "./storage-bug-reports.js";

export const BUG_REPORT_SCRATCH_PREFIX = "orkestrator-bug-report-";
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const MAX_DRAFT_FILE_BYTES = 1024 * 1024;
const MAX_CONTEXT_STRING = 512;

function text(value: unknown, max = MAX_CONTEXT_STRING): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** Keep only the fields and bounds the protocol declares; callers are untrusted. */
export function sanitizeBugReportClientContext(value: unknown): BugReportClientContext {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const context: BugReportClientContext = {
    surface: input.surface === "desktop" ? "desktop" : "web",
  };
  for (const key of ["appVersion", "electronVersion", "channel", "userAgent"] as const) {
    const field = text(input[key]);
    if (field) context[key] = field;
  }
  const machine = input.machine as Record<string, unknown> | undefined;
  if (machine && typeof machine === "object") {
    const label = text(machine.label);
    if (label) context.machine = { id: text(machine.id) ?? null, label };
  }
  const view = input.view as Record<string, unknown> | undefined;
  if (view && typeof view === "object") {
    const sanitized: NonNullable<BugReportClientContext["view"]> = {};
    for (const key of [
      "route",
      "projectId",
      "environmentId",
      "environmentType",
      "environmentStatus",
      "activeTabType",
    ] as const) {
      const field = text(view[key], 200);
      if (field) sanitized[key] = field;
    }
    context.view = sanitized;
  }
  if (Array.isArray(input.rendererErrors)) {
    const errors: BugReportRendererError[] = [];
    for (const candidate of input.rendererErrors.slice(-MAX_BUG_REPORT_RENDERER_ERRORS)) {
      if (!candidate || typeof candidate !== "object") continue;
      const entry = candidate as Record<string, unknown>;
      const message = text(entry.message, MAX_BUG_REPORT_RENDERER_ERROR_CHARS);
      const kind =
        entry.kind === "error" || entry.kind === "unhandledrejection" || entry.kind === "console"
          ? entry.kind
          : null;
      if (!message || !kind) continue;
      errors.push({ at: text(entry.at, 64) ?? "unknown", kind, message });
    }
    context.rendererErrors = errors;
  }
  return context;
}

/** The newest report, if any. Older ones are leftovers of a crash and are discarded. */
async function activeReport(context: CommandContext): Promise<BugReportRecord | null> {
  const [newest, ...older] = await context.storage.bugReports.listBugReports();
  for (const stale of older) await discardRecord(context, stale).catch(() => undefined);
  return newest ?? null;
}

async function requireReport(context: CommandContext, reportId: string): Promise<BugReportRecord> {
  const record = await context.storage.bugReports.getBugReport(reportId);
  if (!record) throw new Error("This bug report was discarded");
  return record;
}

/** The native session key of a report's one conversation (`createSessionKey`). */
export function bugReportSessionKey(record: Pick<BugReportRecord, "id" | "tabId">): string {
  return `env-${bugReportRuntimeId(record.id)}:${record.tabId}`;
}

async function listScreenshots(scratchDir: string): Promise<string[]> {
  const directory = path.join(scratchDir, BUG_REPORT_SCREENSHOT_DIRECTORY);
  const names = await readdir(directory).catch(() => [] as string[]);
  return names
    .filter((name) => /\.(png|jpe?g)$/i.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

async function readDraft(scratchDir: string): Promise<BugReportDraft | null> {
  const file = path.join(scratchDir, BUG_REPORT_DRAFT_FILE);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size > MAX_DRAFT_FILE_BYTES) return null;
  const parsed = parseBugReportDraft(await readFile(file, "utf8").catch(() => ""));
  return parsed ? { ...parsed, updatedAt: info.mtime.toISOString() } : null;
}

async function summary(
  context: CommandContext,
  record: BugReportRecord,
): Promise<BugReportSummary> {
  const runtimeId = bugReportRuntimeId(record.id);
  const session = record.agent
    ? await context.storage
        .getNativeAgentSession(
          nativeAgentSessionStorageKey(runtimeId, record.agent, bugReportSessionKey(record)),
        )
        .catch(() => null)
    : null;
  return {
    id: record.id,
    runtimeId,
    tabId: record.tabId,
    createdAt: record.createdAt,
    scratchDir: record.scratchDir,
    ...(record.agent ? { agent: record.agent } : {}),
    ...(session?.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
    ...(record.filed ? { filed: record.filed } : {}),
    screenshots: await listScreenshots(record.scratchDir),
  };
}

export async function getBugReportSnapshot(context: CommandContext): Promise<BugReportSnapshot> {
  const record = await activeReport(context);
  if (!record) return { report: null, draft: null };
  return { report: await summary(context, record), draft: await readDraft(record.scratchDir) };
}

/** Start a report, or return the one already open: there is only ever one. */
export async function createBugReport(
  context: CommandContext,
  clientContext: unknown,
): Promise<BugReportSnapshot> {
  const existing = await activeReport(context);
  if (existing) return getBugReportSnapshot(context);
  const scratchDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), BUG_REPORT_SCRATCH_PREFIX)),
  );
  const id = randomUUID();
  let stored: BugReportRecord;
  try {
    stored = await context.storage.bugReports.createBugReport({
      id,
      createdAt: new Date().toISOString(),
      tabId: `bug-report-${id}`,
      scratchDir,
      clientContext: sanitizeBugReportClientContext(clientContext),
    });
  } catch (error) {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  // Another open won the race; this directory was never used.
  if (stored.id !== id)
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  return getBugReportSnapshot(context);
}

/**
 * Bind the report to the agent its first message chose, and write the
 * briefing that agent loads from its working directory. The platform is fixed
 * once the first message has gone out.
 */
export async function assignBugReportAgent(
  context: CommandContext,
  reportId: string,
  agent: unknown,
): Promise<BugReportSnapshot> {
  if (!isBugReportAgent(agent)) throw new Error("This agent cannot be used for bug reports");
  const record = await requireReport(context, reportId);
  if (record.agent && record.agent !== agent && record.briefedAt) {
    throw new Error("This bug report already has an agent");
  }
  await writeBriefing(context, record, agent);
  await context.storage.bugReports.mutateBugReport(reportId, (current) => ({
    ...current,
    agent: current.briefedAt ? (current.agent ?? agent) : agent,
  }));
  return getBugReportSnapshot(context);
}

async function writeBriefing(
  context: CommandContext,
  record: BugReportRecord,
  agent: BugReportAgent,
): Promise<void> {
  const dataDir = context.storage.getDataDir();
  const facts = await collectBugReportMachineFacts({
    dataDir,
    toolchainBinDir: context.toolchainBinDir ?? defaultToolchainBinDir(dataDir),
    toolchainRoot: toolchainRootDir(dataDir),
  });
  const briefing = buildBugReportBriefing({
    agentLabel: AGENT_PLATFORM_LABELS[agent],
    facts,
    ...(record.clientContext ? { client: record.clientContext } : {}),
    scratchDir: record.scratchDir,
    draftPath: path.join(record.scratchDir, BUG_REPORT_DRAFT_FILE),
    screenshotDir: path.join(record.scratchDir, BUG_REPORT_SCREENSHOT_DIRECTORY),
  });
  // Pin the trusted temporary parent, treating the agent-writable scratch root
  // itself as an untrusted ancestor too.
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    await writeReportFile(record, name, Buffer.from(`${briefing}\n`), false);
  }
}

export async function saveBugReportScreenshot(
  context: CommandContext,
  reportId: string,
  base64Data: unknown,
): Promise<{ path: string; snapshot: BugReportSnapshot }> {
  if (typeof base64Data !== "string" || !base64Data) throw new Error("Screenshot is empty");
  const record = await requireReport(context, reportId);
  const bytes = Buffer.from(base64Data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_SCREENSHOT_BYTES) {
    throw new Error("Screenshot is empty or too large");
  }
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!isPng) throw new Error("Screenshot must be a PNG image");
  const relative = `${BUG_REPORT_SCREENSHOT_DIRECTORY}/window-${randomUUID()}.png`;
  await writeReportFile(record, relative, bytes);
  const file = path.join(record.scratchDir, relative);
  return { path: file, snapshot: await getBugReportSnapshot(context) };
}

async function writeReportFile(
  record: BugReportRecord,
  relative: string,
  bytes: Buffer,
  exclusive = true,
): Promise<void> {
  if (!ownedScratchDir(record.scratchDir)) throw new Error("Invalid report scratch directory");
  const target = await lstat(path.join(record.scratchDir, relative)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (target?.isSymbolicLink()) throw new Error("Report output cannot be a symlink");
  await writeConfinedFile(
    path.dirname(record.scratchDir),
    `${path.basename(record.scratchDir)}/${relative}`,
    bytes,
    { exclusive, maxBytes: MAX_SCREENSHOT_BYTES },
  );
}

function validateIssue(title: unknown, body: unknown): { title: string; body: string } {
  if (typeof title !== "string" || !title.trim()) throw new Error("The issue needs a title");
  if (typeof body !== "string" || !body.trim()) throw new Error("The issue needs a body");
  if (title.length > MAX_BUG_REPORT_TITLE_CHARS) throw new Error("The issue title is too long");
  if (body.length > MAX_BUG_REPORT_BODY_CHARS) throw new Error("The issue body is too long");
  return { title: title.trim(), body };
}

/** The issue URL `gh issue create` prints on its last line. */
export function issueUrlFromGhOutput(stdout: string): string | null {
  const pattern = new RegExp(
    `https://github\\.com/${BUG_REPORT_ISSUE_REPOSITORY.replace("/", "\\/")}/issues/\\d+`,
  );
  return stdout.match(pattern)?.[0] ?? null;
}

function browserFallback(title: string, body: string, reason: string): BugReportFileResult {
  const { url, bodyInUrl } = bugReportNewIssueUrl(title, body);
  return { kind: "browser", url, bodyInUrl, reason };
}

/**
 * File the approved draft. The title and body are the ones the user saw and
 * approved in the sheet, not a re-read of the file the agent may still be
 * rewriting.
 */
const filingFlights = new Map<string, Promise<BugReportFileResult>>();
const UNCERTAIN_FILING =
  "A filing attempt may already have created this issue. Check GitHub and record its URL before trying again.";

export function fileBugReport(
  context: CommandContext,
  reportId: string,
  input: { title: unknown; body: unknown; via?: unknown },
): Promise<BugReportFileResult> {
  const key = `${context.storage.getDataDir()}:${reportId}`;
  const existing = filingFlights.get(key);
  if (existing) return existing;
  const flight = fileBugReportOnce(context, reportId, input).finally(() => {
    if (filingFlights.get(key) === flight) filingFlights.delete(key);
  });
  filingFlights.set(key, flight);
  return flight;
}

async function fileBugReportOnce(
  context: CommandContext,
  reportId: string,
  input: { title: unknown; body: unknown; via?: unknown },
): Promise<BugReportFileResult> {
  const record = await requireReport(context, reportId);
  if (record.filed) return { kind: "filed", url: record.filed.url };
  if (record.filingAttempt) throw new Error(UNCERTAIN_FILING);
  const { title, body } = validateIssue(input.title, input.body);
  if (input.via === "browser") return browserFallback(title, body, "Opened on GitHub");

  const config = await context.storage.loadConfig();
  if (!(await resolveGitHubToken(config.global))) {
    return browserFallback(title, body, "GitHub CLI is not signed in on this host");
  }
  const env = await gitHubCliEnv(context.storage);
  // Persist before launching gh. Even a backend crash or lost response must
  // leave a fence against a second public issue. Only recording a known URL
  // resolves an uncertain attempt.
  const claimed = await context.storage.bugReports.mutateBugReport(reportId, (current) => {
    if (current.filed || current.filingAttempt) throw new Error(UNCERTAIN_FILING);
    return { ...current, filingAttempt: { startedAt: new Date().toISOString() } };
  });
  if (!claimed) throw new Error("This bug report was discarded");
  let stdout: string;
  try {
    ({ stdout } = await runCommand(
      gitHubCli(),
      [
        "issue",
        "create",
        "--repo",
        BUG_REPORT_ISSUE_REPOSITORY,
        "--title",
        title,
        "--body-file",
        "-",
      ],
      { env, stdin: body, timeoutMs: 60_000 },
    ));
  } catch {
    throw new Error(UNCERTAIN_FILING);
  }
  const url = issueUrlFromGhOutput(stdout);
  if (!url) throw new Error(UNCERTAIN_FILING);
  await context.storage.bugReports.mutateBugReport(reportId, (current) => ({
    ...current,
    filed: { url, filedAt: new Date().toISOString() },
  }));
  return { kind: "filed", url };
}

/** Record an issue the user submitted on GitHub themselves. */
export async function markBugReportFiled(
  context: CommandContext,
  reportId: string,
  url: unknown,
): Promise<BugReportSnapshot> {
  if (typeof url !== "string" || !/^https:\/\/github\.com\/[^\s]+$/.test(url)) {
    throw new Error("Enter the GitHub issue URL");
  }
  await requireReport(context, reportId);
  await context.storage.bugReports.mutateBugReport(reportId, (current) => ({
    ...current,
    filed: { url, filedAt: new Date().toISOString() },
  }));
  return getBugReportSnapshot(context);
}

/**
 * Only a directory this service created is ever removed: one directly under
 * the temporary directory, named with the report prefix.
 */
function ownedScratchDir(scratchDir: string): boolean {
  if (!path.basename(scratchDir).startsWith(BUG_REPORT_SCRATCH_PREFIX)) return false;
  const parent = path.dirname(scratchDir);
  let tmp = os.tmpdir();
  try {
    tmp = realpathSync(tmp);
  } catch {
    // An unreadable temporary directory still names the parent literally.
  }
  return parent === tmp || parent === os.tmpdir();
}

async function discardRecord(context: CommandContext, record: BugReportRecord): Promise<void> {
  const runtimeId = bugReportRuntimeId(record.id);
  if (record.agent) {
    const agent = record.agent;
    // Best effort: a bridge that cannot be stopped now still drains itself
    // when the backend that started it exits (ORKESTRATOR_PARENT_PID).
    await Promise.resolve()
      .then(() => stopLocalServer(runtimeId, context, agent))
      .catch(() => undefined);
  }
  // Orkestrator's own session records only; the provider's conversation is
  // never deleted (AGENTS.md, invariant 13).
  await context.storage.deleteNativeAgentSessionsByEnvironment(runtimeId).catch(() => undefined);
  await context.storage.bugReports.deleteBugReport(record.id);
  if (ownedScratchDir(record.scratchDir)) {
    await rm(record.scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function discardBugReport(
  context: CommandContext,
  reportId: string,
): Promise<BugReportSnapshot> {
  const record = await context.storage.bugReports.getBugReport(reportId);
  if (record) await discardRecord(context, record);
  return getBugReportSnapshot(context);
}

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { bugReportRuntimeId } from "@orkestrator/protocol/bug-report";

import {
  assignBugReportAgent,
  createBugReport,
  discardBugReport,
  fileBugReport,
  getBugReportSnapshot,
  issueUrlFromGhOutput,
  markBugReportFiled,
  sanitizeBugReportClientContext,
  saveBugReportScreenshot,
} from "./bug-report-service.js";
import {
  bugReportBridgeFieldNames,
  bugReportBridgeIdentityFromFields,
  bugReportRuntimeEnvironment,
  resolveBugReportRuntime,
} from "./bug-report-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { localServerFields } from "./commands-local-server-lifecycle.js";
import { StorageService } from "./storage.js";

const dataDirs: string[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  for (const dir of [...dataDirs.splice(0), ...scratchDirs.splice(0)]) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createContext(): Promise<CommandContext> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-bug-report-storage-"));
  dataDirs.push(dataDir);
  const storage = new StorageService(dataDir);
  await storage.init();
  return {
    storage,
    toolchainBinDir: path.join(dataDir, "toolchain", "bin"),
  } as unknown as CommandContext;
}

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("not really an image"),
]).toString("base64");

describe("bug report service", () => {
  test("starts one report, writes the briefing on assignment and reads the draft", async () => {
    const context = await createContext();
    const created = await createBugReport(context, {
      surface: "desktop",
      appVersion: "2.40.0-beta",
      rendererErrors: [{ at: "2026-01-01T00:00:00Z", kind: "console", message: "boom" }],
    });
    const report = created.report!;
    scratchDirs.push(report.scratchDir);
    expect(report.runtimeId).toBe(bugReportRuntimeId(report.id));
    expect(report.agent).toBeUndefined();
    expect(created.draft).toBeNull();

    // Only ever one report: a second create returns the open one, also when
    // two race.
    const again = await Promise.all([
      createBugReport(context, { surface: "web" }),
      createBugReport(context, { surface: "web" }),
    ]);
    expect(again.map((snapshot) => snapshot.report?.id)).toEqual([report.id, report.id]);
    expect(await context.storage.bugReports.listBugReports()).toHaveLength(1);

    const assigned = await assignBugReportAgent(context, report.id, "codex");
    expect(assigned.report?.agent).toBe("codex");
    const briefing = await fs.readFile(path.join(report.scratchDir, "AGENTS.md"), "utf8");
    expect(briefing).toContain("Never file the issue yourself");
    expect(briefing).toContain(path.join(report.scratchDir, "issue.md"));
    expect(briefing).toContain("[console] boom");
    expect(briefing).toContain("2.40.0-beta");
    expect(await fs.readFile(path.join(report.scratchDir, "CLAUDE.md"), "utf8")).toBe(briefing);

    await fs.writeFile(
      path.join(report.scratchDir, "issue.md"),
      "# Sidebar crashes on resize\n\n## Summary\nIt crashes.\n",
    );
    const withDraft = await getBugReportSnapshot(context);
    expect(withDraft.draft).toMatchObject({
      title: "Sidebar crashes on resize",
      body: "## Summary\nIt crashes.",
    });
  });

  test("rejects agents the flow does not offer", async () => {
    const context = await createContext();
    const { report } = await createBugReport(context, {});
    scratchDirs.push(report!.scratchDir);
    await expect(assignBugReportAgent(context, report!.id, "cursor")).rejects.toThrow(
      "cannot be used",
    );
  });

  test("saves PNG screenshots into the scratch directory only", async () => {
    const context = await createContext();
    const { report } = await createBugReport(context, {});
    scratchDirs.push(report!.scratchDir);
    await expect(
      saveBugReportScreenshot(context, report!.id, Buffer.from("text").toString("base64")),
    ).rejects.toThrow("PNG");
    const saved = await saveBugReportScreenshot(context, report!.id, PNG);
    expect(path.dirname(saved.path)).toBe(path.join(report!.scratchDir, "screenshots"));
    expect(saved.snapshot.report?.screenshots).toEqual([saved.path]);
  });

  test("the browser route prefills GitHub without running gh", async () => {
    const context = await createContext();
    const { report } = await createBugReport(context, {});
    scratchDirs.push(report!.scratchDir);
    const result = await fileBugReport(context, report!.id, {
      title: "A title",
      body: "A body",
      via: "browser",
    });
    expect(result).toMatchObject({ kind: "browser", bodyInUrl: true });
    expect(result.kind === "browser" && new URL(result.url).searchParams.get("body")).toBe(
      "A body",
    );
    await expect(
      fileBugReport(context, report!.id, { title: "", body: "x", via: "browser" }),
    ).rejects.toThrow("title");
  });

  test("records a filed issue and discards the report and its scratch directory", async () => {
    const context = await createContext();
    const { report } = await createBugReport(context, {});
    scratchDirs.push(report!.scratchDir);
    await expect(markBugReportFiled(context, report!.id, "not a url")).rejects.toThrow();
    const filed = await markBugReportFiled(
      context,
      report!.id,
      "https://github.com/orkestrator-ai/orkestrator-v2/issues/42",
    );
    expect(filed.report?.filed?.url).toBe(
      "https://github.com/orkestrator-ai/orkestrator-v2/issues/42",
    );
    // A filed report is short-circuited rather than filed twice.
    expect(
      await fileBugReport(context, report!.id, { title: "t", body: "b", via: "browser" }),
    ).toEqual({ kind: "filed", url: "https://github.com/orkestrator-ai/orkestrator-v2/issues/42" });

    const after = await discardBugReport(context, report!.id);
    expect(after.report).toBeNull();
    expect(existsSync(report!.scratchDir)).toBe(false);
  });

  test("never removes a directory it did not create", async () => {
    const context = await createContext();
    const foreign = await fs.mkdtemp(path.join(tmpdir(), "ork-not-a-report-"));
    scratchDirs.push(foreign);
    await context.storage.bugReports.createBugReport({
      id: "foreign",
      createdAt: new Date().toISOString(),
      tabId: "bug-report-foreign",
      scratchDir: foreign,
    });
    await discardBugReport(context, "foreign");
    expect(existsSync(foreign)).toBe(true);
    expect(await context.storage.bugReports.getBugReport("foreign")).toBeNull();
  });

  test("bounds and filters the client context", () => {
    const context = sanitizeBugReportClientContext({
      surface: "desktop",
      appVersion: "x".repeat(5_000),
      secret: "dropped",
      view: { environmentId: "env-1", prompt: "dropped" },
      rendererErrors: [
        ...Array.from({ length: 50 }, (_, index) => ({
          at: "t",
          kind: "error",
          message: `e${index}`,
        })),
        { at: "t", kind: "nonsense", message: "dropped" },
      ],
    });
    expect(context.appVersion?.length).toBe(512);
    expect(context).not.toHaveProperty("secret");
    expect(context.view).toEqual({ environmentId: "env-1" });
    expect(context.rendererErrors).toHaveLength(29);
    expect(sanitizeBugReportClientContext(null)).toEqual({ surface: "web" });
  });

  test("finds the issue URL gh prints", () => {
    expect(
      issueUrlFromGhOutput(
        "Creating issue in orkestrator-ai/orkestrator-v2\n\nhttps://github.com/orkestrator-ai/orkestrator-v2/issues/1234\n",
      ),
    ).toBe("https://github.com/orkestrator-ai/orkestrator-v2/issues/1234");
    expect(issueUrlFromGhOutput("https://github.com/someone/else/issues/1")).toBeNull();
  });
});

describe("bug report runtime", () => {
  test("projects the bridge identity into the fields the server lifecycle uses", () => {
    for (const agent of ["claude", "codex", "opencode"] as const) {
      expect(bugReportBridgeFieldNames(agent)).toEqual(localServerFields(agent));
    }
    const environment = bugReportRuntimeEnvironment("bug-report:r1", {
      id: "r1",
      createdAt: "2026-01-01T00:00:00.000Z",
      tabId: "t",
      scratchDir: "/tmp/scratch",
      agent: "claude",
      bridgePort: 4100,
      bridgePid: 77,
    });
    expect(environment).toMatchObject({
      id: "bug-report:r1",
      environmentType: "local",
      worktreePath: "/tmp/scratch",
      status: "running",
      localClaudePort: 4100,
      claudeBridgePid: 77,
      agentSettings: { executionPolicy: { sandbox: "provider", approvals: "ask" } },
    });
    expect(
      bugReportBridgeIdentityFromFields("claude", { localClaudePort: null, claudeBridgePid: null }),
    ).toEqual({ changed: true });
    expect(bugReportBridgeIdentityFromFields("claude", { name: "x" })).toEqual({ changed: false });
  });

  test("resolves only reports that exist and have an agent", async () => {
    const context = await createContext();
    expect(await resolveBugReportRuntime(context.storage, "env-1")).toEqual({
      status: "not-bug-report",
    });
    expect(await resolveBugReportRuntime(context.storage, "bug-report:missing")).toMatchObject({
      status: "unavailable",
      reason: "missing",
    });
    const { report } = await createBugReport(context, {});
    scratchDirs.push(report!.scratchDir);
    expect(await resolveBugReportRuntime(context.storage, report!.runtimeId)).toMatchObject({
      status: "unavailable",
      reason: "unassigned",
    });
    await assignBugReportAgent(context, report!.id, "claude");
    expect(await resolveBugReportRuntime(context.storage, report!.runtimeId)).toMatchObject({
      status: "ready",
      record: { agent: "claude" },
    });
  });
});

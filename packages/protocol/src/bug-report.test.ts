import { describe, expect, test } from "bun:test";

import {
  BUG_REPORT_NEW_ISSUE_URL,
  buildBugReportBriefing,
  bugReportFirstPromptNote,
  bugReportIdFromRuntimeId,
  bugReportNewIssueUrl,
  bugReportRuntimeId,
  parseBugReportDraft,
  type BugReportMachineFacts,
} from "./bug-report.js";
import { stripCoordinatorContext } from "./coordinator.js";

const FACTS: BugReportMachineFacts = {
  platform: "darwin",
  osRelease: "Darwin 25.0.0",
  arch: "arm64",
  bunVersion: "1.4.4",
  now: "2026-10-29T00:00:00.000Z",
  dataDir: "/data",
  dataDirExists: true,
  logsDir: "/data/logs",
  debugLogging: false,
  recentLogs: [],
  backend: null,
  toolchainBinDir: null,
  managedGh: null,
  desktopApp: null,
};

describe("bug report protocol", () => {
  test("round-trips runtime ids and rejects anything else", () => {
    expect(bugReportIdFromRuntimeId(bugReportRuntimeId("abc-123"))).toBe("abc-123");
    expect(bugReportIdFromRuntimeId("coordinator:abc")).toBeNull();
    expect(bugReportIdFromRuntimeId("bug-report:../etc")).toBeNull();
    expect(bugReportIdFromRuntimeId("bug-report:")).toBeNull();
  });

  test("reads a draft's title from its first level-one heading", () => {
    expect(parseBugReportDraft("\n# Title here\n\n## Summary\nBody\n")).toEqual({
      title: "Title here",
      body: "## Summary\nBody",
    });
    expect(parseBugReportDraft("## Summary only\nBody")).toBeNull();
    expect(parseBugReportDraft("# Title without a body\n")).toBeNull();
  });

  test("prefills the new-issue URL and drops a body too long for it", () => {
    const short = bugReportNewIssueUrl("Crash", "Body text");
    expect(short.bodyInUrl).toBe(true);
    expect(new URL(short.url).searchParams.get("title")).toBe("Crash");
    expect(short.url.startsWith(BUG_REPORT_NEW_ISSUE_URL)).toBe(true);
    const long = bugReportNewIssueUrl("Crash", "x".repeat(20_000));
    expect(long.bodyInUrl).toBe(false);
    expect(new URL(long.url).searchParams.has("body")).toBe(false);
  });

  test("the first-prompt note is hidden like a coordinator preamble", () => {
    const prompt = `${bugReportFirstPromptNote("/tmp/x/AGENTS.md")}It crashed`;
    expect(prompt).toContain("/tmp/x/AGENTS.md");
    expect(stripCoordinatorContext(prompt)).toBe("It crashed");
  });

  test("the briefing tells the agent to draft, never file, and to redact", () => {
    const briefing = buildBugReportBriefing({
      agentLabel: "Claude Code",
      facts: FACTS,
      client: {
        surface: "desktop",
        appVersion: "2.40.0",
        channel: "Stable",
        view: { environmentId: "env-1", environmentType: "local" },
        rendererErrors: [],
      },
      scratchDir: "/tmp/scratch",
      draftPath: "/tmp/scratch/issue.md",
      screenshotDir: "/tmp/scratch/screenshots",
    });
    expect(briefing).toContain("Write the issue to /tmp/scratch/issue.md");
    expect(briefing).toContain("do not run `gh issue create`");
    expect(briefing).toContain("GitHub issues on this repository are public");
    expect(briefing).toContain("environment id env-1");
    expect(briefing).toContain("2.40.0 (Stable channel)");
    expect(briefing).toContain("Recent app (renderer) errors: none recorded");
  });
});

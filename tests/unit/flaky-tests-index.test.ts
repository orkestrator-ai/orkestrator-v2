import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const register = path.join(root, "docs/tests/flaky-tests");
const INDEX = "0000-index.md";

const STATUSES = new Set(["open", "resolved", "environmental"]);
const CASE_FILE = /^\d{4}-.+\.md$/;

// Case numbers that were already shared by more than one file when the
// uniqueness check was added (todo 0732). They are frozen, not renumbered
// (0030): a new case takes the next number after the highest in use, and no
// number here may gain another file. Case files are never deleted, so the
// list must match the register exactly.
const FROZEN_DUPLICATES: Record<string, string[]> = {
  "0147": [
    "agent-bridges/0147-cursor-sdk-boundary-diagnostics-weak-transport.md",
    "coordinator-and-multi-review/0147-review-validation-environment-change-cap-timeout.md",
  ],
  "0151": [
    "environments-and-containers/0151-local-named-pipe-line-count-aggregate-timeout.md",
    "environments-and-containers/0151-strict-lifecycle-missing-container-timeout.md",
  ],
  "0161": [
    "agent-bridges/0161-acp-aggregate-transcript-trim-host-load.md",
    "previews-annotations-and-gateway/0161-annotation-panel-capacity-discard.md",
  ],
  "0162": [
    "coordinator-and-multi-review/0162-agent-mail-rehydrate-tooltip-click.md",
    "environments-and-containers/0162-electron-diff-statistics-aggregate-timeout.md",
  ],
  "0163": [
    "electron-and-desktop/0163-desktop-isolated-browser-aggregate-timeout.md",
    "environments-and-containers/0163-claude-credential-injection-aggregate-hang.md",
  ],
  "0164": [
    "agent-bridges/0164-cursor-bridge-turbo-group-stall.md",
    "web-ui/0164-globalstyles-reduced-motion-page-crash.md",
  ],
  "0176": [
    "backend-services-and-tooling/0176-logged-aggregate-silent-workspace-watchdog.md",
    "web-ui/0176-initialization-identical-tail-scroll-count.md",
  ],
  "0512": [
    "coordinator-and-multi-review/0512-change-tracking-deadline-wall-clock.md",
    "design-canvas-and-artifacts/0512-mermaid-watchdog-elapsed-under-load.md",
  ],
  "0513": [
    "agent-bridges/0513-claude-bridge-plan-exit-persistence.md",
    "web-ui/0513-terminal-history-backward-page-count.md",
  ],
  "0514": [
    "agent-bridges/0514-pi-bridge-vendor-timeout-under-load.md",
    "design-canvas-and-artifacts/0514-runtime-listener-port-reservation.md",
  ],
  "0515": [
    "aggregate-validation-runs/0515-claude-container-main-merge-validation.md",
    "aggregate-validation-runs/0515-idle-observation-main-merge-validation.md",
    "electron-and-desktop/0515-electron-nickname-reload-deadline.md",
    "electron-and-desktop/0515-electron-nickname-reload-timeout.md",
  ],
  "0516": [
    "agent-bridges/0516-acp-long-structured-turn-timeout.md",
    "coordinator-and-multi-review/0516-looped-review-reconciliation-merge-timeout.md",
  ],
  "0517": [
    "design-canvas-and-artifacts/0517-container-preview-containment-merge-timeout.md",
    "web-ui/0517-monaco-runtime-browser-startup.md",
  ],
  "0518": [
    "aggregate-validation-runs/0518-claude-revision-tokens-main-merge-validation.md",
    "aggregate-validation-runs/0518-design-rerun-main-merge-docker-preview.md",
    "design-canvas-and-artifacts/0518-mermaid-watchdog-aggregate-deadline.md",
  ],
  "0632": [
    "design-canvas-and-artifacts/0632-private-design-open-after-rename.md",
    "environments-and-containers/0632-firewall-policy-probe-budget.md",
  ],
  "0671": [
    "agent-bridges/0671-claude-mcp-live-probe-silent-hang.md",
    "backend-services-and-tooling/0671-cli-scenarios-environment-start-under-extreme-load.md",
    "backend-services-and-tooling/0671-fix-path-login-shell-aggregate-timeout.md",
    "coordinator-and-multi-review/0671-coordinator-live-runner-aggregate-timeouts.md",
    "coordinator-and-multi-review/0671-coordinator-opencode-reconcile-join-race.md",
    "design-canvas-and-artifacts/0671-design-electron-preview-group-shutdown.md",
    "web-ui/0671-environment-item-tooltip-aggregate-stall.md",
  ],
  "0672": [
    "aggregate-validation-runs/0672-mcp-management-0039-bridge-suite-load.md",
    "design-canvas-and-artifacts/0672-artifact-shell-policy-aggregate-stall.md",
    "design-canvas-and-artifacts/0672-preview-interactive-chromium-page-crash.md",
    "environments-and-containers/0672-container-storage-marker-aggregate-timeout.md",
    "native-agents-and-transcripts/0672-shared-observation-http-aggregate-miss.md",
  ],
  "0673": [
    "electron-and-desktop/0673-desktop-startup-validation-timing-gap.md",
    "environments-and-containers/0673-environment-cleanup-container-step-timeout.md",
  ],
  "0692": [
    "aggregate-validation-runs/0692-sidebar-collision-validation.md",
    "backend-services-and-tooling/0692-cli-lost-submission-deadline-under-load.md",
  ],
  "0694": [
    "aggregate-validation-runs/0694-command-handover-validation.md",
    "aggregate-validation-runs/0694-pi-default-model-validation-timeout-cluster.md",
    "previews-annotations-and-gateway/0694-preview-retention-scheduled-reconcile.md",
  ],
  "0721": [
    "aggregate-validation-runs/0721-pull-request-viewer-validation.md",
    "web-ui/0721-tool-fold-history-anchor.md",
  ],
  "0724": [
    "aggregate-validation-runs/0724-coordinator-adapters-main-merge-validation.md",
    "environments-and-containers/0724-container-network-address-pool-timeout.md",
  ],
  "0785": [
    "agent-bridges/0785-local-bridge-reuse-busy-replace-timeout.md",
    "coordinator-and-multi-review/0785-opencode-research-server-registration-timeout.md",
  ],
  "0786": [
    "backend-services-and-tooling/0786-tmux-interactive-polling-teardown-rejection.md",
    "environments-and-containers/0786-merged-container-cleanup-remote-branch-timeout.md",
  ],
  "0790": [
    "aggregate-validation-runs/0790-environment-list-main-merge-validation.md",
    "aggregate-validation-runs/0790-settings-machine-strip-validation.md",
    "previews-annotations-and-gateway/0790-preview-transport-attachment-release-timing.md",
  ],
  "0791": [
    "agent-bridges/0791-codex-command-catalogue-stale-race.md",
    "previews-annotations-and-gateway/0791-annotation-semantic-context-budget.md",
  ],
  "0826": [
    "aggregate-validation-runs/0826-reconnect-freshness-validation.md",
    "aggregate-validation-runs/0826-scheduled-jobs-review-validation.md",
    "native-agents-and-transcripts/0826-command-catalogue-maximal-inventories-timeout.md",
  ],
  "0947": [
    "agent-bridges/0947-claude-stale-list-tombstone-timeout.md",
    "coordinator-and-multi-review/0947-coordinator-opencode-credential-replacement-sigkill.md",
    "coordinator-and-multi-review/0947-reviewer-stale-progress-aggregate-timeout.md",
    "environments-and-containers/0947-worktree-git-aggregate-timeouts.md",
  ],
  "1011": [
    "backend-services-and-tooling/1011-design-owned-descendant-discovery.md",
    "environments-and-containers/1011-rootless-start-fixture-port-collision.md",
  ],
};

function groupFolders(): string[] {
  return readdirSync(register, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function caseFiles(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => CASE_FILE.test(name) && name !== INDEX)
    .sort();
}

function tableCells(line: string): string[] | undefined {
  if (!line.startsWith("| ")) return undefined;
  return line
    .slice(1, line.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
}

function caseRows(index: string): Array<{ id: string; status: string; file: string }> {
  const rows: Array<{ id: string; status: string; file: string }> = [];
  for (const line of index.split("\n")) {
    const cells = tableCells(line);
    if (!cells || cells.length < 6 || !/^\d{4}$/.test(cells[0]!)) continue;
    const link = cells.at(-1)!.match(/^\[([^\]]+\.md)\]\(\1\)$/);
    if (!link) continue;
    rows.push({ id: cells[0]!, status: cells[1]!, file: link[1]! });
  }
  return rows;
}

function groupLinks(index: string): string[] {
  const links: string[] = [];
  for (const line of index.split("\n")) {
    const link = tableCells(line)?.[0]?.match(/^\[[^\]]+\]\(([a-z0-9-]+)\/0000-index\.md\)$/);
    if (link) links.push(link[1]!);
  }
  return links;
}

describe("flaky test register", () => {
  test("the top-level index links every group folder and tracks no cases", () => {
    const index = readFileSync(path.join(register, INDEX), "utf8");

    expect(index).toMatch(/Do not\s+read every case file/);
    expect(caseRows(index)).toEqual([]);
    expect(caseFiles(register)).toEqual([]);
    expect(groupLinks(index).sort()).toEqual(groupFolders());
  });

  test("case numbers are unique across and within groups, except the frozen duplicates", () => {
    const byNumber = new Map<string, string[]>();
    for (const group of groupFolders()) {
      for (const file of caseFiles(path.join(register, group))) {
        const id = file.slice(0, 4);
        byNumber.set(id, [...(byNumber.get(id) ?? []), `${group}/${file}`]);
      }
    }
    const duplicates = Object.fromEntries(
      [...byNumber]
        .filter(([, files]) => files.length > 1)
        .map(([id, files]) => [id, files.sort()]),
    );

    expect(duplicates).toEqual(FROZEN_DUPLICATES);
  });

  for (const group of groupFolders()) {
    test(`${group} index lists every case file and stores a status for each row`, () => {
      const folder = path.join(register, group);
      const rows = caseRows(readFileSync(path.join(folder, INDEX), "utf8"));
      const files = caseFiles(folder);

      expect(rows.length).toBe(files.length);
      expect(new Set(rows.map((row) => row.file))).toEqual(new Set(files));

      for (const row of rows) {
        expect(STATUSES.has(row.status), `${row.id} has status ${row.status}`).toBe(true);
        expect(row.file.startsWith(`${row.id}-`)).toBe(true);
        const body = readFileSync(path.join(folder, row.file), "utf8");
        expect(body).toMatch(new RegExp(`^- \\*\\*ID:\\*\\* ${row.id}$`, "m"));
        expect(body).toMatch(new RegExp(`^- \\*\\*Status:\\*\\* ${row.status}$`, "m"));
      }
    });
  }
});

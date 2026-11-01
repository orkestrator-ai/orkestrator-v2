import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  newReviewValidationRun,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import {
  POLL_BUDGET_MS,
  containerName,
  fixtureEnvironment,
  inContainer,
  invoke,
  localName,
  login,
  openSecondWindow,
  reloadApp,
  selectEnvironment,
  setDocumentHidden,
  type Environment,
} from "./container-wiring-support";

/**
 * Container app wiring in a real browser, part two (todo 0048, task 4). Same
 * profile as `container-files-wiring.spec.ts`: `--fixture-environments
 * local,container --no-agent-credentials`, and no provider turn.
 *
 * - Merge from the UI on a container. Every `gh` call for a container runs
 *   inside it, so the spec installs a stand-in `gh` there
 *   (`container-fake-gh.sh`) that merges with plain Git into the fixture's
 *   bare origin. The app side is real: the PR monitor reading the PR, the
 *   toolbar, the dialog, `merge_environment_pr`, the stored state and the
 *   views of a second window, an inactive environment and a reload. GitHub's
 *   own behaviour is not qualified here (task 5).
 * - Validation output from a container. Real commands run through the
 *   environment-owned validation worker (`start_review_validation`); a
 *   pipeline record naming that run is imported, and the Build tab's Tests
 *   view reads the output back through `get_review_validation_output`. Only
 *   the plan is hand-written: normally a model's preparation turn writes it.
 * - The project coordinator view follows delegations to a container and a
 *   local environment, a repository context change and their closing, across
 *   an environment switch, a hidden document, a reload and a second window.
 */

// The direct invoke carries the gateway token; keep it out of artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

const FAKE_GH = readFileSync(path.join(import.meta.dirname, "container-fake-gh.sh"), "utf8");
const FAKE_GH_DIR = "/tmp/orkestrator-qa-fake-gh";
/** The PR monitor's open-PR cadence (20 s) plus a read on a loaded host. */
const PR_MONITOR_BUDGET_MS = 45_000;
/** The coordinator's maintenance sweep (60 s) closes a stopped worker's delegation. */
const DELEGATION_SWEEP_BUDGET_MS = 100_000;

type Project = { id: string; localPath?: string };
type PaneLeaf = {
  kind: "leaf";
  id: string;
  tabs: Array<Record<string, unknown>>;
  activeTabId: string | null;
};
type PaneLayout = {
  version: number;
  containerId: string | null;
  activePaneId: string;
  root: PaneLeaf | { kind: "split"; children: unknown[] };
  revision: number;
};
type CoordinatorSnapshot = {
  workspace: {
    id: string;
    lifecycleState: string;
    repositoryContextRevision: number;
    conversations: Array<{ id: string; role?: string }>;
  };
  workflows: Array<{
    conversationId: string;
    resourceId: string;
    delegation?: { state: string };
  }>;
};

async function waitForEnvironmentStatus(name: string, status: string, timeout = 120_000) {
  await expect
    .poll(async () => (await fixtureEnvironment(name)).status, { timeout, intervals: [1_000] })
    .toBe(status);
}

function toolbarButton(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).first();
}

test("Docker fixture container merge from the UI reaches the origin and every view", async ({
  page,
}, testInfo) => {
  test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");
  test.setTimeout(6 * 60_000);
  const container = await fixtureEnvironment(containerName);
  const containerId = container.containerId;
  if (!containerId) throw new Error(`${containerName} has no container`);
  const run = randomUUID().slice(0, 8);
  const file = `qa-merge-${run}.txt`;
  const prUrl = `https://github.com/fixture/test-project/pull/${Number.parseInt(run, 16) % 100_000}`;
  const base = inContainer(containerId, "git rev-parse HEAD").trim();
  const branch = inContainer(containerId, "git branch --show-current").trim();
  const originMain = inContainer(containerId, "git ls-remote origin refs/heads/main")
    .split(/\s+/)[0]!
    .trim();

  const cleanup = async () => {
    await invoke("clear_environment_pr", { environmentId: container.id }).catch(() => undefined);
    inContainer(containerId, "rm -f /usr/local/bin/gh", { user: "root" });
    inContainer(
      containerId,
      [
        `git push -q -f origin ${originMain}:refs/heads/main`,
        `git push -q origin --delete ${branch} 2>/dev/null || true`,
        `git reset -q --hard ${base}`,
        `rm -rf ${FAKE_GH_DIR}`,
      ].join("; "),
    );
  };

  try {
    // The pull request: one commit on the environment branch, pushed to origin.
    inContainer(
      containerId,
      [
        `echo merged > ${file}`,
        `git add ${file}`,
        `git -c user.name=QA -c user.email=qa@invalid.local commit -q -m "QA merge ${run}"`,
        "git push -q origin HEAD",
        `mkdir -p ${FAKE_GH_DIR}`,
        `echo ${prUrl} > ${FAKE_GH_DIR}/url`,
        `echo ${branch} > ${FAKE_GH_DIR}/branch`,
      ].join(" && "),
    );
    inContainer(containerId, "cat > /usr/local/bin/gh && chmod 755 /usr/local/bin/gh", {
      user: "root",
      input: FAKE_GH,
    });
    expect(inContainer(containerId, "command -v gh").trim()).toBe("/usr/local/bin/gh");

    await page.setViewportSize({ width: 1400, height: 900 });
    await login(page, testInfo);
    await test.step("the PR monitor reads the container's PR and offers the merge", async () => {
      // Mergeability unknown, as a freshly recorded PR is: only the monitor's
      // read through the container's `gh` can enable the merge button.
      await invoke("set_environment_pr", {
        environmentId: container.id,
        prUrl,
        prState: "open",
        hasMergeConflicts: null,
      });
      await selectEnvironment(page, containerName);
      await expect(toolbarButton(page, "Merge PR")).toBeEnabled({
        timeout: PR_MONITOR_BUDGET_MS,
      });
      expect(inContainer(containerId, `cat ${FAKE_GH_DIR}/calls`)).toContain(
        `pr view ${prUrl} --json url,state,headRefOid,mergeable`,
      );
    });

    const second = await openSecondWindow(page.context(), testInfo);
    await test.step("merging from the dialog merges into origin main", async () => {
      // The second window watches from another environment (inactive).
      await selectEnvironment(second, localName);
      await toolbarButton(page, "Merge PR").click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog.getByText("Merge Pull Request")).toBeVisible();
      await dialog.getByRole("button", { name: "Merge PR", exact: true }).click();
      await expect(page.getByText("Branch merged").first()).toBeVisible({ timeout: 60_000 });
      await expect(toolbarButton(page, "PR Merged")).toBeVisible({ timeout: 15_000 });
      await expect(toolbarButton(page, "Merge PR")).toHaveCount(0);
      await expect(toolbarButton(page, "Clean Up")).toBeVisible();
      expect(inContainer(containerId, `cat ${FAKE_GH_DIR}/calls`)).toContain(
        `pr merge ${prUrl} --squash --delete-branch`,
      );
      inContainer(containerId, "git fetch -q origin");
      expect(inContainer(containerId, `git show origin/main:${file}`).trim()).toBe("merged");
      expect(inContainer(containerId, `git ls-remote origin refs/heads/${branch}`).trim()).toBe("");
      const stored = await fixtureEnvironment(containerName);
      expect(stored).toMatchObject({ status: "running" });
      expect(
        (
          await invoke<Array<Environment & { prState?: string }>>("get_environments", {
            projectId: container.projectId,
          })
        ).find((environment) => environment.id === container.id)?.prState,
      ).toBe("merged");
    });

    await test.step("the inactive second window shows the merge on return", async () => {
      await selectEnvironment(second, containerName);
      await expect(toolbarButton(second, "PR Merged")).toBeVisible({ timeout: 15_000 });
      await expect(toolbarButton(second, "Merge PR")).toHaveCount(0);
      await second.close();
    });

    await test.step("a reload shows the merged PR", async () => {
      await reloadApp(page, testInfo);
      await selectEnvironment(page, containerName);
      await expect(toolbarButton(page, "PR Merged")).toBeVisible({ timeout: 30_000 });
      await expect(toolbarButton(page, "Merge PR")).toHaveCount(0);
    });
  } finally {
    await cleanup();
  }
});

test("Docker fixture container validation output reads real command output in the Build tab", async ({
  page,
}, testInfo) => {
  test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");
  test.setTimeout(5 * 60_000);
  const container = await fixtureEnvironment(containerName);
  const containerId = container.containerId;
  if (!containerId) throw new Error(`${containerName} has no container`);
  const run = randomUUID().slice(0, 8);
  const passing = `printf 'qa-validation-stdout-${run}\\n'; git rev-parse --is-inside-work-tree`;
  const failing = `printf 'qa-validation-stderr-${run}\\n' >&2; exit 3`;
  const pipelineId = `qa-validation-pipeline-${run}`;
  const taskId = `qa-validation-task-${run}`;
  const tabId = `build-${pipelineId}`;

  const { head } = await invoke<{ head: string }>("get_environment_uncommitted_paths", {
    environmentId: container.id,
  });
  let validation = newReviewValidationRun(`review-validation-qa-${run}`, {
    headRef: head,
    limitations: [],
    commands: [
      {
        id: "pass",
        command: passing,
        cwd: ".",
        dependsOn: [],
        resources: [],
        weight: 1,
        timeoutMs: 30_000,
      },
      {
        id: "fail",
        command: failing,
        cwd: ".",
        dependsOn: [],
        resources: [],
        weight: 1,
        timeoutMs: 30_000,
      },
    ],
  });

  const removeBuildTab = async () => {
    const layout = await invoke<PaneLayout | null>("get_pane_layout", {
      environmentId: container.id,
    });
    if (!layout || layout.root.kind !== "leaf") return;
    const tabs = layout.root.tabs.filter((tab) => tab.id !== tabId);
    if (tabs.length === layout.root.tabs.length) return;
    await invoke("save_pane_layout", {
      environmentId: container.id,
      layout: {
        ...layout,
        root: {
          ...layout.root,
          tabs,
          activeTabId:
            layout.root.activeTabId === tabId
              ? ((tabs[0]?.id as string | undefined) ?? null)
              : layout.root.activeTabId,
        },
      },
      expectedRevision: layout.revision,
    });
  };

  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page, testInfo);
  try {
    await test.step("the validation worker runs the commands in the container", async () => {
      validation = await invoke<ReviewValidationRun>("start_review_validation", {
        environmentId: container.id,
        run: validation,
      });
      await expect
        .poll(
          async () => {
            validation = await invoke<ReviewValidationRun>("status_review_validation", {
              environmentId: container.id,
              run: validation,
            });
            return validation.status;
          },
          { timeout: 60_000 },
        )
        .toBe("completed");
      expect(validation.results.map((result) => result.status)).toEqual(["passed", "failed"]);
    });

    await test.step("a pipeline naming the run opens in the container's Build tab", async () => {
      const imported = await invoke<{ importedIds: string[] }>("import_legacy_build_pipelines", {
        projectId: container.projectId,
        snapshots: [
          {
            id: pipelineId,
            taskId,
            projectId: container.projectId,
            environmentId: container.id,
            environmentType: "containerized",
            agentType: "codex",
            // A finished phase: no supervisor pass, so nothing starts a turn.
            phase: "failed",
            error: "QA validation fixture",
            sessions: [],
            currentSessionIndex: -1,
            iteration: 0,
            maxIterations: 1,
            backendRevision: 0,
            controller: "backend",
            createdAt: new Date().toISOString(),
            taskTitle: `QA validation ${run}`,
            taskSnapshot: {
              title: `QA validation ${run}`,
              description: "",
              acceptanceCriteria: "",
              comments: [],
              images: [],
            },
            validationRun: validation,
          },
        ],
      });
      expect(imported.importedIds).toEqual([pipelineId]);
      // A container whose tabs were never rearranged has no persisted layout
      // (a renderer persists one only on a change). Start from that state:
      // `ensureBuildPipelineTab` then writes a layout holding only the build
      // tab, selected, as it does for a pipeline started on an existing
      // environment. The renderer seeds its default terminal beside it and
      // must leave the build tab selected.
      const existing = await invoke<PaneLayout | null>("get_pane_layout", {
        environmentId: container.id,
      });
      if (existing) {
        await invoke("delete_pane_layout", {
          environmentId: container.id,
          expectedRevision: existing.revision,
        });
      }
      await invoke("save_pane_layout", {
        environmentId: container.id,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              {
                id: tabId,
                type: "claude-build",
                buildTabData: { environmentId: container.id, pipelineId, taskId, isLocal: false },
              },
            ],
            activeTabId: tabId,
          },
        },
        expectedRevision: 0,
      });
      await selectEnvironment(page, containerName);
      await expect(page.getByRole("button", { name: /^Terminal \d+/ }).first()).toBeVisible({
        timeout: 30_000,
      });
      // The renderer persists the seeded layout without moving the selection.
      await expect
        .poll(async () => {
          const layout = await invoke<PaneLayout | null>("get_pane_layout", {
            environmentId: container.id,
          });
          return layout?.root.kind === "leaf"
            ? { tabs: layout.root.tabs.map((tab) => tab.id), active: layout.root.activeTabId }
            : null;
        })
        .toEqual({ tabs: [tabId, "default"], active: tabId });
    });

    const expectOutput = async (target: Page) => {
      const graph = target.getByRole("tablist", { name: "Build pipeline" });
      await expect(graph).toBeVisible({ timeout: 30_000 });
      await graph
        .getByRole("tab", { name: /^Prepare,/ })
        .first()
        .click();
      const tests = target.getByRole("tab", { name: "Tests", exact: true });
      if (await tests.isVisible().catch(() => false)) await tests.click();
      const commands = target.getByRole("table", { name: "Validation commands" });
      await expect(commands).toBeVisible({ timeout: 15_000 });
      await target.getByRole("button", { name: `View terminal output for ${passing}` }).click();
      let dialog = target.getByRole("dialog", { name: "Terminal output" });
      await expect(dialog.getByText(`qa-validation-stdout-${run}`)).toBeVisible({
        timeout: 15_000,
      });
      await expect(dialog.getByText("passed", { exact: true })).toBeVisible();
      await target.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await target.getByRole("button", { name: `View terminal output for ${failing}` }).click();
      dialog = target.getByRole("dialog", { name: "Terminal output" });
      await expect(dialog.getByText(`qa-validation-stderr-${run}`)).toBeVisible({
        timeout: 15_000,
      });
      await expect(dialog.getByText("failed", { exact: true })).toBeVisible();
      await target.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    };

    await test.step("the Tests view reads each command's output from the container", async () => {
      await expectOutput(page);
    });

    await test.step("the output still loads after an environment switch", async () => {
      await selectEnvironment(page, localName);
      await expect(page.getByRole("tablist", { name: "Build pipeline" })).toHaveCount(0);
      await selectEnvironment(page, containerName);
      await expectOutput(page);
    });

    await test.step("a second window and a reload read the same output", async () => {
      const second = await openSecondWindow(page.context(), testInfo);
      await selectEnvironment(second, containerName);
      await expectOutput(second);
      await second.close();
      await reloadApp(page, testInfo);
      await selectEnvironment(page, containerName);
      await expectOutput(page);
    });
  } finally {
    await removeBuildTab().catch(() => undefined);
    await invoke("delete_build_pipeline", { pipelineId }).catch(() => undefined);
    inContainer(containerId, `rm -rf .orkestrator/review-artifacts/${validation.id}`);
  }
});

test("Docker fixture coordinator view follows delegations and context across switch, hidden document, reload and two windows", async ({
  page,
}, testInfo) => {
  test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");
  test.setTimeout(8 * 60_000);
  const container = await fixtureEnvironment(containerName);
  const local = await fixtureEnvironment(localName);
  expect(container.environmentType).toBe("containerized");
  const projects = await invoke<Project[]>("get_projects");
  const checkout = projects.find((project) => project.id === container.projectId)?.localPath;
  if (!checkout) throw new Error("The fixture project has no checkout");
  const run = randomUUID().slice(0, 8);
  const contextBranch = `qa-context-${run}`;
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
    return result.stdout.trim();
  };
  const originalBranch = git("branch", "--show-current");

  const snapshot = await invoke<CoordinatorSnapshot>("ensure_project_coordinator", {
    projectId: container.projectId,
  });
  expect(snapshot.workspace.lifecycleState).toBe("ready");
  const main = snapshot.workspace.conversations.find((item) => item.role === "main");
  if (!main) throw new Error("The coordinator has no main conversation");
  // An interrupted earlier run may have left delegations open on this
  // conversation; each closes with its environment, as these do.
  const openOn = (environmentId: string) =>
    snapshot.workflows.filter(
      (association) =>
        association.conversationId === main.id &&
        association.resourceId === environmentId &&
        association.delegation?.state === "running",
    ).length;
  const baselineContainer = openOn(container.id);
  const baseline = baselineContainer + openOn(local.id);
  const delegate = (environmentId: string, label: string) =>
    invoke<{ opened: boolean }>("open_coordinator_delegation", {
      scope: {
        projectId: container.projectId,
        coordinatorId: snapshot.workspace.id,
        conversationId: main.id,
      },
      environmentId,
      // A tab with no native session: its activity reads "unknown", so the
      // delegation stays open until its environment stops.
      tabId: `qa-worker-${label}-${run}`,
      requestId: `qa-${label}-${run}`,
    });

  const openCoordinator = async (target: Page) => {
    const projectRow = target.getByRole("button", { name: /^origin/ }).first();
    await expect(projectRow).toBeVisible({ timeout: 30_000 });
    await projectRow.click();
    const tab = target.getByRole("tab", { name: "Coordinator", exact: true });
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await tab.click();
    const panel = target.locator("#project-panel-coordinator");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText("Coordinator unavailable")).toHaveCount(0);
    // No provider was started for the main conversation.
    await expect(
      panel.getByRole("button", { name: "Coordinator, no agent chosen yet", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    return panel;
  };
  const awaiting = (panel: ReturnType<Page["locator"]>, count: number) =>
    count === 0
      ? expect(panel.locator("[data-awaiting-workers]")).toHaveCount(0, {
          timeout: DELEGATION_SWEEP_BUDGET_MS,
        })
      : expect(panel.locator("[data-awaiting-workers]")).toHaveAttribute(
          "data-awaiting-workers",
          String(count),
          { timeout: DELEGATION_SWEEP_BUDGET_MS },
        );

  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page, testInfo);
  try {
    let panel = await openCoordinator(page);
    if (baseline === 0) await awaiting(panel, 0);

    await test.step("a delegation opened while another environment is shown appears on return", async () => {
      await selectEnvironment(page, containerName);
      await expect(page.locator("#project-panel-coordinator")).toHaveCount(0);
      expect((await delegate(container.id, "container")).opened).toBe(true);
      await page.waitForTimeout(3_000);
      panel = await openCoordinator(page);
      await awaiting(panel, baseline + 1);
      await expect(panel.locator("[data-awaiting-workers]")).toHaveAttribute(
        "title",
        new RegExp(containerName),
      );
    });

    await test.step("a delegation opened while the document is hidden appears after return", async () => {
      await setDocumentHidden(page, true);
      expect((await delegate(local.id, "local")).opened).toBe(true);
      await page.waitForTimeout(6_000);
      // Event-driven reads wait while hidden.
      await expect(panel.locator("[data-awaiting-workers]")).toHaveAttribute(
        "data-awaiting-workers",
        String(baseline + 1),
      );
      const returned = Date.now();
      await setDocumentHidden(page, false);
      await awaiting(panel, baseline + 2);
      testInfo.annotations.push({
        type: "coordinator-hidden-return",
        description: `delegation shown ${Date.now() - returned} ms after the document became visible`,
      });
    });

    await test.step("a reload shows both delegations", async () => {
      await reloadApp(page, testInfo);
      panel = await openCoordinator(page);
      await awaiting(panel, baseline + 2);
    });

    const second = await openSecondWindow(page.context(), testInfo);
    const secondPanel = await openCoordinator(second);
    await test.step("a repository context change shows in both windows", async () => {
      await awaiting(secondPanel, baseline + 2);
      const before = (
        await invoke<CoordinatorSnapshot>("ensure_project_coordinator", {
          projectId: container.projectId,
        })
      ).workspace.repositoryContextRevision;
      git("checkout", "-q", "-b", contextBranch);
      await invoke("get_project_git_status", { projectId: container.projectId });
      for (const target of [panel, secondPanel]) {
        await expect(target.getByText(`Context r${before + 1}`, { exact: true })).toBeVisible({
          timeout: POLL_BUDGET_MS,
        });
        await expect(
          target.getByRole("status").filter({ hasText: "Repository context changed to" }),
        ).toHaveCount(0);
      }
    });

    await test.step("stopped workers' delegations close in both windows", async () => {
      // The second window watches from an environment while the sweep runs.
      await selectEnvironment(second, localName);
      await invoke("stop_environment", { environmentId: local.id });
      await waitForEnvironmentStatus(localName, "stopped");
      await awaiting(panel, baselineContainer + 1);
      await invoke("stop_environment", { environmentId: container.id });
      await waitForEnvironmentStatus(containerName, "stopped");
      await awaiting(panel, 0);
      const returnedPanel = await openCoordinator(second);
      await awaiting(returnedPanel, 0);
      await second.close();
    });
  } finally {
    if (git("branch", "--show-current") !== originalBranch) {
      git("checkout", "-q", originalBranch);
    }
    spawnSync("git", ["-C", checkout, "branch", "-q", "-D", contextBranch]);
    await invoke("get_project_git_status", { projectId: container.projectId }).catch(
      () => undefined,
    );
    for (const environment of [local, container]) {
      if ((await fixtureEnvironment(environment.name)).status !== "running") {
        await invoke("start_environment", { environmentId: environment.id });
      }
    }
    await waitForEnvironmentStatus(localName, "running");
    await waitForEnvironmentStatus(containerName, "running", 240_000);
  }
});

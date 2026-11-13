import { expect, test, type Page } from "./browser-test";
import { spawnSync } from "node:child_process";
import path from "node:path";

import type {
  McpManagementSnapshot,
  McpManagementTarget,
  McpMutationResult,
  McpOperationSnapshot,
  McpOverlayResolutionResult,
} from "@orkestrator/protocol/mcp-management";
import { containerProcesses } from "./container-terminal-processes";
import { terminalVisibleText } from "./terminal-visible-text";

/**
 * Saving an environment-private MCP server leaves a running container terminal
 * alone (to-do 0040 task 1, the terminal half of review gap 9).
 *
 * A container terminal runs a long command that prints a numbered line every
 * half second until the spec releases it. While it runs, the spec saves two
 * environment-private servers into the fixture container's Codex file: one
 * with "Save" and one with "Save and apply". The command must keep running
 * (same shell, same job process, the container not restarted), its output
 * must keep arriving after each save, and once released it must finish with
 * exit status 0 and every line in order. Each server is then checked in the
 * container's file and the overlay is reset, so the fixture is left as found.
 *
 * Driven through the backend's own commands against a profile started with
 * `--fixture-environments local,container`; no agent, no login and no
 * traffic from the container to the host. The report is content-free: counts
 * only. The command's lines are the spec's own markers, and whole-line
 * matches keep the echoed command (which holds `tick-$i`, never a number)
 * from passing as output.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const environmentName =
  process.env.ORKESTRATOR_AGENT_TEST_ROOT_TERMINAL_ENVIRONMENT ?? "fixture-container";

/** The job's own bound: about two minutes of ticks if the spec never releases it. */
const MAX_TICKS = 240;

type Status = { status: string; browserUrl: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Environment = { id: string; name: string; containerId?: string | null };

function profileCommand<T>(command: string): T {
  const result = spawnSync("mise", ["run", command, "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return JSON.parse(result.stdout) as T;
}

/** Signs the request client in without rendering the app (see `container-terminal-close.spec.ts`). */
async function login(page: Page, status: Status): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const { loginUrl } = profileCommand<{ loginUrl?: unknown }>("dev:login");
  if (typeof loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const request = page.context().request;
  const exchange = await request.get(loginUrl, { maxRedirects: 0 });
  expect(exchange.status(), "the login exchange was refused").toBeLessThan(400);
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await request.post(new URL("/__orkestrator/invoke", status.browserUrl).href, {
      data: { command, args },
      timeout: 120_000,
    });
    expect(response.ok(), `${command} failed`).toBe(true);
    return ((await response.json()) as { result: T }).result;
  };
}

/** `docker exec` as the image's `node` user; throws on a non-zero exit. */
function containerExec(containerId: string, script: string, args: string[] = []): string {
  const result = spawnSync(
    "docker",
    ["exec", "--user", "node", containerId, "sh", "-c", script, "sh", ...args],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) throw new Error("docker exec failed");
  return result.stdout;
}

function containerStartedAt(containerId: string): string {
  const result = spawnSync("docker", ["inspect", "-f", "{{.State.StartedAt}}", containerId], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0) throw new Error("docker inspect failed");
  return result.stdout.trim();
}

/** The numbers of the job's whole `tick-N` lines, in output order. */
function ticks(text: string): number[] {
  return text
    .split("\n")
    .map((line) => line.trim().match(/^tick-(\d+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => Number(match[1]));
}

const APPLY_SETTLING = new Set(["queued", "applying"]);

test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");

test("Docker fixture saving an environment-private MCP server leaves a running container terminal alone", async ({
  page,
}, testInfo) => {
  test.setTimeout(4 * 60_000);
  const status = profileCommand<Status>("dev:status");
  expect(status.status).toBe("ready");
  const invoke = await login(page, status);

  let environment: Environment | undefined;
  for (const project of await invoke<Array<{ id: string }>>("get_projects")) {
    environment = (await invoke<Environment[]>("get_environments", { projectId: project.id })).find(
      (entry) => entry.name === environmentName,
    );
    if (environment) break;
  }
  expect(environment?.containerId, `${environmentName} has no container`).toBeTruthy();
  const environmentId = environment!.id;
  const containerId = environment!.containerId!;

  const { targets } = await invoke<{ targets: McpManagementTarget[] }>(
    "list_mcp_management_targets",
    { environmentId },
  );
  const target = targets.find(
    (item) =>
      item.provider === "codex" &&
      item.context.kind === "environment" &&
      item.context.environmentId === environmentId,
  );
  expect(target, "the profile offers Codex (--agent-platforms includes codex)").toBeTruthy();
  const snapshot = () =>
    invoke<McpManagementSnapshot>("get_mcp_management_snapshot", { targetId: target!.targetId });
  const privateSource = async () => {
    const source = (await snapshot()).sources.find((item) => item.sourceId === "codex:user");
    expect(source?.owner, "the container's Codex file is environment-private").toBe(
      "environment-overlay",
    );
    expect(source?.writable, source?.readOnlyReason ?? "").toBe(true);
    return source!;
  };
  expect((await privateSource()).overlay, "the fixture starts with no saved changes").toBe(
    undefined,
  );

  const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const release = `/tmp/ork-mcp-terminal-${runId}`;
  const names = [`terminal_probe_${runId}_save`, `terminal_probe_${runId}_apply`];
  const startedAt = containerStartedAt(containerId);
  const shellsBefore = new Set(
    containerProcesses(containerId)
      .filter((entry) => entry.comm === "zsh")
      .map((entry) => entry.sid),
  );

  const { sessionId } = await invoke<{ sessionId: string }>("create_terminal_session", {
    containerId,
    environmentId,
    terminalKey: `mcp-overlay-terminal-${runId}`,
    cols: 160,
    rows: 40,
  });
  let saved = false;
  try {
    await invoke("start_terminal_session", { sessionId });
    const output = async () =>
      terminalVisibleText(
        (await invoke<{ output: string }>("get_terminal_output_snapshot", { sessionId })).output,
      );
    // The image's zsh prompt ends with ❯; wait for it so no input is lost.
    await expect
      .poll(async () => /[#$%>❯]\s*$/.test((await output()).trimEnd()), { timeout: 60_000 })
      .toBe(true);
    let session: number | undefined;
    await expect
      .poll(
        () => {
          const added = [
            ...new Set(
              containerProcesses(containerId)
                .filter((entry) => entry.comm === "zsh" && !shellsBefore.has(entry.sid))
                .map((entry) => entry.sid),
            ),
          ];
          session = added.length === 1 ? added[0] : undefined;
          return added.length;
        },
        { timeout: 15_000 },
      )
      .toBe(1);

    // One `sh` job that outlives every save: it ticks until the release file
    // exists, and exits 0 only when it was released rather than timed out.
    const job =
      `sh -c 'i=0; while [ ! -e "$1" ] && [ "$i" -lt ${MAX_TICKS} ]; do ` +
      `i=$((i+1)); echo "tick-$i"; sleep 0.5; done; [ -e "$1" ]' ork-job ${release}; ` +
      `echo "ork-exit-$?"`;
    await invoke("terminal_write", { sessionId, data: `${job}\r` });
    let jobPid: number | undefined;
    await expect
      .poll(
        () => {
          const jobs = containerProcesses(containerId).filter(
            (entry) => entry.sid === session && entry.comm === "sh",
          );
          jobPid = jobs.length === 1 ? jobs[0]!.pid : undefined;
          return jobs.length;
        },
        { timeout: 15_000 },
      )
      .toBe(1);
    const shellPid = session!;
    const latestTick = async () => Math.max(0, ...ticks(await output()));
    await expect.poll(latestTick, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

    const operations: McpOperationSnapshot[] = [];
    for (const [index, applyIntent] of (["save", "save-and-apply"] as const).entries()) {
      const source = await privateSource();
      const result = await invoke<McpMutationResult>("mutate_mcp_definition", {
        mutation: {
          requestId: `mcp-overlay-terminal-${runId}-${index}`,
          targetId: target!.targetId,
          applyIntent,
          operation: {
            kind: "add",
            sourceId: source.sourceId,
            expectedRevision: source.revision,
            definition: { name: names[index], transport: "stdio", command: "node" },
          },
        },
      });
      saved = true;
      expect(result.operation.phase, `${applyIntent} saved`).toBe("saved");
      let operation = result.operation;
      await expect
        .poll(
          async () => {
            operation = await invoke<McpOperationSnapshot>("get_mcp_operation", {
              operationId: result.operation.operationId,
            });
            return APPLY_SETTLING.has(operation.apply.state);
          },
          { timeout: 60_000 },
        )
        .toBe(false);
      operations.push(operation);

      // The job is the same process, its output still arrives, and the
      // container was not restarted under it.
      const before = await latestTick();
      await expect.poll(latestTick, { timeout: 15_000 }).toBeGreaterThanOrEqual(before + 2);
      expect(
        containerProcesses(containerId)
          .filter((entry) => entry.sid === shellPid)
          .map((entry) => entry.pid),
        `the shell and its job survive ${applyIntent}`,
      ).toEqual(expect.arrayContaining([shellPid, jobPid!]));
      expect(
        (await invoke<{ running: boolean }>("get_terminal_session", { sessionId })).running,
      ).toBe(true);
      expect(containerStartedAt(containerId), "the container was not restarted").toBe(startedAt);
      expect(await output(), "the job is still running").not.toMatch(/^ork-exit-\d+\s*$/m);
    }

    // Both servers reached the container's own file (server names only).
    // Compared in memory; a failure names the missing servers, never the file.
    const file = containerExec(containerId, "cat /home/node/.codex/config.toml");
    expect(names.filter((name) => !file.includes(`[mcp_servers.${name}]`))).toEqual([]);
    const overlay = (await privateSource()).overlay;
    expect(overlay?.state).toBe("in-sync");
    expect(overlay?.added.slice().sort()).toEqual(names.slice().sort());

    // Release the job: it finishes on its own, with every line in order.
    const ticksBeforeRelease = await latestTick();
    containerExec(containerId, ': > "$1"', [release]);
    await expect
      .poll(async () => (await output()).match(/^ork-exit-(\d+)\s*$/m)?.[1] ?? null, {
        timeout: 15_000,
      })
      .toBe("0");
    const final = await invoke<{ output: string; truncated: boolean }>(
      "get_terminal_output_snapshot",
      { sessionId },
    );
    expect(final.truncated, "the whole job output is retained").toBe(false);
    const all = ticks(terminalVisibleText(final.output));
    expect(all.length).toBeGreaterThanOrEqual(ticksBeforeRelease);
    expect(all, "no line was lost or repeated").toEqual(all.map((_, index) => index + 1));
    expect(all.length, "the job was released, not timed out").toBeLessThan(MAX_TICKS);
    expect(
      containerProcesses(containerId).some((entry) => entry.pid === jobPid),
      "the job exited",
    ).toBe(false);
    expect(
      (await invoke<{ running: boolean }>("get_terminal_session", { sessionId })).running,
      "the shell is still there after the job",
    ).toBe(true);

    await testInfo.attach("mcp-overlay-terminal.json", {
      body: JSON.stringify({
        ticks: all.length,
        saves: operations.length,
        applyStates: operations.map((operation) => operation.apply.state),
        containerRestarted: false,
      }),
      contentType: "application/json",
    });
  } finally {
    containerExec(containerId, 'rm -f "$1"', [release]);
    await invoke("detach_terminal", { sessionId }).catch(() => undefined);
    if (saved) {
      const source = (await snapshot()).sources.find((item) => item.sourceId === "codex:user");
      if (source?.overlay)
        await invoke<McpOverlayResolutionResult>("resolve_mcp_environment_overlay", {
          resolution: {
            targetId: target!.targetId,
            sourceId: source.sourceId,
            expectedRevision: source.revision,
            action: { kind: "reset" },
          },
        });
    }
  }
});

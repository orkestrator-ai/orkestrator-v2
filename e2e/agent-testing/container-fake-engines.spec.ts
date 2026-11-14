import { expect, test, type Page, type TestInfo } from "./browser-test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  containerName,
  fixtureEnvironment,
  inContainer,
  invoke,
  login,
  reloadApp,
  selectEnvironment,
  type Environment,
} from "./container-wiring-support";
import {
  ALLOWED_URL,
  BLOCKED_URL,
  PLATFORMS,
  approveFromCard,
  ask,
  curlCommand,
  entryDirectory,
  expectContainerPolicy,
  requireCellPlatform,
  restoreLayout,
  restoreRealBridge,
  saveSingleTabLayout,
  sendPrompt,
  tabSession,
  waitForPendingInteraction,
  waitForReply,
  type PaneLayout,
  type Platform,
} from "./container-engine-cells-support";

/**
 * Cursor and Pi cells of the Docker fixture (todo 0001, task 8): a native tab
 * on each platform in the fixture container, driven through the real backend,
 * the production container launch and the real bridge, with only the vendor
 * engine fake. No credential is read and no provider is called.
 *
 * The image's bridge entry (`/opt/<platform>-bridge/dist/index.js`) is
 * swapped, for the length of the case, for a bundle of the bridge's
 * `container-fake-engine-server.ts`: the same bridge code over Cursor's fake
 * SDK or Pi's faux model, resolving the SDK from the image's own
 * `node_modules`. `start_<platform>_server` then starts it exactly as it
 * starts the real one (port, token, state directory, log). The swap is
 * undone, and the bridge stopped, in `finally`; a rebuilt container never
 * has it.
 *
 * Each cell checks, from inside the container:
 * - the session reports the container policy (`interactive-container`,
 *   sandbox `container`, network `restricted`), and the bridge translated it
 *   for the vendor (Cursor: the SDK sandbox off, `/workspace` as its cwd);
 * - an off-allowlist request from where the agent runs is refused, while an
 *   allowlisted one (GitHub, always allowed) is not. Cursor's fake requests
 *   the URL from the bridge process, where the real SDK runs its tools; Pi's
 *   faux model calls Pi's own `bash` tool, which runs `curl` for real;
 * - Pi only: with the environment's approvals set to `ask`, the same tool
 *   call parks a card, and approving it from the card runs the command.
 *
 * Profile: `--fixture-environments local,container` with Cursor and Pi in
 * `--agent-platforms` (`mise run test:agent:docker:isolated` starts one).
 *
 * The opt-in variants on a real Cursor SDK and a real Pi provider are
 * `container-real-engines-live.spec.ts`; the steps both share are in
 * `container-engine-cells-support.ts`.
 */

// Backend calls carry the disposable profile's token; keep it out of artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

/** Builds the bridge's container fake entry the way the bridge's own build does. */
function bundleFakeBridge(platform: Platform): string {
  const { bridge, externals } = PLATFORMS[platform];
  const directory = mkdtempSync(path.join(tmpdir(), `orkestrator-qa-fake-${platform}-`));
  try {
    const outfile = path.join(directory, "index.js");
    const built = spawnSync(
      "bun",
      [
        "build",
        "src/testing/container-fake-engine-server.ts",
        "--target=bun",
        "--format=esm",
        ...externals.flatMap((name) => ["--external", name]),
        `--outfile=${outfile}`,
      ],
      { cwd: path.join(repositoryRoot, "bridges", bridge), encoding: "utf8" },
    );
    if (built.status !== 0) throw new Error(built.stderr || `${bridge} fake build failed`);
    return readFileSync(outfile, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Puts the fake where the image's entry is; keeps the real one beside it once. */
function installFakeBridge(containerId: string, platform: Platform, bundle: string) {
  const dist = entryDirectory(platform);
  inContainer(
    containerId,
    [
      "set -e",
      `[ -e ${dist}/index.js.qa-real ] || mv ${dist}/index.js ${dist}/index.js.qa-real`,
      `cat > ${dist}/index.js`,
      `chmod 644 ${dist}/index.js`,
    ].join("; "),
    { user: "root", input: bundle },
  );
}

async function openCell(
  page: Page,
  testInfo: TestInfo,
  platform: Platform,
  afterInstall?: (containerId: string) => Promise<void>,
): Promise<{ environment: Environment; containerId: string; cleanup: () => Promise<void> }> {
  await requireCellPlatform(platform);
  const environment = await fixtureEnvironment(containerName);
  const containerId = environment.containerId;
  if (!containerId) throw new Error(`${containerName} has no container`);
  const bundle = bundleFakeBridge(platform);
  const previousLayout = await invoke<PaneLayout | null>("get_pane_layout", {
    environmentId: environment.id,
  });
  const previousSettings =
    (await invoke<Environment & { agentSettings?: unknown }>("get_environment", {
      environmentId: environment.id,
    }).then((stored) => stored.agentSettings)) ?? null;
  const args = { containerId };
  // Register rollback before installation: even a partially written fake entry
  // must be restored if installation, navigation or login fails.
  const cleanup = async () => {
    try {
      await page.goto("about:blank").catch(() => undefined);
      await restoreLayout(environment, containerId, previousLayout);
      await invoke("update_environment_agent_settings", {
        environmentId: environment.id,
        agentSettings: previousSettings,
      });
    } finally {
      try {
        await invoke(`stop_${platform}_server`, args);
      } finally {
        restoreRealBridge(containerId, platform);
        await invoke(`stop_${platform}_server`, args);
      }
    }
  };
  // A real bridge left running by an earlier case would be reused as is.
  await invoke(`stop_${platform}_server`, args);
  try {
    installFakeBridge(containerId, platform, bundle);
    await afterInstall?.(containerId);
    await page.setViewportSize({ width: 1400, height: 900 });
    await login(page, testInfo);
    return { environment, containerId, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Cell setup and rollback failed");
    }
    throw error;
  }
}

for (const platform of ["cursor", "pi"] as const) {
  test(`Docker fixture ${platform} setup failure restores the bridge and permits reuse`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(4 * 60_000);
    await requireCellPlatform(platform);
    let original = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        openCell(page, testInfo, platform, async (containerId) => {
          const dist = entryDirectory(platform);
          const checksum = inContainer(containerId, `sha256sum ${dist}/index.js.qa-real`).split(
            " ",
          )[0]!;
          if (original) expect(checksum).toBe(original);
          original = checksum;
          await invoke(`start_${platform}_server`, { containerId });
          throw new Error("Injected post-install setup failure");
        }),
      ).rejects.toThrow("Injected post-install setup failure");
      const environment = await fixtureEnvironment(containerName);
      const containerId = environment.containerId!;
      const dist = entryDirectory(platform);
      expect(inContainer(containerId, `sha256sum ${dist}/index.js`).split(" ")[0]).toBe(original);
      expect(
        inContainer(containerId, `test ! -e ${dist}/index.js.qa-real && echo restored`),
      ).toContain("restored");
      // Read process command lines without signalling anything. The fake runs
      // at exactly the same entry path as the original bridge.
      const processes = inContainer(
        containerId,
        'for f in /proc/[0-9]*/cmdline; do cat "$f" 2>/dev/null; echo; done',
        { user: "root" },
      );
      expect(processes).not.toContain(`${dist}/index.js`);
    }
  });
}

test("Docker fixture Cursor cell runs the container bridge under the container policy and firewall", async ({
  page,
}, testInfo) => {
  test.setTimeout(6 * 60_000);
  const { environment, containerId, cleanup } = await openCell(page, testInfo, "cursor");
  try {
    const tabId = `cursor-cell-${Date.now()}`;
    await saveSingleTabLayout(environment, containerId, "cursor", tabId);
    await reloadApp(page, testInfo);
    await selectEnvironment(page, containerName);
    const { label, projection } = tabSession(environment, "cursor", tabId);

    await test.step("a turn runs in the container's bridge under the container policy", async () => {
      await ask(page, label, projection, "Hello from the container cell", (reply) =>
        reply.startsWith("Answer to: Hello from the container cell"),
      );
      expectContainerPolicy((await projection())?.policy, "auto-approve");
      // The vendor's truth, read inside the container: one agent, created by
      // the bridge with the container translation of the policy.
      const store = JSON.parse(
        inContainer(containerId, `cat ${PLATFORMS.cursor.fakeRoot}/store.json`),
      ) as {
        agents: Record<
          string,
          { name: string; options?: Record<string, unknown>; turns: Array<{ prompt: string }> }
        >;
      };
      const agents = Object.values(store.agents).filter((agent) => agent.turns.length > 0);
      expect(agents).toHaveLength(1);
      expect(agents[0]!.turns.map((turn) => turn.prompt)).toEqual([
        "Hello from the container cell",
      ]);
      expect(agents[0]!.options).toMatchObject({
        cwd: "/workspace",
        // The container is the boundary; Cursor's own sandbox stays off.
        sandboxOptions: { enabled: false },
        autoReview: false,
      });
    });

    await test.step("the bridge process is refused off the allowlist and reaches GitHub", async () => {
      const blocked = await ask(page, label, projection, `FETCH ${BLOCKED_URL}`, (reply) =>
        reply.startsWith(`Fetch ${BLOCKED_URL}:`),
      );
      expect(blocked).toMatch(/: failed \(.+\)$/);
      const allowed = await ask(page, label, projection, `FETCH ${ALLOWED_URL}`, (reply) =>
        reply.startsWith(`Fetch ${ALLOWED_URL}:`),
      );
      expect(allowed).toMatch(/: HTTP \d{3}$/);
    });
  } finally {
    await cleanup();
  }
});

/** One `curl` from Pi's bash tool; the reply carries its status and exit code. */
function curlPrompt(url: string): string {
  return `BASH: ${curlCommand(url)}`;
}

const toolResult = (reply: string) => reply.startsWith("Tool result:");

test("Docker fixture Pi cell runs the container bridge under the container policy, firewall and approvals", async ({
  page,
}, testInfo) => {
  test.setTimeout(8 * 60_000);
  const { environment, containerId, cleanup } = await openCell(page, testInfo, "pi");
  try {
    const firstTab = `pi-cell-${Date.now()}`;
    await saveSingleTabLayout(environment, containerId, "pi", firstTab);
    await reloadApp(page, testInfo);
    await selectEnvironment(page, containerName);
    const first = tabSession(environment, "pi", firstTab);

    await test.step("a turn runs in the container's bridge under the container policy", async () => {
      await ask(page, first.label, first.projection, "Hello from the container cell", (reply) =>
        reply.startsWith("Answer to: Hello from the container cell"),
      );
      expectContainerPolicy((await first.projection())?.policy, "auto-approve");
      // Pi's own session file and the faux model's call log are in the container.
      expect(inContainer(containerId, `cat ${PLATFORMS.pi.fakeRoot}/calls.jsonl`)).toContain(
        "Hello from the container cell",
      );
      expect(
        Number(
          inContainer(
            containerId,
            "find /home/node/.pi/agent/sessions -name '*.jsonl' | wc -l",
          ).trim(),
        ),
      ).toBeGreaterThan(0);
    });

    await test.step("Pi's bash tool is refused off the allowlist and reaches GitHub", async () => {
      const blocked = await ask(
        page,
        first.label,
        first.projection,
        curlPrompt(BLOCKED_URL),
        toolResult,
      );
      expect(blocked).toMatch(/http=000/);
      expect(blocked).toMatch(/exit=(?!0\b)\d+/);
      const allowed = await ask(
        page,
        first.label,
        first.projection,
        curlPrompt(ALLOWED_URL),
        toolResult,
      );
      expect(allowed).toMatch(/http=[1-5]\d\d/);
      expect(allowed).toMatch(/exit=0\b/);
    });

    await test.step("with approvals on ask, the call parks a card and approving runs it", async () => {
      await invoke("update_environment_agent_settings", {
        environmentId: environment.id,
        agentSettings: {
          executionPolicy: { approvals: "ask", sandbox: "container", networkAccess: "restricted" },
        },
      });
      // A new tab: the policy is fixed when a session is created.
      const askTab = `pi-cell-ask-${Date.now()}`;
      await saveSingleTabLayout(environment, containerId, "pi", askTab);
      await reloadApp(page, testInfo);
      await selectEnvironment(page, containerName);
      const asking = tabSession(environment, "pi", askTab);
      const marker = `/tmp/orkestrator-qa-pi-approved-${Date.now()}`;
      const previous = await sendPrompt(
        page,
        asking.label,
        asking.projection,
        `BASH: touch ${marker} && echo approved`,
      );
      const pending = await waitForPendingInteraction(
        asking.projection,
        "Pi never asked to run the command",
      );
      expectContainerPolicy((await asking.projection())?.policy, "ask");
      // Parked, not run: the gate holds the call inside the container.
      expect(inContainer(containerId, `test -e ${marker} && echo ran || echo held`).trim()).toBe(
        "held",
      );
      await approveFromCard(page, pending);
      const reply = await waitForReply(asking.label, asking.projection, previous, toolResult);
      expect(reply).toContain("approved");
      expect(inContainer(containerId, `test -e ${marker} && echo ran || echo held`).trim()).toBe(
        "ran",
      );
      inContainer(containerId, `rm -f ${marker}`);
    });
  } finally {
    await cleanup();
  }
});

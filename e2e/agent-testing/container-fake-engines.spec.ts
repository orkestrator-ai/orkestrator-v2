import { expect, test, type Page, type TestInfo } from "./browser-test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
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
import { hasNewCompletedReply, type RetentionMessage } from "./close-retention-replies";
import { approvalOption } from "./paused-interactions-live-support";

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
 */

// Backend calls carry the disposable profile's token; keep it out of artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

type Platform = "cursor" | "pi";
type Projection = {
  sessionId?: string;
  turn: { phase: string; error?: string };
  messages: RetentionMessage[];
  interactions: AgentInteractionRequest[];
  policy?: Record<string, unknown>;
} | null;
type PaneLayout = { revision?: number; [key: string]: unknown };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const TURN_TIMEOUT_MS = 90_000;
/** Not on any default allowlist. */
const BLOCKED_URL = "https://example.com/";
/** GitHub's published ranges are always allowed. */
const ALLOWED_URL = "https://api.github.com/zen";

const PLATFORMS: Record<
  Platform,
  { label: string; bridge: string; externals: string[]; fakeRoot: string }
> = {
  cursor: {
    label: "Cursor",
    bridge: "cursor-bridge",
    externals: ["@cursor/sdk"],
    fakeRoot: "/tmp/orkestrator-qa-fake-cursor",
  },
  pi: {
    label: "Pi",
    bridge: "pi-bridge",
    externals: [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
    ],
    fakeRoot: "/tmp/orkestrator-qa-fake-pi",
  },
};

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

function entryDirectory(platform: Platform) {
  return `/opt/${PLATFORMS[platform].bridge}/dist`;
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

function restoreRealBridge(containerId: string, platform: Platform) {
  const dist = entryDirectory(platform);
  inContainer(
    containerId,
    `if [ -e ${dist}/index.js.qa-real ]; then mv -f ${dist}/index.js.qa-real ${dist}/index.js; fi; ` +
      `rm -rf ${PLATFORMS[platform].fakeRoot}`,
    { user: "root" },
  );
}

async function enabledPlatforms(): Promise<string[] | undefined> {
  const config = await invoke<{ global?: { enabledAgentPlatforms?: string[] } }>(
    "get_config",
  ).catch(() => null);
  return config?.global?.enabledAgentPlatforms;
}

async function saveSingleTabLayout(
  environment: Environment,
  containerId: string,
  platform: Platform,
  tabId: string,
) {
  const current = await invoke<PaneLayout | null>("get_pane_layout", {
    environmentId: environment.id,
  });
  await invoke("save_pane_layout", {
    environmentId: environment.id,
    expectedRevision: current?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId,
      activePaneId: "pane-fake-engine",
      root: {
        kind: "leaf",
        id: "pane-fake-engine",
        activeTabId: tabId,
        tabs: [
          {
            id: tabId,
            type: "agent-native",
            displayTitle: `${PLATFORMS[platform].label} container cell`,
            nativeAgentData: { environmentId: environment.id, platform },
          },
        ],
      },
    },
  });
}

async function restoreLayout(
  environment: Environment,
  containerId: string,
  previous: PaneLayout | null,
) {
  const current = await invoke<PaneLayout | null>("get_pane_layout", {
    environmentId: environment.id,
  });
  const { revision: _revision, ...layout } = previous ?? {
    version: PANE_LAYOUT_VERSION,
    containerId,
    activePaneId: "pane-main",
    root: { kind: "leaf", id: "pane-main", tabs: [], activeTabId: null },
  };
  await invoke("save_pane_layout", {
    environmentId: environment.id,
    expectedRevision: current?.revision ?? 0,
    layout,
  });
}

function tabSession(environment: Environment, platform: Platform, tabId: string) {
  const label = PLATFORMS[platform].label;
  const projection = () =>
    invoke<Projection>("get_native_agent_projection", {
      environmentId: environment.id,
      agent: platform,
      logicalSessionKey: `env-${environment.id}:${tabId}`,
    });
  return { label, projection };
}

/** The composer of the only native tab on screen, as a user reaches it. */
async function sendPrompt(
  page: Page,
  label: string,
  projection: () => Promise<Projection>,
  prompt: string,
) {
  const composeBar = page.getByTestId("shared-native-compose-bar");
  const composer = composeBar.getByRole("textbox", { name: new RegExp(`^Message ${label}`) });
  const sendButton = composeBar.getByRole("button", { name: "Send", exact: true });
  await expect(composer).toBeVisible({ timeout: 90_000 });
  await composer.fill(prompt);
  await expect(sendButton).toBeEnabled({ timeout: 90_000 });
  const before = await projection();
  const previous = new Set((before?.messages ?? []).map((message) => message.id));
  const reached = async () =>
    ((await projection())?.messages ?? []).some(
      (message) =>
        message.role === "user" && !previous.has(message.id) && String(message.content) === prompt,
    );
  // Enter rather than a click: a development toast can cover the button.
  await composer.press("Enter");
  const sent = async () => (await composer.textContent())?.trim() === "" || (await reached());
  await expect
    .poll(sent, { timeout: 30_000 })
    .toBe(true)
    .catch(async () => {
      // The composer kept the draft and the session holds no such message, so
      // the send was refused before dispatch: nothing ran and resending cannot
      // run it twice. Record why, so a refusal is evidence rather than a retry
      // that hides it, then resend once as a user would.
      const shown = await page
        .getByRole("alert")
        .allTextContents()
        .catch(() => [] as string[]);
      const current = await projection();
      test.info().annotations.push({
        type: "send-refused",
        description: JSON.stringify({
          label,
          shown: shown.map((text) => text.trim()).filter(Boolean),
          phase: current?.turn.phase,
          error: current?.turn.error,
        }),
      });
      await expect(composer).toBeEditable({ timeout: 30_000 });
      await composer.press("Enter");
      await expect
        .poll(sent, { timeout: 30_000, message: `${label} refused the prompt twice` })
        .toBe(true);
    });
  return previous;
}

async function waitForReply(
  label: string,
  projection: () => Promise<Projection>,
  previous: ReadonlySet<string>,
  matches: (reply: string) => boolean,
): Promise<string> {
  let reply = "";
  await expect
    .poll(
      async () => {
        const current = await projection();
        if (current?.turn.phase === "error") {
          throw new Error(`${label} turn failed: ${current.turn.error ?? "no error"}`);
        }
        if (!hasNewCompletedReply(current, previous, matches)) return false;
        reply = String(
          current!.messages.findLast(
            (message) => message.role === "assistant" && !previous.has(message.id),
          )?.content ?? "",
        );
        return true;
      },
      { timeout: TURN_TIMEOUT_MS, message: `${label} never answered` },
    )
    .toBe(true);
  return reply;
}

async function ask(
  page: Page,
  label: string,
  projection: () => Promise<Projection>,
  prompt: string,
  matches: (reply: string) => boolean,
) {
  const previous = await sendPrompt(page, label, projection, prompt);
  return waitForReply(label, projection, previous, matches);
}

function expectContainerPolicy(policy: Record<string, unknown> | undefined, approvals: string) {
  expect(policy, "the session reports its execution policy").toMatchObject({
    id: "interactive-container",
    sandbox: "container",
    approvals,
    networkAccess: "restricted",
  });
}

async function openCell(
  page: Page,
  testInfo: TestInfo,
  platform: Platform,
  afterInstall?: (containerId: string) => Promise<void>,
): Promise<{ environment: Environment; containerId: string; cleanup: () => Promise<void> }> {
  test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");
  const enabled = await enabledPlatforms();
  test.skip(
    Array.isArray(enabled) && !enabled.includes(platform),
    `${PLATFORMS[platform].label} is not enabled in this profile (dev:test --agent-platforms)`,
  );
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
  return `BASH: curl -sS -m 10 -o /dev/null -w 'http=%{http_code}' ${url}; echo " exit=$?"`;
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
      let pending: AgentInteractionRequest | undefined;
      await expect
        .poll(
          async () => {
            const current = await asking.projection();
            pending = current?.interactions.find((request) => request.state === "pending");
            return pending?.kind;
          },
          { timeout: TURN_TIMEOUT_MS, message: "Pi never asked to run the command" },
        )
        .toBeTruthy();
      expectContainerPolicy((await asking.projection())?.policy, "ask");
      // Parked, not run: the gate holds the call inside the container.
      expect(inContainer(containerId, `test -e ${marker} && echo ran || echo held`).trim()).toBe(
        "held",
      );
      const allow = approvalOption(pending!.presentation.questions[0]);
      if (allow) {
        await page
          .getByRole("button", { name: new RegExp(`^${escapeRegExp(allow.label)}`) })
          .first()
          .click();
      }
      await page
        .getByRole("button", {
          name: pending!.presentation.confirmLabel ?? "Continue",
          exact: true,
        })
        .click();
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

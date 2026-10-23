import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

/**
 * Closing a native agent tab keeps the provider conversation, through the UI.
 *
 * For Cursor, Pi, OpenCode and Grok: complete a turn, close the tab with its
 * close button, open a new agent tab, find the conversation in the resume list
 * and resume it. The transcript must come back, and the next prompt must run
 * in the same vendor conversation: the engine sees the earlier prompt once and
 * the new one after it, with nothing duplicated or lost. A reload after the
 * close must not bring the tab back, and one after the resume must keep it.
 *
 * Everything below the page is real except each vendor engine: the backend
 * command registry and native agent service, the HTTP bridge provider and the
 * Cursor, Pi and ACP bridges, and the OpenCode provider. See
 * `fixtures/close-retention-host.ts`. Assertions about what a conversation
 * holds read each engine's own store, not the transcript the bridge serves.
 */

let host: ChildProcess;
let origin: string;

test.beforeAll(async ({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "desktop-chromium",
    "The flow is layout-independent; one viewport covers it",
  );
  test.setTimeout(90_000);
  host = spawn("bun", [path.join(import.meta.dirname, "fixtures/close-retention-host.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  origin = await new Promise<string>((resolve, reject) => {
    // Bounded diagnostic output; the host reads no credential.
    let error = "";
    const timeout = setTimeout(
      () => reject(new Error(`Close-retention host timed out: ${error}`)),
      60_000,
    );
    host.stderr!.on("data", (chunk) => {
      error = (error + String(chunk)).slice(-4_000);
    });
    host.once("error", reject);
    host.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`Close-retention host exited before readiness: ${error}`));
    });
    createInterface({ input: host.stdout! }).on("line", (line) => {
      if (!line.startsWith("CLOSE_RETENTION_HOST_READY:")) return;
      clearTimeout(timeout);
      resolve(`http://127.0.0.1:${line.split(":")[1]}`);
    });
  });
});

test.afterAll(async () => {
  if (!host || host.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    host.once("exit", () => resolve());
    host.kill("SIGTERM");
  });
});

test.beforeEach(async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.route("**/__close-retention/**", async (route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    const response = await request.fetch(
      `${origin}${url.pathname.replace("/__close-retention", "")}${url.search}`,
      {
        method: incoming.method(),
        headers: { "content-type": "application/json" },
        data: incoming.postData() ?? undefined,
        // Native agent views long-poll for their next update.
        timeout: 60_000,
      },
    );
    await route.fulfill({ response });
  });
});

// Native agent views keep a long poll open; one still in flight when the case
// ends must not fail it.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

type Platform = "cursor" | "pi" | "opencode" | "grok";
type Vendor = {
  cursor: Array<{ id: string; prompts: string[]; statuses: string[] }>;
  cursorSdk: string[];
  pi: { calls: string[][]; startup: string[]; abortedRequests: string[] };
  grok: { sessions: Array<{ id: string; prompts: string[] }>; events: string[] };
  opencode: {
    sessions: Array<{ id: string; prompts: string[]; replies: string[] }>;
    deleted: string[];
    aborted: string[];
  };
};

const LABELS: Record<Platform, string> = {
  cursor: "Cursor",
  pi: "Pi",
  opencode: "OpenCode",
  grok: "Grok",
};

async function vendor(request: APIRequestContext): Promise<Vendor> {
  return (await (await request.get(`${origin}/vendor`)).json()) as Vendor;
}

/** The prompts of every vendor conversation that ran a prompt containing `marker`. */
async function conversationsWith(
  request: APIRequestContext,
  platform: Platform,
  marker: string,
): Promise<string[][]> {
  const state = await vendor(request);
  const matching = (prompts: string[]) => prompts.some((prompt) => prompt.includes(marker));
  if (platform === "cursor") {
    return state.cursor.filter((agent) => matching(agent.prompts)).map((agent) => agent.prompts);
  }
  if (platform === "grok") {
    return state.grok.sessions.filter((s) => matching(s.prompts)).map((s) => s.prompts);
  }
  if (platform === "opencode") {
    return state.opencode.sessions.filter((s) => matching(s.prompts)).map((s) => s.prompts);
  }
  // Pi's model is given the whole conversation on every call, so the last call
  // that saw the marker is the conversation as the engine holds it.
  const calls = state.pi.calls.filter(matching);
  return calls.length > 0 ? [calls.at(-1)!] : [];
}

/** Every request the backend sent `platform`'s bridge, from index `since`. */
async function bridgeRequests(
  request: APIRequestContext,
  platform: Platform | "claude",
  since = 0,
): Promise<string[]> {
  const all = (await (await request.get(`${origin}/bridge-requests`)).json()) as Record<
    string,
    string[]
  >;
  return (all[platform] ?? []).slice(since);
}

type Environment = { environmentId: string; worktreePath: string };

async function openEnvironment(
  page: Page,
  request: APIRequestContext,
  platform: Platform | "claude",
  beforeOpen?: (environment: Environment) => Promise<void>,
): Promise<Environment> {
  const environment = (await (await request.post(`${origin}/environment`)).json()) as Environment;
  const { environmentId, worktreePath } = environment;
  await beforeOpen?.(environment);
  const search = new URLSearchParams({
    environment: environmentId,
    worktree: worktreePath,
    platform,
  });
  await page.goto(`/close-retention?${search}`);
  await expect(page.getByRole("button", { name: "New agent tab" })).toBeEnabled();
  return environment;
}

async function invoke<T>(
  request: APIRequestContext,
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await request.post(`${origin}/invoke`, { data: { command, args } });
  const body = (await response.json()) as { result?: T; error?: string };
  if (body.error !== undefined) throw new Error(`${command}: ${body.error}`);
  return body.result as T;
}

function composer(page: Page, platform: Platform) {
  return page.getByRole("textbox", { name: `Message ${LABELS[platform]}` });
}

async function send(page: Page, platform: Platform, prompt: string) {
  await composer(page, platform).fill(prompt);
  await composer(page, platform).press("Enter");
}

async function completeTurn(page: Page, platform: Platform, prompt: string) {
  await send(page, platform, prompt);
  await expect(page.getByText(`Answer to: ${prompt}`)).toBeVisible({ timeout: 30_000 });
}

/** Close the only tab with its own close button, as a user does. */
async function closeTab(page: Page, platform: Platform) {
  await page.getByRole("button", { name: /^Close / }).click();
  await expect(composer(page, platform)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Close / })).toHaveCount(0);
}

/** Open a new agent tab and resume the conversation whose row shows `prompt`. */
async function resumeInNewTab(page: Page, platform: Platform, prompt: string) {
  await page.getByRole("button", { name: "New agent tab" }).click();
  await page.getByRole("button", { name: "Resume Session" }).click();
  await page
    .getByRole("dialog", { name: "Resume a session" })
    .getByRole("button", { name: new RegExp(`^${LABELS[platform]}\\b.*Choose a previous session`) })
    .click();
  const picker = page.getByRole("dialog", { name: "Resume Session" });
  await picker.getByRole("button", { name: new RegExp(prompt) }).click();
  await expect(picker).toHaveCount(0);
}

/**
 * A tab opened only to resume creates no session of its own: the picker opens
 * first and the resume is the tab's first session. Before, every resume left
 * an empty conversation in OpenCode's and Grok's stores. `since` is the bridge
 * request count, and `openCodeBefore` the OpenCode session ids, from before
 * the new tab opened.
 */
async function expectNoSessionCreatedForResume(
  request: APIRequestContext,
  platform: Platform,
  since: number,
  openCodeBefore: ReadonlySet<string>,
) {
  if (platform === "opencode") {
    const state = await vendor(request);
    expect(state.opencode.sessions.filter((session) => !openCodeBefore.has(session.id))).toEqual(
      [],
    );
    return;
  }
  const sent = await bridgeRequests(request, platform, since);
  expect(sent, "the resume reached the bridge").toContain("POST /session/resume");
  expect(sent, "the new tab created no session").not.toContain("POST /session/create");
  expect(sent.filter((line) => line.endsWith("/close"))).toEqual([]);
}

/**
 * A tab that already had a session (its resume picker was dismissed, so it
 * started its own) has that session replaced by a resume; it must be closed,
 * not left running beside the resumed one (for Grok, an agent process per
 * resume). Arguments as for `expectNoSessionCreatedForResume`.
 */
async function expectReplacedSessionClosed(
  request: APIRequestContext,
  platform: Platform,
  since: number,
  openCodeBefore: ReadonlySet<string>,
) {
  if (platform === "opencode") {
    // OpenCode has no bridge. The replaced session is the one the new tab
    // created, which never ran a prompt; its retaining close aborts it.
    const created = (await vendor(request)).opencode.sessions.filter(
      (session) => !openCodeBefore.has(session.id),
    );
    expect(created.map((session) => session.prompts)).toEqual([[]]);
    await expect
      .poll(async () => (await vendor(request)).opencode.aborted)
      .toContain(created[0]!.id);
    expect((await vendor(request)).opencode.deleted).toEqual([]);
    return;
  }
  const sent = await bridgeRequests(request, platform, since);
  const createdAt = sent.indexOf("POST /session/create");
  const resumedAt = sent.indexOf("POST /session/resume");
  expect(createdAt, "the new tab created a session").toBeGreaterThanOrEqual(0);
  expect(resumedAt, "the resume followed the create").toBeGreaterThan(createdAt);
  const replaced = sent
    .slice(createdAt + 1, resumedAt)
    .map((line) => /^[A-Z]+ \/session\/([^/]+)/.exec(line)?.[1])
    .find((id) => id !== undefined);
  expect(replaced, "the created session was used before the resume").toBeTruthy();
  await expect
    .poll(() => bridgeRequests(request, platform, since))
    .toContain(`POST /session/${replaced}/close`);
}

function uniqueMarker(platform: Platform): string {
  return `${platform}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

for (const platform of ["cursor", "pi", "opencode", "grok"] as const) {
  const label = LABELS[platform];
  test(`a ${label} tab that started its own session closes it when a resume replaces it`, async ({
    page,
    request,
  }) => {
    const marker = uniqueMarker(platform);
    const first = `Remember the harbour ${marker}`;
    await openEnvironment(page, request, platform);
    await completeTurn(page, platform, first);
    await closeTab(page, platform);

    const requestsBefore = (await bridgeRequests(request, platform)).length;
    const openCodeBefore = new Set(
      (await vendor(request)).opencode.sessions.map((session) => session.id),
    );
    // Opened to resume, then the picker is dismissed: the tab starts its own.
    await page.getByRole("button", { name: "New agent tab" }).click();
    await page.getByRole("button", { name: "Resume Session" }).click();
    await page
      .getByRole("dialog", { name: "Resume a session" })
      .getByRole("button", { name: new RegExp(`^${label}\\b.*Choose a previous session`) })
      .click();
    const picker = page.getByRole("dialog", { name: "Resume Session" });
    await expect(picker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(composer(page, platform)).toBeVisible({ timeout: 30_000 });

    // Its empty transcript still offers a resume, which replaces that session.
    await page.getByRole("button", { name: "Resume Session" }).click();
    await picker.getByRole("button", { name: new RegExp(first) }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByText(`Answer to: ${first}`)).toHaveCount(1, { timeout: 30_000 });
    await expectReplacedSessionClosed(request, platform, requestsBefore, openCodeBefore);
  });
}

for (const platform of ["cursor", "pi", "opencode", "grok"] as const) {
  const label = LABELS[platform];
  test(`closing a ${label} tab keeps the conversation; resume restores it and the next prompt continues it`, async ({
    page,
    request,
  }) => {
    const marker = uniqueMarker(platform);
    const first = `Remember the lighthouse ${marker}`;
    const second = `What did I ask before ${marker}?`;
    const requestsBefore = (await bridgeRequests(request, platform)).length;
    await openEnvironment(page, request, platform);

    await completeTurn(page, platform, first);
    await expect.poll(() => conversationsWith(request, platform, marker)).toEqual([[first]]);

    await closeTab(page, platform);
    if (platform === "opencode") {
      // OpenCode has no bridge; its close goes through the provider, which
      // must never delete the session.
      expect((await vendor(request)).opencode.deleted).toEqual([]);
    } else {
      const sent = await bridgeRequests(request, platform, requestsBefore);
      const prompted = sent.find((line) => /^POST \/session\/[^/]+\/prompt$/.test(line));
      expect(prompted, "the first turn reached the bridge").toBeTruthy();
      const sessionId = prompted!.split("/")[2];
      await expect
        .poll(() => bridgeRequests(request, platform, requestsBefore))
        .toContain(`POST /session/${sessionId}/close`);
      if (platform === "grok") {
        // ACP's bridge id differs from the vendor's native conversation id.
        const nativeSession = (await vendor(request)).grok.sessions.find((session) =>
          session.prompts.includes(first),
        );
        expect(nativeSession, "the vendor retained the native session").toBeTruthy();
        await expect
          .poll(async () => (await vendor(request)).grok.events)
          .toContain(`session-close:${nativeSession!.id}`);
      }
    }
    // The closed tab stays closed across a reload.
    await page.reload();
    await expect(page.getByRole("button", { name: "New agent tab" })).toBeEnabled();
    await expect(page.getByRole("button", { name: /^Close / })).toHaveCount(0);

    const requestsBeforeResume = (await bridgeRequests(request, platform)).length;
    const openCodeBeforeResume = new Set(
      (await vendor(request)).opencode.sessions.map((session) => session.id),
    );
    await resumeInNewTab(page, platform, first);
    await expect(page.getByText(`Answer to: ${first}`)).toHaveCount(1, { timeout: 30_000 });
    await expectNoSessionCreatedForResume(
      request,
      platform,
      requestsBeforeResume,
      openCodeBeforeResume,
    );

    await completeTurn(page, platform, second);
    await expect
      .poll(() => conversationsWith(request, platform, marker))
      .toEqual([[first, second]]);

    // The resumed tab survives a reload with its whole conversation, and the
    // reload dispatches nothing.
    await page.reload();
    await expect(page.getByText(`Answer to: ${second}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`Answer to: ${first}`)).toHaveCount(1);
    expect(await conversationsWith(request, platform, marker)).toEqual([[first, second]]);
    // Nothing deleted the conversation on the way.
    if (platform !== "opencode") {
      expect(
        (await bridgeRequests(request, platform, requestsBefore)).filter((line) =>
          line.startsWith("DELETE "),
        ),
      ).toEqual([]);
    }
  });
}

/**
 * The same, with the tab closed while a turn is running: the close stops the
 * owned run, the tab stays closed across an inactive environment and a
 * reload, and the conversation is still resumable and continues. Pi's faux
 * model cannot hold a turn open, so Pi is left to the bridge's own
 * startup-cancel suites.
 */
const HELD = {
  cursor: (marker: string) => `HOLD ${marker}`,
  opencode: (marker: string) => `HOLD ${marker}`,
  // The Grok fake agent holds a turn for exactly this prompt and keeps no
  // record of it, since the turn never finishes.
  grok: () => "HOLD",
} as const;

for (const platform of ["cursor", "opencode", "grok"] as const) {
  const label = LABELS[platform];
  test(`closing a ${label} tab during a turn stops it and keeps the conversation`, async ({
    page,
    request,
  }) => {
    const marker = uniqueMarker(platform);
    const first = `Remember the lighthouse ${marker}`;
    const held = HELD[platform](marker);
    const after = `Carry on ${marker}`;
    const grokEventsBefore = (await vendor(request)).grok.events.length;
    await openEnvironment(page, request, platform);
    await completeTurn(page, platform, first);

    await send(page, platform, held);
    await expect(page.getByRole("button", { name: /^Stop/ })).toBeVisible({ timeout: 30_000 });
    await closeTab(page, platform);

    // The owned run was stopped by the close, not left running.
    if (platform === "cursor") {
      await expect
        .poll(async () => (await vendor(request)).cursor.find((a) => a.prompts.includes(first)))
        .toMatchObject({ prompts: [first, held], statuses: ["finished", "cancelled"] });
    } else if (platform === "grok") {
      await expect
        .poll(async () => (await vendor(request)).grok.events.slice(grokEventsBefore))
        .toContain("cancel");
    } else {
      await expect
        .poll(async () =>
          (await vendor(request)).opencode.sessions.find((s) => s.prompts.includes(first)),
        )
        .toMatchObject({ prompts: [first, held], replies: [`Answer to: ${first}`] });
    }

    // Away and back, then a reload: the tab does not come back.
    await page.getByRole("button", { name: "Switch environment" }).click();
    await page.getByRole("button", { name: "Return to environment" }).click();
    await expect(page.getByRole("button", { name: /^Close / })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "New agent tab" })).toBeEnabled();
    await expect(page.getByRole("button", { name: /^Close / })).toHaveCount(0);

    await resumeInNewTab(page, platform, first);
    await expect(page.getByText(`Answer to: ${first}`)).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
    await completeTurn(page, platform, after);
    const expected = platform === "grok" ? [first, after] : [first, held, after];
    await expect.poll(() => conversationsWith(request, platform, marker)).toEqual([expected]);
  });
}

test("closing a Grok tab with an approval pending in an inactive environment denies it, and no card comes back", async ({
  page,
  request,
}) => {
  const platform = "grok";
  const marker = uniqueMarker(platform);
  const first = `Remember the lighthouse ${marker}`;
  const eventsBefore = (await vendor(request)).grok.events.length;
  await openEnvironment(page, request, platform);
  await completeTurn(page, platform, first);

  // The fake agent parks a permission request, a question and a plan approval.
  // The interactive policy settles the permission itself; the question and the
  // plan wait for the user.
  const question = page.getByText("Which branch?");
  const plan = page.getByText("Approve Grok's plan", { exact: true });
  await send(page, platform, "ASK_ALL");
  await expect(question).toBeVisible({ timeout: 30_000 });
  await expect(plan).toBeVisible();
  await page.getByRole("button", { name: "Switch environment" }).click();
  await page.getByRole("button", { name: "Return to environment" }).click();
  await expect(question).toBeVisible({ timeout: 30_000 });
  await expect(plan).toBeVisible();

  await closeTab(page, platform);
  // The requests still waiting on the user were answered, as cancelled, by the
  // close, and none was answered twice.
  await expect
    .poll(async () =>
      (await vendor(request)).grok.events
        .slice(eventsBefore)
        .filter((event) => event.startsWith("reply:question:") || event.startsWith("reply:plan:"))
        .sort(),
    )
    .toEqual(['reply:plan:{"outcome":"cancelled"}', 'reply:question:{"outcome":"cancelled"}']);

  await page.reload();
  await expect(page.getByRole("button", { name: "New agent tab" })).toBeEnabled();
  await expect(question).toHaveCount(0);
  await resumeInNewTab(page, platform, first);
  await expect(page.getByText(`Answer to: ${first}`)).toHaveCount(1, { timeout: 30_000 });
  // The resumed conversation has nothing left to answer.
  await expect(question).toHaveCount(0);
  await expect(plan).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
});

// 1x1 transparent PNG: a harmless, valid image asset.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/**
 * An assigned Grok tab restores a saved image draft, including an
 * attachment-only one, across an inactive environment and two reloads. The
 * real-stack spec (`agent-testing/native-draft-attachments.spec.ts`) skips
 * this case while the Grok CLI cannot connect; here the bridge connects to the
 * fake agent, so the assigned composer always mounts.
 */
for (const text of ["keep this image", ""]) {
  test(`an assigned Grok tab restores a saved image draft${text ? "" : " (attachment only)"}`, async ({
    page,
    request,
  }) => {
    const imageName = "draft-image.png";
    let draftKey = "";
    await openEnvironment(page, request, "grok", async ({ environmentId, worktreePath }) => {
      mkdirSync(path.join(worktreePath, ".qa"), { recursive: true });
      const imagePath = path.join(worktreePath, ".qa", imageName);
      writeFileSync(imagePath, PNG);
      // The key the assigned composer of the fixture's first tab saves under.
      const sessionKey = `env-${environmentId}:agent-grok-first`;
      draftKey = `grok:${environmentId}:${encodeURIComponent(sessionKey)}`;
      await invoke(request, "save_compose_draft", {
        draftKey,
        ownerType: "environment",
        ownerId: environmentId,
        value: {
          text,
          mentions: [],
          attachments: [
            { id: `attachment-${environmentId}`, type: "image", name: imageName, path: imagePath },
          ],
        },
      });
    });
    const composeBar = page.getByTestId("shared-native-compose-bar");
    const chip = composeBar.getByRole("button", { name: `Remove ${imageName}` });
    const expectRestored = async () => {
      await expect(chip).toBeVisible({ timeout: 30_000 });
      await expect(composeBar.getByRole("textbox")).toHaveText(text);
      const stored = await invoke<{ value: { text?: string; attachments?: unknown[] } } | null>(
        request,
        "get_compose_draft",
        { draftKey },
      );
      expect(stored?.value.text ?? "").toBe(text);
      expect(stored?.value.attachments).toEqual([expect.objectContaining({ name: imageName })]);
    };

    await expectRestored();
    await page.getByRole("button", { name: "Switch environment" }).click();
    await page.getByRole("button", { name: "Return to environment" }).click();
    await expectRestored();
    for (let reload = 0; reload < 2; reload += 1) {
      await page.reload();
      await expectRestored();
    }
  });
}

/**
 * Closing a Cursor tab during a cold start: the first prompt is waiting on
 * `Agent.create` when the tab closes. The dispatch already in flight still
 * reaches the bridge after the close, and the bridge's permanent-close fence
 * must refuse it, so the agent that finally starts is disposed without ever
 * being sent the prompt. The close completes (no teardown intent is left
 * pending), and the tab stays closed across an inactive environment and a
 * reload.
 */
test("closing a Cursor tab while its agent is still starting does no late work, and the tab stays closed", async ({
  page,
  request,
}) => {
  const platform = "cursor";
  const marker = uniqueMarker(platform);
  const sdkBefore = (await vendor(request)).cursorSdk.length;
  const { environmentId } = await openEnvironment(page, request, platform);
  await request.post(`${origin}/cursor-create-gate`, { data: { held: true } });
  try {
    await send(page, platform, `Cold start ${marker}`);
    // The bridge is now inside `Agent.create`, which has not returned.
    await expect
      .poll(async () => (await bridgeRequests(request, platform)).at(-1))
      .toMatch(/^POST \/session\/[^/]+\/attach$/);
    await closeTab(page, platform);
    await expect
      .poll(async () => (await bridgeRequests(request, platform)).at(-1))
      .toMatch(/^POST \/session\/[^/]+\/(close|prompt)$/);
  } finally {
    await request.post(`${origin}/cursor-create-gate`, { data: { held: false } });
  }
  // The agent that started late was disposed and never sent anything.
  await expect
    .poll(async () => (await vendor(request)).cursorSdk.slice(sdkBefore))
    .toEqual([expect.stringMatching(/^create:/), expect.stringMatching(/^dispose:/)]);
  expect(await conversationsWith(request, platform, marker)).toEqual([]);
  // The close was confirmed rather than left pending for a retry.
  await expect
    .poll(async () => {
      const environment = await invoke<{ tabTeardownIntents?: unknown[] }>(
        request,
        "get_environment",
        { environmentId },
      );
      return environment.tabTeardownIntents ?? [];
    })
    .toEqual([]);

  await page.getByRole("button", { name: "Switch environment" }).click();
  await page.getByRole("button", { name: "Return to environment" }).click();
  await expect(page.getByRole("button", { name: /^Close / })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "New agent tab" })).toBeEnabled();
  await expect(page.getByRole("button", { name: /^Close / })).toHaveCount(0);
  expect((await vendor(request)).cursorSdk.slice(sdkBefore)).toHaveLength(2);
});

test("closing a Claude tab on a bridge from before the close route keeps the conversation and asks for a restart", async ({
  page,
  request,
}) => {
  // The host's Claude bridge answers 404 to `POST /session/:id/close`, as every
  // Claude bridge did before the route existed. Its legacy DELETE deletes the
  // conversation, so the backend must never fall back to it.
  const tabId = "agent-claude-first";
  const providerSessionId = `claude-${uniqueMarker("cursor")}`;
  const requestsBefore = (await bridgeRequests(request, "claude")).length;
  const { environmentId } = await openEnvironment(page, request, "claude", async (environment) => {
    // A tab an earlier run of this backend had mapped to its Claude session.
    await request.post(`${origin}/seed-native-session`, {
      data: { environmentId: environment.environmentId, agent: "claude", tabId, providerSessionId },
    });
  });
  const pendingCloses = async () =>
    Object.keys(
      (
        await invoke<{ tabTeardownIntents?: Record<string, unknown> }>(request, "get_environment", {
          environmentId,
        })
      ).tabTeardownIntents ?? {},
    );

  await page.getByRole("button", { name: /^Close / }).click();
  await expect(page.getByText("Restart the environment to finish closing this tab")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/The conversation was kept/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Close / })).toHaveCount(0);

  const sent = await bridgeRequests(request, "claude", requestsBefore);
  expect(sent).toContain(`POST /session/${providerSessionId}/close`);
  expect(sent.filter((line) => line.startsWith("DELETE"))).toEqual([]);
  // The close stays journaled for after the restart.
  expect(await pendingCloses()).toEqual([tabId]);

  // The sweep retries it against the same old bridge: still no DELETE, still
  // pending, and the tab stays closed across a reload.
  await invoke(request, "reconcile_tab_teardowns", {});
  expect(
    (await bridgeRequests(request, "claude", requestsBefore)).filter((line) =>
      line.startsWith("DELETE"),
    ),
  ).toEqual([]);
  expect(await pendingCloses()).toEqual([tabId]);
  await page.reload();
  await expect(page.getByRole("button", { name: "New agent tab" })).toBeEnabled();
  await expect(page.getByRole("button", { name: /^Close / })).toHaveCount(0);
});

test("steering a Cursor turn whose steer history is full is refused, the turn carries on and the draft survives", async ({
  page,
  request,
}) => {
  const platform = "cursor";
  const marker = uniqueMarker(platform);
  const held = `HOLD the harbour ${marker}`;
  const instruction = `/steer turn left at the lighthouse ${marker}`;
  const requestsBefore = (await bridgeRequests(request, platform)).length;
  await openEnvironment(page, request, platform);
  await send(page, platform, held);
  await expect(page.getByRole("button", { name: /^Stop/ })).toBeVisible({ timeout: 30_000 });

  const prompted = (await bridgeRequests(request, platform, requestsBefore)).find((line) =>
    /^POST \/session\/[^/]+\/prompt$/.test(line),
  );
  expect(prompted, "the held turn reached the bridge").toBeTruthy();
  const sessionId = decodeURIComponent(prompted!.split("/")[2]!);
  // Fill the running turn's steer history straight at the bridge, as a long
  // turn steered many times would have.
  const filled = (await (
    await request.post(`${origin}/cursor-saturate-steer`, { data: { sessionId } })
  ).json()) as { delivered?: number; refused?: string; error?: string };
  expect(filled.error).toBeUndefined();
  expect(filled.refused).toBe("steer-capacity-exceeded");

  // The runtime panel says steering is full and the turn keeps running.
  await page.getByRole("button", { name: "Open agent information" }).click();
  await expect(page.getByTestId("agent-runtime-steer-saturated")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Steering is full for this turn")).toBeVisible();
  await page.keyboard.press("Escape");

  // A steer from the composer is refused with the bridge's reason, the
  // instruction stays in the composer, and the turn is still running.
  await composer(page, platform).fill(instruction);
  await composer(page, platform).press("Enter");
  await expect(page.getByText(/reached its steering limit/)).toBeVisible({ timeout: 30_000 });
  await expect(composer(page, platform)).toHaveText(instruction);
  await expect(page.getByRole("button", { name: /^Stop/ })).toBeVisible();
  expect(
    (await vendor(request)).cursor.find((agent) => agent.prompts.includes(held))?.statuses,
  ).toEqual(["running"]);

  // The draft survives leaving the environment and a reload.
  await page.getByRole("button", { name: "Switch environment" }).click();
  await page.getByRole("button", { name: "Return to environment" }).click();
  await expect(composer(page, platform)).toHaveText(instruction, { timeout: 30_000 });
  await page.reload();
  await expect(composer(page, platform)).toHaveText(instruction, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: /^Stop/ })).toBeVisible();

  // Stopping the turn ends it as cancelled; nothing it was steered with was lost.
  await page.getByRole("button", { name: /^Stop/ }).click();
  await expect
    .poll(
      async () =>
        (await vendor(request)).cursor.find((agent) => agent.prompts.includes(held))?.statuses,
    )
    .toEqual(["cancelled"]);
});

test("a Grok card whose bridge restarted while the environment was inactive is withdrawn, and stays gone after close and reload", async ({
  page,
  request,
}) => {
  const platform = "grok";
  const marker = uniqueMarker(platform);
  const first = `Remember the lighthouse ${marker}`;
  await openEnvironment(page, request, platform);
  await completeTurn(page, platform, first);
  const question = page.getByText("Which branch?");
  const plan = page.getByText("Approve Grok's plan", { exact: true });
  await send(page, platform, "ASK_ALL");
  await expect(question).toBeVisible({ timeout: 30_000 });
  await expect(plan).toBeVisible();
  const eventsBefore = (await vendor(request)).grok.events.length;

  // Away, the bridge restarts: the agent process holding the requests is gone,
  // and with it the generation that could answer them.
  await page.getByRole("button", { name: "Switch environment" }).click();
  const restarted = await request.post(`${origin}/restart-bridge`, { data: { platform } });
  expect(restarted.ok()).toBe(true);
  await page.getByRole("button", { name: "Return to environment" }).click();
  await expect(question).toHaveCount(0, { timeout: 30_000 });
  await expect(plan).toHaveCount(0);

  await closeTab(page, platform);
  await page.reload();
  await expect(page.getByRole("button", { name: "New agent tab" })).toBeEnabled();
  await expect(question).toHaveCount(0);
  await resumeInNewTab(page, platform, first);
  await expect(page.getByText(`Answer to: ${first}`)).toHaveCount(1, { timeout: 30_000 });
  await expect(question).toHaveCount(0);
  await expect(plan).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  // Nothing answered the dead requests on the new process's behalf.
  expect(
    (await vendor(request)).grok.events
      .slice(eventsBefore)
      .filter((event) => event.startsWith("reply:question:") || event.startsWith("reply:plan:")),
  ).toEqual([]);
});

test("a Cursor transcript shed from persistence comes back truncated after a bridge restart, on the same conversation", async ({
  page,
  request,
}) => {
  const platform = "cursor";
  const marker = uniqueMarker(platform);
  const turns = [1, 2, 3].map((index) => `Turn ${index} of the harbour log ${marker}`);
  const next = `Turn 4 of the harbour log ${marker}`;
  await openEnvironment(page, request, platform);
  for (const turn of turns) await completeTurn(page, platform, turn);

  const restarted = (await (
    await request.post(`${origin}/restart-bridge`, { data: { platform, shed: true } })
  ).json()) as { shed?: number; error?: string };
  expect(restarted.error).toBeUndefined();
  expect(restarted.shed).toBeGreaterThan(0);

  await page.reload();
  // Only the newest message survived the shed: it is shown, the start of the
  // conversation is not, and the view says so instead of passing the rest off
  // as the whole conversation.
  await expect(page.getByText(`Answer to: ${turns[2]}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`Answer to: ${turns[0]}`)).toHaveCount(0);
  await expect(
    page.getByText("Earlier messages in this conversation are not available here."),
  ).toBeVisible();

  // Same provider conversation, working controls: the next prompt runs in the
  // same Cursor agent, after the turns the shed copy no longer shows.
  await completeTurn(page, platform, next);
  await expect.poll(() => conversationsWith(request, platform, marker)).toEqual([[...turns, next]]);
});

test("stopping a Pi prompt before Pi accepts it stops the turn, across a switch away and a reload, and the next prompt runs", async ({
  page,
  request,
}) => {
  const platform = "pi";
  const marker = uniqueMarker(platform);
  const first = `Remember the lighthouse ${marker}`;
  const held = `Held in preflight ${marker}`;
  const after = `Carry on ${marker}`;
  await openEnvironment(page, request, platform);
  await completeTurn(page, platform, first);

  const startupBefore = (await vendor(request)).pi.startup.length;
  await request.post(`${origin}/pi-startup-gate`, { data: { held: true } });
  try {
    await send(page, platform, held);
    // Pi is now in its preflight for this prompt and has not accepted it.
    await expect
      .poll(async () => (await vendor(request)).pi.startup.slice(startupBefore))
      .toEqual(["held"]);
    await page.getByRole("button", { name: /^Stop/ }).click();
    await page.getByRole("button", { name: "Switch environment" }).click();
    await page.getByRole("button", { name: "Return to environment" }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "New agent tab" })).toBeEnabled();
  } finally {
    await request.post(`${origin}/pi-startup-gate`, { data: { held: false } });
  }

  // The stop held: the turn settles without an answer, any request Pi made
  // for the held prompt was already aborted (a real provider sends nothing),
  // and nothing is left waiting on an answer.
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0, { timeout: 30_000 });
  await expect(composer(page, platform)).toBeEditable();
  await expect(page.getByText(`Answer to: ${held}`)).toHaveCount(0);
  const piState = (await vendor(request)).pi;
  const heldRequests = piState.calls.filter((call) => call.at(-1) === held).length;
  expect(piState.abortedRequests.filter((prompt) => prompt === held)).toHaveLength(heldRequests);
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deny" })).toHaveCount(0);

  await completeTurn(page, platform, after);
  const conversation = (await conversationsWith(request, platform, marker))[0] ?? [];
  expect(conversation[0]).toBe(first);
  expect(conversation.at(-1)).toBe(after);
});

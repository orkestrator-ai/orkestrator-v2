/**
 * Real-stack web annotations through the browser gateway of an isolated
 * `dev:test` profile (run by `mise run test:agent:browser:isolated`).
 *
 * Browser clients cannot capture (native capture is desktop-only and is
 * covered by `web-annotations-electron.spec.ts`), so these tests build a
 * synthetic capture from the fixture page as rendered by real Chromium and
 * exercise what every client shares: two-client batch reservation races,
 * request bounds, queue holds, cancellation, and reload rehydration.
 *
 * The live implementation test is opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1`)
 * and requires a profile started with agent credentials; otherwise it is
 * reported as skipped, never as passed.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  WEB_ANNOTATION_COMMANDS as C,
  WEB_ANNOTATION_LIMITS,
  type WebAnnotationCaptureInput,
  type WebAnnotationDestination,
  type WebAnnotationRequest,
} from "@orkestrator/protocol/web-annotations";
import { reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import {
  EXPECTED_SOURCE_CHANGE,
  FIXTURE_VIEWPORT,
  ROUTE_VARIANTS,
  TEST_IDS,
  startFixtureServer,
  type FixtureServer,
} from "./web-annotations-support";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS === "1";
const LIVE_AGENT = (process.env.ORKESTRATOR_AGENT_TEST_ANNOTATION_AGENT ??
  "codex") as WebAnnotationDestination["agent"];

type Status = { status: string; browserUrl?: string; testProject?: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Preparation = {
  preparationId: string;
  bodyHash: string;
  sendable: boolean;
  briefBytes: number;
};

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error("dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

/** One authenticated client: its own browser context and single-use login. */
async function client(browser: Browser, status: Status): Promise<{ page: Page; invoke: Invoke }> {
  const login = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (login.status !== 0) throw new Error("dev:login failed");
  const { loginUrl } = JSON.parse(login.stdout) as { loginUrl: string };
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
  const invoke: Invoke = async (command, args = {}) => {
    const result = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      {
        data: { command, args },
      },
    );
    const text = await result.text();
    if (!result.ok()) throw new Error(`${command}: ${text.slice(0, 500)}`);
    return (JSON.parse(text) as { result: never }).result;
  };
  return { page, invoke };
}

/**
 * A capture built from the element as real Chromium renders it. Synthetic by
 * construction (a browser client has no trusted capture), but its geometry,
 * text, and page identity come from the served fixture.
 */
async function captureFrom(
  page: Page,
  fixture: FixtureServer,
  route: string,
  selector: string,
): Promise<WebAnnotationCaptureInput> {
  await page.setViewportSize(FIXTURE_VIEWPORT);
  await page.goto(`${fixture.url}${route}`);
  const element = await page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        text: (node.textContent ?? "").trim().slice(0, 300),
        tagName: node.tagName.toLowerCase(),
        testId: node.getAttribute("data-testid"),
        title: document.title,
      };
    });
  return {
    producer: "desktop-native",
    capturedAt: new Date().toISOString(),
    documentGeneration: 1,
    page: {
      service: { kind: "port", port: fixture.port },
      route,
      displayUrl: `${fixture.url}${route}`,
      title: element.title,
      requiresNavigation: false,
    },
    target: {
      kind: "element",
      label: `${element.tagName} “${element.text.slice(0, 60)}”`,
      anchor: {
        ...(element.testId
          ? { stableId: { kind: "test-id" as const, value: element.testId } }
          : {}),
        semantic: {
          tagName: element.tagName,
          role: null,
          name: element.text.slice(0, 100) || null,
        },
        text: { exact: element.text.slice(0, 200), prefix: "", suffix: "" },
        ancestors: [],
        cssPath: selector,
        scope: { kind: "document" },
      },
      rect: element.rect,
    },
    geometry: {
      viewport: FIXTURE_VIEWPORT,
      scroll: { x: 0, y: 0 },
      zoomFactor: 1,
      devicePixelRatio: 1,
      image: null,
    },
    evidence: {
      text: element.text.slice(0, 4_000),
      attributes: element.testId ? { "data-testid": element.testId } : {},
      styles: {},
      hierarchy: [],
      html: `<${element.tagName}>${element.text.slice(0, 200)}</${element.tagName}>`,
    },
    assetIds: [],
    redaction: {
      attributesRemoved: 0,
      valuesMasked: 0,
      urlParametersRemoved: 0,
      sensitiveRegionsMasked: 0,
      manualRegions: 0,
      imageExcluded: false,
    },
  } as WebAnnotationCaptureInput;
}

interface Setup {
  invoke: Invoke;
  environmentId: string;
  worktreePath: string;
  destination: WebAnnotationDestination;
  fixture: FixtureServer;
  cleanup(): Promise<void>;
}

async function setUp(
  browser: Browser,
  status: Status,
  name: string,
  agent: WebAnnotationDestination["agent"],
  options: { holdQueue: boolean },
): Promise<Setup & { page: Page }> {
  const { page, invoke } = await client(browser, status);
  const projects = await invoke<Array<{ id: string; localPath: string | null }>>("get_projects");
  const project = projects.find((candidate) => candidate.localPath === status.testProject);
  expect(project).toBeTruthy();
  const environment = await invoke<{ id: string }>("create_environment", {
    projectId: project!.id,
    name: `${name}-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  const environmentId = environment.id;
  let fixture: FixtureServer | null = null;
  const draftKeys: string[] = [];
  const cleanup = async () => {
    for (const key of draftKeys)
      await invoke("delete_compose_draft", { draftKey: key }).catch(() => undefined);
    await fixture?.stop().catch(() => undefined);
    await invoke("stop_environment", { environmentId }).catch(() => undefined);
    await invoke("delete_environment", { environmentId }).catch(() => undefined);
  };
  try {
    await invoke("start_environment", { environmentId });
    const hydrated = await invoke<{ worktreePath: string | null }>("get_environment", {
      environmentId,
    });
    expect(hydrated.worktreePath).toBeTruthy();
    const [port] = await reserveLoopbackPorts(1);
    fixture = await startFixtureServer(hydrated.worktreePath!, port!);
    const tabId = `annotation-${agent}`;
    const layout = await invoke<{ revision?: number } | null>("get_pane_layout", { environmentId });
    await invoke("save_pane_layout", {
      environmentId,
      expectedRevision: layout?.revision ?? 0,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane-annotations",
        root: {
          kind: "leaf",
          id: "pane-annotations",
          tabs: [
            {
              id: tabId,
              type: "agent-native",
              nativeAgentData: { environmentId, platform: agent },
            },
          ],
          activeTabId: tabId,
        },
      },
    });
    const { options: destinations } = await invoke<{
      options: Array<{ destination: WebAnnotationDestination; holds: string[] }>;
    }>(C.destinations, { environmentId });
    const option = destinations.find((candidate) => candidate.destination.tabId === tabId);
    if (!option)
      throw new Error(`${agent} is not an enabled annotation destination in this profile`);
    if (options.holdQueue) {
      // An unsent chat draft holds the destination queue, so nothing reaches
      // a provider: sends are durable and observable but never executed.
      const draftKey = `${agent}:${environmentId}:${encodeURIComponent(option.destination.logicalSessionKey)}`;
      await invoke("save_compose_draft", {
        draftKey,
        ownerType: "environment",
        ownerId: environmentId,
        value: { text: "Held by the annotation suite", mentions: [], attachments: [] },
      });
      draftKeys.push(draftKey);
      const { options: held } = await invoke<{
        options: Array<{ destination: WebAnnotationDestination; holds: string[] }>;
      }>(C.destinations, { environmentId });
      expect(held.find((candidate) => candidate.destination.tabId === tabId)?.holds).toContain(
        "compose-draft",
      );
    }
    return {
      page,
      invoke,
      environmentId,
      worktreePath: hydrated.worktreePath!,
      destination: option.destination,
      fixture,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function createNote(
  setup: Setup,
  page: Page,
  selector: string,
  body: string,
  route = ROUTE_VARIANTS.pricing,
) {
  const capture = await captureFrom(page, setup.fixture, route, selector);
  return setup.invoke<{ annotationId: string }>(C.create, {
    environmentId: setup.environmentId,
    operationId: `op-${Math.random().toString(36).slice(2)}`,
    capture,
    body,
  });
}

async function prepare(
  invoke: Invoke,
  setup: Setup,
  annotationIds: string[],
  operation: "implement" | "discuss" = "implement",
  instruction = "",
) {
  const annotations = [];
  for (const annotationId of annotationIds) {
    const { annotation } = await invoke<{
      annotation: { contentRevision: number; currentCaptureId: string };
    }>(C.get, { environmentId: setup.environmentId, annotationId });
    annotations.push({
      annotationId,
      expectedContentRevision: annotation.contentRevision,
      expectedCaptureId: annotation.currentCaptureId,
    });
  }
  return invoke<Preparation>(C.requestPrepare, {
    environmentId: setup.environmentId,
    operation,
    destination: setup.destination,
    annotations,
    instruction,
  });
}

async function activeRequest(invoke: Invoke, setup: Setup, annotationId: string) {
  const { annotation } = await invoke<{ annotation: { activeRequestId: string | null } }>(C.get, {
    environmentId: setup.environmentId,
    annotationId,
  });
  return annotation.activeRequestId;
}

async function getRequest(invoke: Invoke, setup: Setup, requestId: string) {
  const result = await invoke<{ request: WebAnnotationRequest } | WebAnnotationRequest>(
    C.requestGet,
    { environmentId: setup.environmentId, requestId },
  );
  return "request" in result ? result.request : result;
}

test.use({ actionTimeout: 15_000 });

test("overlapping batches from two clients reserve all-or-none and survive reload", async ({
  browser,
}, testInfo) => {
  testInfo.setTimeout(180_000);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const first = await setUp(browser, status, "annotation-batch", "codex", { holdQueue: true });
  try {
    const second = await client(browser, status);
    const cards = ["starter", "team", "enterprise"];
    const ids: string[] = [];
    for (const plan of cards) {
      const receipt = await createNote(
        first,
        first.page,
        `[data-testid="plan-cta-${plan}"]`,
        `Adjust the ${plan} button.`,
      );
      ids.push(receipt.annotationId);
    }
    const [a, b, c] = ids as [string, string, string];

    // Two clients prepare overlapping batches, then send at the same time.
    const batchOne = await prepare(first.invoke, first, [a, b]);
    const batchTwo = await prepare(second.invoke, first, [b, c]);
    expect(batchOne.sendable && batchTwo.sendable).toBe(true);
    const outcomes = await Promise.allSettled([
      first.invoke<{ request: WebAnnotationRequest }>(C.requestSend, {
        environmentId: first.environmentId,
        preparationId: batchOne.preparationId,
        requestId: `req-one-${Date.now()}`,
        bodyHash: batchOne.bodyHash,
      }),
      second.invoke<{ request: WebAnnotationRequest }>(C.requestSend, {
        environmentId: first.environmentId,
        preparationId: batchTwo.preparationId,
        requestId: `req-two-${Date.now()}`,
        bodyHash: batchTwo.bodyHash,
      }),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ request: WebAnnotationRequest }>).value
      .request;
    const winnerIds = winner.selections.map((selection) => selection.annotationId);
    const loserOnly = winnerIds.includes(a) ? c : a;
    testInfo.annotations.push({
      type: "batch-race",
      description: `winner=${winnerIds.length} annotations`,
    });
    for (const id of winnerIds)
      expect(await activeRequest(first.invoke, first, id)).toBe(winner.id);
    // The losing batch reserved nothing, not even its non-overlapping note.
    expect(await activeRequest(first.invoke, first, loserOnly)).toBeNull();

    // Held behind the unsent chat draft. The hold reason is written by the
    // backend reconciler, not by the send, so poll for it; then it must
    // survive a reload unchanged.
    await expect
      .poll(
        async () => {
          const request = await getRequest(first.invoke, first, winner.id);
          return `${request.state}/${request.blockedReason}`;
        },
        { timeout: 30_000 },
      )
      .toBe("queued/compose-draft");
    await first.page.reload();
    const held = await getRequest(first.invoke, first, winner.id);
    expect(held.state).toBe("queued");
    expect(held.blockedReason).toBe("compose-draft");
    expect(held.dispatchConfirmedAt).toBeNull();

    // Cancel releases every reservation; the other batch can then be sent.
    await first.invoke(C.requestCancel, {
      environmentId: first.environmentId,
      requestId: winner.id,
      expectedRevision: held.revision,
    });
    await expect
      .poll(async () => (await getRequest(first.invoke, first, winner.id)).state, {
        timeout: 15_000,
      })
      .toBe("cancelled");
    for (const id of winnerIds) expect(await activeRequest(first.invoke, first, id)).toBeNull();
    const retry = await prepare(second.invoke, first, [
      loserOnly === a ? a : b,
      loserOnly === a ? b : c,
    ]);
    const resent = await second.invoke<{ request: WebAnnotationRequest }>(C.requestSend, {
      environmentId: first.environmentId,
      preparationId: retry.preparationId,
      requestId: `req-retry-${Date.now()}`,
      bodyHash: retry.bodyHash,
    });
    expect(resent.request.reservation).toBe(true);
    const latest = await getRequest(first.invoke, first, resent.request.id);
    await first.invoke(C.requestCancel, {
      environmentId: first.environmentId,
      requestId: resent.request.id,
      expectedRevision: latest.revision,
    });
    await second.page.context().close();
  } finally {
    await first.cleanup();
    await first.page.context().close();
  }
});

test("request preparation enforces the annotation count bound at the command boundary", async ({
  browser,
}) => {
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const setup = await setUp(browser, status, "annotation-bounds", "codex", { holdQueue: true });
  try {
    const receipt = await createNote(
      setup,
      setup.page,
      `[data-testid="${TEST_IDS.teamCta}"]`,
      "Bound check",
    );
    const { annotation } = await setup.invoke<{
      annotation: { contentRevision: number; currentCaptureId: string };
    }>(C.get, { environmentId: setup.environmentId, annotationId: receipt.annotationId });
    const selection = {
      annotationId: receipt.annotationId,
      expectedContentRevision: annotation.contentRevision,
      expectedCaptureId: annotation.currentCaptureId,
    };
    const tooMany = Array.from(
      { length: WEB_ANNOTATION_LIMITS.briefAnnotations + 1 },
      () => selection,
    );
    const refused = await setup
      .invoke(C.requestPrepare, {
        environmentId: setup.environmentId,
        operation: "implement",
        destination: setup.destination,
        annotations: tooMany,
        instruction: "",
      })
      .then(
        () => "accepted",
        (error: Error) => error.message,
      );
    expect(refused).not.toBe("accepted");
    const oversizedInstruction = await setup
      .invoke(C.requestPrepare, {
        environmentId: setup.environmentId,
        operation: "implement",
        destination: setup.destination,
        annotations: [selection],
        instruction: "x".repeat(WEB_ANNOTATION_LIMITS.instructionChars + 1),
      })
      .then(
        () => "accepted",
        (error: Error) => error.message,
      );
    expect(oversizedInstruction).not.toBe("accepted");
  } finally {
    await setup.cleanup();
    await setup.page.context().close();
  }
});

test("live agent implements the fixture's expected source change", async ({
  browser,
}, testInfo) => {
  test.skip(
    !LIVE,
    "Live annotation runs need ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1 and a profile started with agent credentials",
  );
  testInfo.setTimeout(900_000);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const setup = await setUp(browser, status, "annotation-live", LIVE_AGENT, { holdQueue: false });
  try {
    const receipt = await createNote(
      setup,
      setup.page,
      EXPECTED_SOURCE_CHANGE.selector,
      EXPECTED_SOURCE_CHANGE.annotationBody,
      EXPECTED_SOURCE_CHANGE.route,
    );
    const preparation = await prepare(setup.invoke, setup, [receipt.annotationId]);
    expect(preparation.sendable).toBe(true);
    const sent = await setup.invoke<{ request: WebAnnotationRequest }>(C.requestSend, {
      environmentId: setup.environmentId,
      preparationId: preparation.preparationId,
      requestId: `req-live-${Date.now()}`,
      bodyHash: preparation.bodyHash,
    });
    let state = sent.request.state;
    await expect
      .poll(
        async () => {
          state = (await getRequest(setup.invoke, setup, sent.request.id)).state;
          return [
            "awaiting-review",
            "completed",
            "failed",
            "cancelled",
            "unconfirmed",
            "needs-input",
          ].includes(state);
        },
        { timeout: 840_000, intervals: [5_000] },
      )
      .toBe(true);
    testInfo.annotations.push({ type: "live-request-state", description: state });
    expect(state).toBe("awaiting-review");

    // The repository change, not a DOM mutation: source + rendered page.
    const verify = spawnSync("bun", ["annotation-app/verify-change.ts"], {
      cwd: setup.worktreePath,
      encoding: "utf8",
    });
    testInfo.annotations.push({
      type: "verify-change",
      description: verify.stdout.trim().slice(0, 1_500),
    });
    expect(verify.status).toBe(0);
    await setup.fixture.stop();
    const [port] = await reserveLoopbackPorts(1);
    const restarted = await startFixtureServer(setup.worktreePath, port!);
    setup.fixture = restarted;
    await setup.page.goto(`${restarted.url}${EXPECTED_SOURCE_CHANGE.route}`);
    await expect(setup.page.locator(EXPECTED_SOURCE_CHANGE.selector)).toHaveText(
      EXPECTED_SOURCE_CHANGE.after,
    );
  } finally {
    await setup.cleanup();
    await setup.page.context().close();
  }
});

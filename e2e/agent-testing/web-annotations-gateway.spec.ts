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
 * The live implement and discuss tests are opt-in
 * (`ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1`) and require a profile started
 * with agent credentials; otherwise they are reported as skipped, never as
 * passed. Each prints how its request settled (`[annotation-live] outcome`).
 */
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  WEB_ANNOTATION_COMMANDS as C,
  WEB_ANNOTATION_LIMITS,
  type WebAnnotationCaptureInput,
  type WebAnnotationDestination,
  type WebAnnotationRequest,
} from "@orkestrator/protocol/web-annotations";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import { waitForLiveAnnotationRequest } from "./web-annotations-live";
import { isSignInError } from "../../apps/desktop/scripts/dev/coordinator-live";
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
  readOnly: WebAnnotationRequest["readOnly"];
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
  image: StagedImage | null = null,
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
      image: image
        ? { width: image.width, height: image.height, scale: image.scale, reduced: false }
        : null,
    },
    evidence: {
      text: element.text.slice(0, 4_000),
      attributes: element.testId ? { "data-testid": element.testId } : {},
      styles: {},
      hierarchy: [],
      html: `<${element.tagName}>${element.text.slice(0, 200)}</${element.tagName}>`,
    },
    assetIds: image ? [image.assetId] : [],
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
  options: { holdQueue: boolean; approvals?: "ask" },
): Promise<Setup & { page: Page }> {
  const { page, invoke } = await client(browser, status);
  const projects = await invoke<Array<{ id: string; localPath: string | null }>>("get_projects");
  // A profile restarted without `--fixture` has no `testProject` in its
  // status; its fixture project keeps the same path.
  const project = projects.find((candidate) =>
    status.testProject
      ? candidate.localPath === status.testProject
      : candidate.localPath?.endsWith(path.join("fixtures", "test-project")),
  );
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
    if (options.approvals) {
      await invoke("update_environment_agent_settings", {
        environmentId,
        agentSettings: { executionPolicy: { approvals: options.approvals } },
      });
    }
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

interface StagedImage {
  assetId: string;
  width: number;
  height: number;
  scale: number;
  digest: string;
}

/**
 * Stage the viewport of `route` as real Chromium paints it, the way the
 * desktop stages a native screenshot before `web_annotation_create`.
 */
async function stageScreenshot(setup: Setup, page: Page, route: string): Promise<StagedImage> {
  await page.setViewportSize(FIXTURE_VIEWPORT);
  await page.goto(`${setup.fixture.url}${route}`);
  const png = await page.screenshot({ type: "png" });
  const staged = await setup.invoke<{ asset: { id: string } }>(C.assetStage, {
    environmentId: setup.environmentId,
    operationId: `asset-${Math.random().toString(36).slice(2)}`,
    mediaType: "image/png",
    data: png.toString("base64"),
  });
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return {
    assetId: staged.asset.id,
    width,
    height,
    scale: width / FIXTURE_VIEWPORT.width,
    digest: createHash("sha256").update(png).digest("hex"),
  };
}

async function createNote(
  setup: Setup,
  page: Page,
  selector: string,
  body: string,
  route = ROUTE_VARIANTS.pricing,
  image: StagedImage | null = null,
) {
  const capture = await captureFrom(page, setup.fixture, route, selector, image);
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

/** Send one implement request for `annotationIds` and return it. */
async function send(setup: Setup, annotationIds: string[], requestId: string) {
  const preparation = await prepare(setup.invoke, setup, annotationIds);
  expect(preparation.sendable).toBe(true);
  return (
    await setup.invoke<{ request: WebAnnotationRequest }>(C.requestSend, {
      environmentId: setup.environmentId,
      preparationId: preparation.preparationId,
      requestId,
      bodyHash: preparation.bodyHash,
    })
  ).request;
}

/** Poll until every attachment of a request has been written to the workspace. */
async function materializedRequest(setup: Setup, requestId: string) {
  let request: WebAnnotationRequest | null = null;
  await expect
    .poll(
      async () => {
        request = await getRequest(setup.invoke, setup, requestId);
        return (
          request.attachments.length > 0 &&
          request.attachments.every((attachment) => Boolean(attachment.materializedPath))
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return request!;
}

/** Cancel a held request and delete its notes: the evidence becomes collectable. */
async function settleAndDelete(setup: Setup, requestId: string, annotationIds: string[]) {
  const held = await getRequest(setup.invoke, setup, requestId);
  await setup.invoke(C.requestCancel, {
    environmentId: setup.environmentId,
    requestId,
    expectedRevision: held.revision,
  });
  await expect
    .poll(async () => (await getRequest(setup.invoke, setup, requestId)).state, {
      timeout: 15_000,
    })
    .toBe("cancelled");
  for (const annotationId of annotationIds) {
    const { annotation } = await setup.invoke<{ annotation: { metadataRevision: number } }>(C.get, {
      environmentId: setup.environmentId,
      annotationId,
    });
    await setup.invoke(C.delete, {
      environmentId: setup.environmentId,
      operationId: `delete-${annotationId}`,
      annotationId,
      expectedMetadataRevision: annotation.metadataRevision,
    });
  }
}

test("a sent request writes its evidence image into the local worktree under .orkestrator/annotations", async ({
  browser,
}, testInfo) => {
  testInfo.setTimeout(180_000);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const setup = await setUp(browser, status, "annotation-evidence", "codex", { holdQueue: true });
  try {
    const image = await stageScreenshot(setup, setup.page, ROUTE_VARIANTS.pricing);
    const receipt = await createNote(
      setup,
      setup.page,
      `[data-testid="${TEST_IDS.teamCta}"]`,
      "Evidence materialization check",
      ROUTE_VARIANTS.pricing,
      image,
    );
    const requestId = `req-evidence-${Date.now()}`;
    await send(setup, [receipt.annotationId], requestId);
    // Held behind the compose draft: written before publication, never run.
    const request = await materializedRequest(setup, requestId);
    expect(request.state).toBe("queued");
    expect(request.dispatchConfirmedAt).toBeNull();
    const [attachment] = request.attachments;
    expect(request.attachments).toHaveLength(1);
    expect(attachment!.digest).toBe(image.digest);
    // The written filename includes the full request hash to avoid ID collisions.
    const name = `${image.digest.slice(0, 32)}.png`;
    expect(attachment!.relativePath).toBe(`.orkestrator/annotations/${name}`);
    const requestHash = createHash("sha256").update(requestId).digest("hex");
    const written = `.orkestrator/annotations/${requestId.slice(0, 12)}-${requestHash}-${name}`;
    expect(attachment!.materializedPath).toBe(path.join(setup.worktreePath, written));
    const bytes = await readFile(attachment!.materializedPath!);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(image.digest);
    testInfo.annotations.push({
      type: "evidence-file",
      description: `${written} ${bytes.byteLength} B`,
    });
    // Still tracked (not removed) once the request settles while its note exists.
    await settleAndDelete(setup, requestId, []);
    const settled = await getRequest(setup.invoke, setup, requestId);
    expect(settled.attachments[0]?.removedAt).toBeUndefined();
    expect((await readFile(attachment!.materializedPath!)).byteLength).toBe(bytes.byteLength);
  } finally {
    await setup.cleanup();
    await setup.page.context().close();
  }
});

test("a desktop capture is reviewable from the web client with capture shown as unavailable", async ({
  browser,
}, testInfo) => {
  testInfo.setTimeout(180_000);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const setup = await setUp(browser, status, "annotation-web-review", "codex", {
    holdQueue: true,
  });
  try {
    const image = await stageScreenshot(setup, setup.page, ROUTE_VARIANTS.pricing);
    const body = "Review this Team button from the web client";
    const receipt = await createNote(
      setup,
      setup.page,
      `[data-testid="${TEST_IDS.teamCta}"]`,
      body,
      ROUTE_VARIANTS.pricing,
      image,
    );
    // A browser tab whose Notes column is open on that note, as the desktop
    // left it; this client has no native preview and so no capture.
    const layout = await setup.invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId: setup.environmentId,
    });
    const browserTabId = "annotation-web-review-tab";
    await setup.invoke("save_pane_layout", {
      environmentId: setup.environmentId,
      expectedRevision: layout?.revision ?? 0,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane-review",
        root: {
          kind: "leaf",
          id: "pane-review",
          tabs: [
            {
              id: browserTabId,
              type: "browser",
              browserData: {
                url: `${setup.fixture.url}${ROUTE_VARIANTS.pricing}`,
                annotationPanel: {
                  open: true,
                  filter: { scope: "all", state: "all" },
                  selectedAnnotationId: receipt.annotationId,
                },
              },
            },
            {
              id: setup.destination.tabId,
              type: "agent-native",
              nativeAgentData: { environmentId: setup.environmentId, platform: "codex" },
            },
          ],
          activeTabId: browserTabId,
        },
      },
    });
    const page = setup.page;
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(status.browserUrl!);
    const environment = await setup.invoke<{ name: string }>("get_environment", {
      environmentId: setup.environmentId,
    });
    await openEnvironment(page, environment.name);
    const panel = page.locator(`[data-annotation-panel="${browserTabId}"]`);
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(panel.locator('[data-annotation-notice="capture"]')).toContainText(
      "Capturing page targets needs the Orkestrator desktop app",
      { timeout: 30_000 },
    );
    await expect(panel.getByText(body).first()).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("button", { name: "Show on page" })).toHaveCount(0);
    // The saved desktop image loads from the backend, not from a desktop.
    const thumbnail = panel.locator("img").first();
    await expect(thumbnail).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => thumbnail.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    testInfo.annotations.push({
      type: "web-review",
      description: `${browser.browserType().name()} ${browser.version()}: capture unavailable notice, saved image and note body shown`,
    });
  } finally {
    await setup.cleanup();
    await setup.page.context().close();
  }
});

const DOCKER = process.env.ORKESTRATOR_AGENT_TEST_DOCKER === "1";
const CONTAINER_ENVIRONMENT =
  process.env.ORKESTRATOR_AGENT_TEST_ROOT_TERMINAL_ENVIRONMENT ?? "fixture-container";
const templateRoot = path.join(repositoryRoot, "test-fixtures", "agent-project");

/** `docker exec` in the fixture container; arguments never pass through a shell. */
function inContainer(containerId: string, args: string[]) {
  return spawnSync("docker", ["exec", "-w", "/workspace", containerId, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

/**
 * The profile's fixture container environment (`--fixture-environments
 * local,container`) with an agent tab added to its layout; cleanup restores
 * the layout it found. The fixture page is served from the host template: in
 * a container workspace only the page identity matters for a capture.
 */
async function setUpContainer(
  browser: Browser,
  status: Status,
  agent: WebAnnotationDestination["agent"],
  options: { holdQueue: boolean },
): Promise<Setup & { page: Page; containerId: string }> {
  const { page, invoke } = await client(browser, status);
  let environment: { id: string; containerId?: string | null } | undefined;
  for (const project of await invoke<Array<{ id: string }>>("get_projects")) {
    environment = (
      await invoke<Array<{ id: string; name: string; containerId?: string | null }>>(
        "get_environments",
        { projectId: project.id },
      )
    ).find((entry) => entry.name === CONTAINER_ENVIRONMENT);
    if (environment) break;
  }
  expect(environment?.containerId, `${CONTAINER_ENVIRONMENT} has no container`).toBeTruthy();
  const environmentId = environment!.id;
  const containerId = environment!.containerId!;
  const original = await invoke<{ revision?: number } | null>("get_pane_layout", {
    environmentId,
  });
  const draftKeys: string[] = [];
  let fixture: FixtureServer | null = null;
  const cleanup = async () => {
    for (const key of draftKeys)
      await invoke("delete_compose_draft", { draftKey: key }).catch(() => undefined);
    await fixture?.stop().catch(() => undefined);
    const current = await invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId,
    }).catch(() => null);
    if (original && current) {
      const { revision: _revision, ...layout } = original as Record<string, unknown>;
      await invoke("save_pane_layout", {
        environmentId,
        expectedRevision: current.revision ?? 0,
        layout,
      }).catch(() => undefined);
    }
  };
  try {
    const [port] = await reserveLoopbackPorts(1);
    fixture = await startFixtureServer(templateRoot, port!);
    const tabId = `annotation-container-${agent}`;
    const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId,
    });
    await invoke("save_pane_layout", {
      environmentId,
      expectedRevision: layout?.revision ?? 0,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId,
        activePaneId: "pane-annotations",
        root: {
          kind: "leaf",
          id: "pane-annotations",
          tabs: [
            {
              id: tabId,
              type: "agent-native",
              nativeAgentData: { environmentId, platform: agent, containerId },
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
    if (!option) throw new Error(`${agent} is not an annotation destination in the container`);
    if (options.holdQueue) {
      const draftKey = `${agent}:${environmentId}:${encodeURIComponent(option.destination.logicalSessionKey)}`;
      await invoke("save_compose_draft", {
        draftKey,
        ownerType: "environment",
        ownerId: environmentId,
        value: { text: "Held by the annotation suite", mentions: [], attachments: [] },
      });
      draftKeys.push(draftKey);
    }
    return {
      page,
      invoke,
      environmentId,
      worktreePath: "",
      containerId,
      destination: option.destination,
      fixture,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test("Docker fixture writes annotation evidence inside the container, checks paths there, and removes it after settlement", async ({
  browser,
}, testInfo) => {
  test.skip(!DOCKER, "Docker fixture profile required");
  // Settled-evidence cleanup runs on the reconciler's garbage-collection pass
  // (every 100 ticks of 3 s), so allow one full period.
  testInfo.setTimeout(9 * 60_000);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const setup = await setUpContainer(browser, status, "codex", { holdQueue: true });
  const link = ".orkestrator/annotations/outside-link";
  try {
    const image = await stageScreenshot(setup, setup.page, ROUTE_VARIANTS.pricing);
    const receipt = await createNote(
      setup,
      setup.page,
      `[data-testid="${TEST_IDS.teamCta}"]`,
      "Container evidence check",
      ROUTE_VARIANTS.pricing,
      image,
    );
    const requestId = `req-container-${Date.now()}`;
    await send(setup, [receipt.annotationId], requestId);
    const request = await materializedRequest(setup, requestId);
    expect(request.state).toBe("queued");
    const [attachment] = request.attachments;
    const requestHash = createHash("sha256").update(requestId).digest("hex");
    const written = `.orkestrator/annotations/${requestId.slice(0, 12)}-${requestHash}-${image.digest.slice(0, 32)}.png`;
    expect(attachment!.materializedPath).toBe(`/workspace/${written}`);
    const digest = inContainer(setup.containerId, ["sha256sum", attachment!.materializedPath!]);
    expect(digest.status, digest.stderr).toBe(0);
    expect(digest.stdout.split(/\s+/)[0]).toBe(image.digest);
    const owner = inContainer(setup.containerId, [
      "stat",
      "-c",
      "%U",
      attachment!.materializedPath!,
    ]);
    testInfo.annotations.push({
      type: "container-evidence",
      description: `${attachment!.materializedPath} owner=${owner.stdout.trim()}`,
    });

    // The result file check runs inside the container: a written file, a
    // missing one, and a symlink that leaves /workspace.
    expect(inContainer(setup.containerId, ["ln", "-sf", "/etc/hostname", link]).status).toBe(0);
    const checks = await setup.invoke<string[]>("check_container_workspace_paths", {
      containerId: setup.containerId,
      paths: [written, "annotation-app/content.ts", "annotation-app/missing.ts", link],
    });
    expect(checks).toEqual(["exists", "exists", "missing", "outside-workspace"]);
    testInfo.annotations.push({ type: "container-file-checks", description: checks.join(",") });

    // Settled, and its note deleted: the backend removes only its own file.
    await settleAndDelete(setup, requestId, [receipt.annotationId]);
    const removedAfter = Date.now();
    await expect
      .poll(
        () => inContainer(setup.containerId, ["test", "-e", attachment!.materializedPath!]).status,
        { timeout: 7 * 60_000, intervals: [5_000] },
      )
      .toBe(1);
    await expect
      .poll(
        async () => (await getRequest(setup.invoke, setup, requestId)).attachments[0]?.removedAt,
        { timeout: 30_000 },
      )
      .toBeTruthy();
    testInfo.annotations.push({
      type: "container-evidence-cleanup",
      description: `removed ${Math.round((Date.now() - removedAfter) / 1_000)} s after settlement`,
    });
  } finally {
    inContainer(setup.containerId, ["rm", "-f", link]);
    await setup.cleanup();
    await setup.page.context().close();
  }
});

test("Docker fixture live agent implements a note inside the container and its reported files are checked there", async ({
  browser,
}, testInfo) => {
  test.skip(
    !DOCKER || !LIVE,
    "Docker fixture profile and ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1 with a container login required",
  );
  testInfo.setTimeout(900_000);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const setup = await setUpContainer(browser, status, LIVE_AGENT, { holdQueue: false });
  const contentPath = EXPECTED_SOURCE_CHANGE.file;
  try {
    const original = inContainer(setup.containerId, ["cat", contentPath]);
    expect(original.status).toBe(0);
    const image = await stageScreenshot(setup, setup.page, EXPECTED_SOURCE_CHANGE.route);
    const receipt = await createNote(
      setup,
      setup.page,
      EXPECTED_SOURCE_CHANGE.selector,
      `${EXPECTED_SOURCE_CHANGE.annotationBody} When you are done, if the report_annotation_result tool is available, report the result and list exactly these files: ${contentPath} and annotation-app/not-created.ts (that second path does not exist; list it anyway, it checks the file checks).`,
      EXPECTED_SOURCE_CHANGE.route,
      image,
    );
    const sent = await send(setup, [receipt.annotationId], `req-container-live-${Date.now()}`);
    const state = await waitForLiveAnnotationRequest({
      readRequest: () => getRequest(setup.invoke, setup, sent.id),
      agent: LIVE_AGENT,
      profile,
      testInfo,
    });
    await recordLiveOutcome(setup, sent.id, testInfo);
    expect(state).toBe("awaiting-review");
    const verify = inContainer(setup.containerId, ["bun", "annotation-app/verify-change.ts"]);
    testInfo.annotations.push({
      type: "verify-change",
      description: verify.stdout.trim().slice(0, 1_500),
    });
    expect(verify.status).toBe(0);
    const { results } = await setup.invoke<{
      results: Array<{ provenance: string; fileChecks?: Array<{ path: string; status: string }> }>;
    }>(C.requestGet, { environmentId: setup.environmentId, requestId: sent.id });
    const reported = results.find((result) => result.provenance === "agent-reported");
    testInfo.annotations.push({
      type: "container-reported-file-checks",
      description: JSON.stringify(reported?.fileChecks ?? null),
    });
    expect(reported, "agent report is required to qualify container file checks").toBeDefined();
    expect(reported?.fileChecks).toEqual(
      expect.arrayContaining([
        { path: contentPath, status: "exists" },
        { path: "annotation-app/not-created.ts", status: "missing" },
      ]),
    );
  } finally {
    // Leave the shared fixture container's source as the next run expects it.
    inContainer(setup.containerId, ["git", "checkout", "--", contentPath]);
    await setup.cleanup();
    await setup.page.context().close();
  }
});

/** Open an environment from the sidebar, dismissing first-run tool dialogs. */
async function openEnvironment(page: Page, name: string): Promise<void> {
  const entry = page.getByText(name, { exact: true }).first();
  const expand = page.getByRole("button", { name: /^Expand project / }).first();
  await expect(expand.or(entry)).toBeVisible({ timeout: 90_000 });
  for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    if (await button.isVisible()) await button.click();
  }
  if (!(await entry.isVisible())) await expand.click();
  await page.mouse.move(0, 0);
  await entry.click();
}

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
    const startedAt = Date.now();
    const state = await waitForLiveAnnotationRequest({
      readRequest: () => getRequest(setup.invoke, setup, sent.request.id),
      agent: LIVE_AGENT,
      profile,
      testInfo,
    });
    testInfo.annotations.push({
      type: "live-request-state",
      description: `${state} after ${Math.round((Date.now() - startedAt) / 1_000)} s`,
    });
    await recordLiveOutcome(setup, sent.request.id, testInfo);
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

/**
 * Content-free facts about how a live request settled: whether the turn
 * outcome was known, the mode it was sent in, and how Discuss was enforced.
 * Printed as well, so a logged run records them per provider.
 */
async function recordLiveOutcome(setup: Setup, requestId: string, testInfo: TestInfo) {
  const settled = await getRequest(setup.invoke, setup, requestId);
  const facts = {
    agent: LIVE_AGENT,
    operation: settled.operation,
    state: settled.state,
    turnOutcome: settled.turnOutcome ?? null,
    dispatchMode: settled.dispatchMode ?? null,
    readOnly: settled.readOnly,
    interactions: (settled.interactions ?? []).map((item) => `${item.kind}:${item.state}`),
  };
  console.log(`[annotation-live] outcome ${JSON.stringify(facts)}`);
  testInfo.annotations.push({ type: "live-outcome", description: JSON.stringify(facts) });
  return settled;
}

test("live agent discusses a note and the turn outcome is known", async ({ browser }, testInfo) => {
  test.skip(
    !LIVE,
    "Live annotation runs need ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1 and a profile started with agent credentials",
  );
  testInfo.setTimeout(900_000);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const setup = await setUp(browser, status, "annotation-live-discuss", LIVE_AGENT, {
    holdQueue: false,
  });
  try {
    const receipt = await createNote(
      setup,
      setup.page,
      EXPECTED_SOURCE_CHANGE.selector,
      "Why might this label read awkwardly? Answer briefly; do not change anything.",
      EXPECTED_SOURCE_CHANGE.route,
    );
    const preparation = await prepare(setup.invoke, setup, [receipt.annotationId], "discuss");
    expect(preparation.sendable).toBe(true);
    const sent = await setup.invoke<{ request: WebAnnotationRequest }>(C.requestSend, {
      environmentId: setup.environmentId,
      preparationId: preparation.preparationId,
      requestId: `req-live-discuss-${Date.now()}`,
      bodyHash: preparation.bodyHash,
    });
    const state = await waitForLiveAnnotationRequest({
      readRequest: () => getRequest(setup.invoke, setup, sent.request.id),
      agent: LIVE_AGENT,
      profile,
      testInfo,
    });
    const settled = await recordLiveOutcome(setup, sent.request.id, testInfo);
    expect(state).toBe("completed");
    // Claude applies plan mode per turn; a fresh session-scoped session is
    // not in Plan, so Discuss is advisory there and never switches its mode.
    expect(settled.readOnly).toBe(LIVE_AGENT === "claude" ? "plan-mode" : "advisory");
    expect(settled.turnOutcome).toBe("completed");
  } finally {
    await setup.cleanup();
    await setup.page.context().close();
  }
});

test("live session-scoped agent already in Plan discusses read-only and never has its mode switched", async ({
  browser,
}, testInfo) => {
  test.skip(
    !LIVE || !["codex", "cursor", "grok"].includes(LIVE_AGENT),
    "Needs ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1 and a session-scoped mode provider (codex, cursor or grok)",
  );
  testInfo.setTimeout(1_200_000);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const setup = await setUp(browser, status, "annotation-live-plan", LIVE_AGENT, {
    holdQueue: false,
  });
  const discussOnce = async (requestId: string) => {
    const receipt = await createNote(
      setup,
      setup.page,
      EXPECTED_SOURCE_CHANGE.selector,
      "Why might this label read awkwardly? Answer briefly; do not change anything.",
      EXPECTED_SOURCE_CHANGE.route,
    );
    return prepare(setup.invoke, setup, [receipt.annotationId], "discuss").then((preparation) => ({
      preparation,
      requestId,
    }));
  };
  const send = async ({ preparation, requestId }: Awaited<ReturnType<typeof discussOnce>>) =>
    setup.invoke<{ request: WebAnnotationRequest }>(C.requestSend, {
      environmentId: setup.environmentId,
      preparationId: preparation.preparationId,
      requestId,
      bodyHash: preparation.bodyHash,
    });
  const setMode = (mode: "plan" | "build") =>
    setup.invoke("update_native_agent_controls", {
      environmentId: setup.environmentId,
      agent: LIVE_AGENT,
      logicalSessionKey: setup.destination.logicalSessionKey,
      update: { mode },
    });
  const option = async () => {
    const { options } = await setup.invoke<{
      options: Array<{
        destination: WebAnnotationDestination;
        planMode: boolean;
        planModeScope?: string;
      }>;
    }>(C.destinations, { environmentId: setup.environmentId });
    return options.find((candidate) => candidate.destination.tabId === setup.destination.tabId);
  };
  try {
    // A first (advisory) discussion creates the provider session.
    const first = await send(await discussOnce(`req-live-plan-a-${Date.now()}`));
    await waitForLiveAnnotationRequest({
      readRequest: () => getRequest(setup.invoke, setup, first.request.id),
      agent: LIVE_AGENT,
      profile,
      testInfo,
    });
    await recordLiveOutcome(setup, first.request.id, testInfo);

    // The user puts the session in Plan; Discuss is read-only from then on.
    await setMode("plan");
    expect(await option()).toMatchObject({ planMode: true, planModeScope: "session" });
    const readOnly = await discussOnce(`req-live-plan-b-${Date.now()}`);
    expect(readOnly.preparation.readOnly).toBe("plan-mode");
    const sent = await send(readOnly);
    const state = await waitForLiveAnnotationRequest({
      readRequest: () => getRequest(setup.invoke, setup, sent.request.id),
      agent: LIVE_AGENT,
      profile,
      testInfo,
    });
    const settled = await recordLiveOutcome(setup, sent.request.id, testInfo);
    expect(state).toBe("completed");
    expect(settled).toMatchObject({ readOnly: "plan-mode", dispatchMode: "plan" });
    expect((await option())?.planModeScope).toBe("session");

    // Prepared read-only, then the session leaves Plan before Send: refused,
    // and the session stays in Build.
    const stale = await discussOnce(`req-live-plan-c-${Date.now()}`);
    expect(stale.preparation.readOnly).toBe("plan-mode");
    await setMode("build");
    const refused = await send(stale);
    await expect
      .poll(async () => (await getRequest(setup.invoke, setup, refused.request.id)).state, {
        timeout: 60_000,
      })
      .toBe("failed");
    const failed = await getRequest(setup.invoke, setup, refused.request.id);
    expect(failed.stateReason).toContain("no longer in Plan mode");
    testInfo.annotations.push({ type: "live-plan-refusal", description: failed.stateReason ?? "" });
    expect((await option())?.planMode).toBe(false);
  } finally {
    await setup.cleanup();
    await setup.page.context().close();
  }
});

const QUESTION_TOOL: Partial<Record<WebAnnotationDestination["agent"], string>> = {
  claude: "AskUserQuestion tool",
  grok: "ask_user_question tool",
  opencode: "question tool",
};
const APPROVAL_KINDS = new Set(["command-approval", "file-approval", "permission"]);
/**
 * Providers whose Ask policy does not gate an edit inside the workspace, so an
 * implement request never waits on an approval (observed 2026-10-25).
 */
const EDITS_WITHOUT_APPROVAL: Partial<Record<WebAnnotationDestination["agent"], string>> = {
  codex: "Codex applies in-workspace edits under the Ask policy without an approval",
};

/**
 * The answer the request card sends (`NativeAgentInteractionCard`): its
 * primary button. An approval without choices is answered with no answers
 * (allow once); otherwise the allow-once option or the named choice.
 */
function cardAnswer(
  interaction: AgentInteractionRequest,
  pick: (label: string) => boolean,
): AgentInteractionResolution {
  const question = interaction.presentation.questions[0];
  const answers: Array<{ questionId: string; optionIds: string[] }> = [];
  if (question && (question.required || interaction.kind === "question")) {
    const option = question.options.find(
      (item) => item.amendment === undefined && pick(item.label),
    );
    if (!option) {
      throw new Error(
        `no option to pick in ${interaction.kind}: ${JSON.stringify(question.options.map((item) => item.label))}`,
      );
    }
    answers.push({ questionId: question.id, optionIds: [option.id] });
  }
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: interaction.id,
    sessionId: interaction.sessionId,
    action: "answer",
    answer: {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      interactionId: interaction.id,
      sessionId: interaction.sessionId,
      answers,
    },
    resolvedAt: Date.now(),
  };
}

for (const kind of ["approval", "question"] as const) {
  test(`live agent request waits in needs-input on a${kind === "approval" ? "n approval" : " clarifying question"}, and one answer completes it`, async ({
    browser,
  }, testInfo) => {
    test.skip(
      !LIVE || (kind === "question" && !QUESTION_TOOL[LIVE_AGENT]),
      kind === "question"
        ? "Needs ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1 and a provider with a question tool (claude, grok or opencode)"
        : "Needs ORKESTRATOR_AGENT_TEST_LIVE_ANNOTATIONS=1",
    );
    test.skip(
      kind === "approval" && Boolean(EDITS_WITHOUT_APPROVAL[LIVE_AGENT]),
      EDITS_WITHOUT_APPROVAL[LIVE_AGENT] ?? "",
    );
    testInfo.setTimeout(900_000);
    const status = profileStatus();
    expect(status.status).toBe("ready");
    const setup = await setUp(browser, status, `annotation-live-${kind}`, LIVE_AGENT, {
      holdQueue: false,
      approvals: kind === "approval" ? "ask" : undefined,
    });
    try {
      const body =
        kind === "approval"
          ? EXPECTED_SOURCE_CHANGE.annotationBody
          : `Before changing anything, use the ${QUESTION_TOOL[LIVE_AGENT]} exactly once to ask me which new label the Team plan button should get, offering exactly two options: “${EXPECTED_SOURCE_CHANGE.after}” and “Try Team free”. Then change the Team plan button label in the fixture source (${EXPECTED_SOURCE_CHANGE.file}) to the label I pick, and keep every other plan unchanged.`;
      const receipt = await createNote(
        setup,
        setup.page,
        EXPECTED_SOURCE_CHANGE.selector,
        body,
        EXPECTED_SOURCE_CHANGE.route,
      );
      const sent = await send(setup, [receipt.annotationId], `req-live-${kind}-${Date.now()}`);
      const startedAt = Date.now();
      let request: WebAnnotationRequest | null = null;
      await expect
        .poll(
          async () => {
            request = await getRequest(setup.invoke, setup, sent.id);
            if (request.state === "queued" && request.blockedReason === "dispatch-rejected") {
              const reason = (request.stateReason ?? "").slice(0, 300);
              if (isSignInError(reason)) testInfo.skip(true, `no usable ${LIVE_AGENT}: ${reason}`);
              throw new Error(`${LIVE_AGENT} rejected the request: ${reason}`);
            }
            if (["awaiting-review", "completed", "failed", "cancelled"].includes(request.state)) {
              throw new Error(`the turn settled ${request.state} without asking`);
            }
            return request.state === "needs-input" && (request.interactions ?? []).length > 0;
          },
          { timeout: 600_000, intervals: [3_000] },
        )
        .toBe(true);
      const pending = request!.interactions!.find((item) =>
        kind === "approval" ? APPROVAL_KINDS.has(item.kind) : item.kind === "question",
      );
      expect(pending, JSON.stringify(request!.interactions)).toBeTruthy();
      testInfo.annotations.push({
        type: "needs-input",
        description: `${pending!.kind} after ${Math.round((Date.now() - startedAt) / 1_000)} s`,
      });
      if (kind === "approval") {
        const unchanged = spawnSync(
          "bun",
          ["annotation-app/verify-change.ts", "--expect=original"],
          {
            cwd: setup.worktreePath,
            encoding: "utf8",
          },
        );
        expect(unchanged.status, "nothing changes before the approval").toBe(0);
      }
      // The card reads the body from the destination session's projection.
      const projection = await setup.invoke<{ interactions: AgentInteractionRequest[] }>(
        "get_native_agent_projection",
        {
          environmentId: setup.environmentId,
          agent: LIVE_AGENT,
          logicalSessionKey: setup.destination.logicalSessionKey,
          messageLimit: 20,
        },
      );
      const interaction = projection.interactions.find((item) => item.id === pending!.id);
      expect(interaction, "the pending interaction is readable for the card").toBeTruthy();
      const resolution = cardAnswer(interaction!, (label) =>
        kind === "approval"
          ? /^(allow|approve|yes|accept|run)\b/i.test(label) &&
            !/always|session|remember|policy|deny|reject|never|\bno\b/i.test(label)
          : label.includes(EXPECTED_SOURCE_CHANGE.after),
      );
      const resolve = () =>
        setup.invoke<{ result: string }>("resolve_native_agent_interaction", {
          environmentId: setup.environmentId,
          agent: LIVE_AGENT,
          logicalSessionKey: setup.destination.logicalSessionKey,
          interactionId: interaction!.id,
          resolution,
        });
      expect((await resolve()).result).toBe("applied");
      // The same answer again (a second client, or chat after the card) is not applied twice.
      const again = await resolve().then(
        (outcome) => outcome.result,
        (error: Error) => `error: ${error.message.slice(0, 200)}`,
      );
      expect(again).not.toBe("applied");
      testInfo.annotations.push({ type: "second-answer", description: again });
      const state = await waitForLiveAnnotationRequest({
        readRequest: () => getRequest(setup.invoke, setup, sent.id),
        agent: LIVE_AGENT,
        profile,
        testInfo,
        throughInput: true,
      });
      await recordLiveOutcome(setup, sent.id, testInfo);
      expect(state).toBe("awaiting-review");
      const verify = spawnSync("bun", ["annotation-app/verify-change.ts"], {
        cwd: setup.worktreePath,
        encoding: "utf8",
      });
      testInfo.annotations.push({
        type: "verify-change",
        description: verify.stdout.trim().slice(0, 1_500),
      });
      expect(verify.status).toBe(0);
    } finally {
      await setup.cleanup();
      await setup.page.context().close();
    }
  });
}

/**
 * Last in the file: the backend's own latency series for everything this run
 * did (content-free), recorded as a baseline. Counts reset with the backend.
 */
test("baselines: backend annotation latency from web_annotations_metrics", async ({
  browser,
}, testInfo) => {
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const { page, invoke } = await client(browser, status);
  try {
    const metrics = await invoke<{
      durations: Record<string, { count: number; totalMs: number; maxMs: number }>;
    }>(C.metrics, {});
    const series = Object.fromEntries(
      Object.entries(metrics.durations)
        .filter(([key]) => /^(command_ms|request_)/.test(key))
        .map(([key, value]) => [
          key,
          {
            count: value.count,
            meanMs: Math.round(value.totalMs / Math.max(1, value.count)),
            maxMs: Math.round(value.maxMs),
          },
        ]),
    );
    const line = JSON.stringify(series);
    console.log(`[annotation-baseline] ${line}`);
    testInfo.annotations.push({ type: "baselines", description: line.slice(0, 8_000) });
  } finally {
    await page.context().close();
  }
});

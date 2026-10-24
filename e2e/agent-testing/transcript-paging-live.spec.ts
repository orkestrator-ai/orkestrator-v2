/**
 * Live transcript paging past the 100-message live window, against a real
 * `dev:test --fixture` profile.
 *
 * Opt-in only (`ORKESTRATOR_AGENT_TEST_LIVE_TRANSCRIPT_PAGING=1`): both cases
 * run real provider turns on the host's Claude and Codex credentials.
 *
 * A transcript only outgrows the live window when an agent answers many
 * times, so each case lays a trail of files in the environment: every file
 * names the next under a random name, so an agent cannot read ahead or batch
 * the reads. A transcript row is one model response, so Claude, which answers
 * each read in its own response, writes more than N rows for a trail of N
 * files. Codex infers its boundary and opens a row only where reasoning or a
 * message follows a tool call, so reviewers also note each stop in a sentence.
 * The stop each tool call read says exactly where in the conversation a row
 * belongs, which makes gaps, duplicates and reordering between pages and the
 * live tail checkable without reading any model prose.
 *
 * A Claude reviewer runs read-only without project instructions
 * (`READ_ONLY_TURN_POLICY`), and in qualification it reviewed the change
 * without walking the trail, so the long reviewer is normally the Codex one.
 *
 * 1. A native Claude tab (or Codex, with
 *    `ORKESTRATOR_AGENT_TEST_PAGING_NATIVE_PLATFORM=codex`) follows a trail
 *    longer than the live window. The
 *    backend reports a truncated window with a cursor; paging through it
 *    returns every row once and in order. In the browser, "Load earlier
 *    messages" brings back the first prompt, keeps the reader's place, and a
 *    tool row from the loaded page expands to its deferred output. The same
 *    holds after a reload.
 * 2. A Multi Review whose reviewers are told (through an `AGENTS.md` that is
 *    part of the change) to walk a trail before reviewing. While they
 *    run, progress probes must keep moving and no stall may be reported.
 *    Afterwards each long reviewer's summary window is bounded, a repeated
 *    read answers `unchanged`, pages chain back to the first prompt without
 *    gaps, a deferred tool body resolves, and the reviewer tab's "Load
 *    earlier messages" keeps the reader's place in a real browser.
 *
 * Models default to the cheapest each platform offers; override with
 * `ORKESTRATOR_AGENT_TEST_PAGING_NATIVE_MODEL` (the native tab's model id,
 * else the first Haiku, or GPT-6-Luna for Codex, in the catalogue) and the
 * Multi Review picker labels
 * `ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_CLAUDE_MODEL` /
 * `ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_CODEX_MODEL`
 * (`ORKESTRATOR_AGENT_TEST_PAGING_FIRST_REVIEWER=codex` replaces the Claude
 * reviewer with a medium-effort Codex one). Trail lengths are
 * `ORKESTRATOR_AGENT_TEST_PAGING_NATIVE_STOPS` and
 * `ORKESTRATOR_AGENT_TEST_PAGING_REVIEW_STOPS`. Measurements are recorded as
 * Playwright annotations in `results.json`; prompts and transcript text never
 * reach test output.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { DEFAULT_NATIVE_AGENT_LIVE_WINDOW } from "@orkestrator/protocol/native-agent";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

type Status = { status: string; profile?: string; browserUrl?: string; testProject?: string };
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Row = { id?: unknown; role?: unknown; content?: unknown; parts?: unknown };
type ProjectionUpdate = {
  status: string;
  projection?: {
    turn: { phase: string; error?: string };
    messages: Row[];
    messageWindow?: { truncated?: boolean; omittedMessages?: number; canLoadEarlier?: boolean };
  };
  historyCursor?: string;
  historyEpoch?: string;
  historyComplete?: boolean;
};
type MessagePage = {
  messages: Row[];
  historyEpoch: string;
  nextCursor?: string;
  complete: boolean;
  truncated: boolean;
};
type ReviewerTranscript = {
  status: string;
  messages: Row[];
  transcript?: "snapshot" | "unchanged";
  sourceToken?: string;
  truncated?: boolean;
  fallback?: boolean;
  historyCursor?: string;
  historyEpoch?: string;
};
type ReviewerPage = (MessagePage & { status: "page" }) | { status: "expired"; reason: string };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_TRANSCRIPT_PAGING === "1";
/** The native case's platform: Claude by default, or Codex. */
const NATIVE_PLATFORM: "claude" | "codex" =
  process.env.ORKESTRATOR_AGENT_TEST_PAGING_NATIVE_PLATFORM === "codex" ? "codex" : "claude";
const NATIVE_LABEL = NATIVE_PLATFORM === "codex" ? "Codex" : "Claude";
const NATIVE_MODEL = process.env.ORKESTRATOR_AGENT_TEST_PAGING_NATIVE_MODEL;
const REVIEW_CLAUDE_MODEL =
  process.env.ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_CLAUDE_MODEL ?? "Haiku 4.5";
const REVIEW_CODEX_MODEL =
  process.env.ORKESTRATOR_AGENT_TEST_MULTI_REVIEW_CODEX_MODEL ?? "GPT-6-Luna";
/**
 * `codex` makes the first reviewer a Codex one at medium effort (still a
 * different configuration from the second), for when Claude is unavailable.
 */
const FIRST_REVIEWER_CODEX = process.env.ORKESTRATOR_AGENT_TEST_PAGING_FIRST_REVIEWER === "codex";
const NATIVE_STOPS = Number(process.env.ORKESTRATOR_AGENT_TEST_PAGING_NATIVE_STOPS ?? "150");
/**
 * `0` drops the sentence the native Codex case writes after each stop, so the
 * run is tool calls only and every row boundary is the bridge's per-response
 * one (`thread/tokenUsage/updated`), not a message after a call.
 */
const CODEX_STEP_NOTES = process.env.ORKESTRATOR_AGENT_TEST_PAGING_CODEX_NOTES !== "0";
const REVIEW_STOPS = Number(process.env.ORKESTRATOR_AGENT_TEST_PAGING_REVIEW_STOPS ?? "130");
const LIVE_WINDOW = DEFAULT_NATIVE_AGENT_LIVE_WINDOW.messages;
/** A small page size, so the backend's cursors are followed several times. */
const API_PAGE_MESSAGES = 40;
/** Follow-up prompts allowed when a model stops walking before the end. */
const MAX_CONTINUATIONS = 4;
const TURN_TIMEOUT_MS = 20 * 60_000;
/** Running time after which a reviewer's progress clock must have advanced: 2.5 probe intervals. */
const PROGRESS_EVIDENCE_MS = 150_000;
const SETTLED_PHASES = new Set(["ready", "interactive", "completed", "failed", "cancelled"]);

test.describe.configure({ mode: "serial" });
// A multi-minute live trace outgrows the artifact sanitizer's bound.
test.use({ trace: "off" });

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) {
    throw new Error(`dev:status for profile "${profile}" returned no manifest`);
  }
  const status = JSON.parse(command.stdout) as Status;
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  return status;
}

/** Signs the page in and returns an invoker bound to the profile's gateway. */
async function signIn(page: Page, status: Status): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
  return async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command: name, args } },
    );
    expect(invokeResponse.ok(), `${name}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

function note(type: string, value: unknown): void {
  test.info().annotations.push({
    type,
    description: typeof value === "string" ? value : JSON.stringify(value),
  });
}

/**
 * A chain of files under `trail-<run>/`, each naming the next under a random
 * name. `stopOf` maps a file name back to its 1-based position.
 */
class Trail {
  readonly dir: string;
  readonly files: string[];
  readonly closingWord: string;
  private readonly positions: Map<string, number>;

  constructor(readonly stops: number) {
    const run = randomBytes(3).toString("hex");
    this.dir = `trail-${run}`;
    this.files = Array.from({ length: stops }, () => `${randomBytes(5).toString("hex")}.txt`);
    this.closingWord = `TRAILEND${randomBytes(3).toString("hex").toUpperCase()}`;
    this.positions = new Map(this.files.map((file, index) => [file, index + 1]));
  }

  get start(): string {
    return `${this.dir}/${this.files[0]}`;
  }

  async write(root: string): Promise<void> {
    await fs.mkdir(path.join(root, this.dir), { recursive: true });
    await Promise.all(
      this.files.map((file, index) => {
        const next = this.files[index + 1];
        const body = next
          ? `Trail stop ${index + 1} of ${this.stops}. Next stop: ${this.dir}/${next}\n`
          : `Trail stop ${index + 1} of ${this.stops}. This is the end of the trail. The closing word is ${this.closingWord}.\n`;
        // 12 KiB stays within file-reading defaults but exceeds both bridge
        // and backend inline thresholds. Stop 2 must be in paged history.
        const detailBody = index === 1 ? `${"Audit detail padding. ".repeat(600)}\n` : "";
        return fs.writeFile(path.join(root, this.dir, file), body + detailBody);
      }),
    );
  }

  /** The stops a row's tool calls read, from their arguments only. */
  stopsRead(row: Row): number[] {
    const found: number[] = [];
    const visit = (parts: unknown) => {
      if (!Array.isArray(parts)) return;
      for (const part of parts) {
        if (typeof part !== "object" || part === null) continue;
        const record = part as { type?: unknown; toolArgs?: unknown; parts?: unknown };
        if (record.type === "tool-invocation" && record.toolArgs !== undefined) {
          const args = JSON.stringify(record.toolArgs);
          for (const match of args.matchAll(/([0-9a-f]{10})\.txt/g)) {
            const stop = this.positions.get(`${match[1]}.txt`);
            if (stop !== undefined) found.push(stop);
          }
        }
        visit(record.parts);
      }
    };
    visit(row.parts);
    return found;
  }

  /** The stop a rendered row names in its visible text, if any. */
  stopInText(text: string): number | undefined {
    for (const match of text.matchAll(/([0-9a-f]{10})\.txt/g)) {
      const stop = this.positions.get(`${match[1]}.txt`);
      if (stop !== undefined) return stop;
    }
    return undefined;
  }

  /**
   * Checks a whole transcript, oldest first: unique ids, and every stop the
   * agent read appears in order (a re-read of an earlier stop is allowed; a
   * stop that appears before its predecessor means pages were stitched out of
   * order or a page went missing).
   */
  verifyOrder(rows: Row[], label: string): { stopsRead: number; highest: number } {
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size, `${label}: duplicate row ids across pages`).toBe(ids.length);
    let highest = 0;
    const seen = new Set<number>();
    for (const row of rows) {
      for (const stop of this.stopsRead(row)) {
        if (!seen.has(stop)) {
          expect(stop, `${label}: stop ${stop} appears before stop ${highest + 1}`).toBe(
            highest + 1,
          );
          highest = stop;
          seen.add(stop);
        }
      }
    }
    return { stopsRead: seen.size, highest };
  }
}

function rowText(row: Row): string {
  if (typeof row.content === "string" && row.content) return row.content;
  if (!Array.isArray(row.parts)) return "";
  return row.parts
    .map((part) => {
      const { text, content } = (part ?? {}) as { text?: unknown; content?: unknown };
      return typeof text === "string" ? text : typeof content === "string" ? content : "";
    })
    .join("");
}

/** A deferred body for the oversized fixture stop, from that tool's own arguments. */
function findDeferredTool(
  trail: Trail,
  rows: Row[],
  requiredStop: number,
): { detailRef: string; stop: number } | undefined {
  for (const row of rows) {
    const stack = Array.isArray(row.parts) ? [...row.parts] : [];
    while (stack.length > 0) {
      const part = stack.shift() as {
        type?: unknown;
        detailRef?: unknown;
        parts?: unknown;
        childTools?: unknown;
      } | null;
      if (!part || typeof part !== "object") continue;
      // A row can carry more than one tool. Its first filename does not
      // identify the tool whose deferred body we are about to fetch.
      if (
        part.type === "tool-invocation" &&
        typeof part.detailRef === "string" &&
        trail.stopsRead({ parts: [part] }).includes(requiredStop)
      ) {
        return { detailRef: part.detailRef, stop: requiredStop };
      }
      if (Array.isArray(part.parts)) stack.push(...part.parts);
      if (Array.isArray(part.childTools)) stack.push(...part.childTools);
    }
  }
  return undefined;
}

/** Verify the oversized body itself, without ever printing fixture contents. */
function expectDeferredTrailBody(
  trail: Trail,
  stop: number,
  details: { toolOutput?: string; toolError?: string },
): number {
  const body = details.toolOutput ?? details.toolError ?? "";
  expect(
    body.includes(`Trail stop ${stop} of ${trail.stops}.`),
    "the requested trail body resolved",
  ).toBe(true);
  expect(body.includes("Audit detail padding."), "the oversized fixture body resolved").toBe(true);
  const bytes = new TextEncoder().encode(body).byteLength;
  expect(bytes, "the deferred body exceeds the 4 KiB bridge inline threshold").toBeGreaterThan(
    4 * 1024,
  );
  return bytes;
}

/** The visible transcript scroller in the active tab. */
function scroller(page: Page): Locator {
  return page.locator("[data-virtuoso-scroller]").filter({ visible: true }).first();
}

/** First visible source tool, rather than the top of a possibly huge coalesced row. */
async function firstVisibleRow(list: Locator) {
  return list.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    for (const tool of element.querySelectorAll<HTMLElement>("[data-transcript-part-id]")) {
      const rect = tool.getBoundingClientRect();
      if (rect.bottom > top + 1 && rect.top < top + element.clientHeight) {
        return {
          text: tool.textContent ?? "",
          index: Number(
            tool.closest<HTMLElement>("[data-chat-message-index]")?.dataset.chatMessageIndex,
          ),
          offset: Math.round(rect.top - top),
          scrollTop: Math.round(element.scrollTop),
        };
      }
    }
    return null;
  });
}

/** Where the tool naming `stop` sits relative to the viewport, if rendered. */
async function rowPosition(list: Locator, trail: Trail, stop: number) {
  const pattern = trail.files[stop - 1]!.replace(".txt", "");
  return list.evaluate((element, needle) => {
    const top = element.getBoundingClientRect().top;
    const height = element.clientHeight;
    for (const tool of element.querySelectorAll<HTMLElement>("[data-transcript-part-id]")) {
      if (!(tool.textContent ?? "").includes(needle)) continue;
      const rect = tool.getBoundingClientRect();
      return {
        index: Number(
          tool.closest<HTMLElement>("[data-chat-message-index]")?.dataset.chatMessageIndex,
        ),
        offset: Math.round(rect.top - top),
        visible: rect.bottom > top && rect.top < top + height,
      };
    }
    return null;
  }, pattern);
}

/**
 * Scrolls up the way a reader does, with the wheel. A programmatic scroll is
 * not user intent to the list: it stays pinned to the bottom and snaps back.
 */
async function wheelUp(page: Page, list: Locator): Promise<void> {
  const box = await list.boundingBox();
  if (!box) throw new Error("the transcript list is not laid out");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < 5; step += 1) await page.mouse.wheel(0, -4_000);
}

/** Scrolls the list to its top until the history header's control shows. */
async function scrollToTop(page: Page, list: Locator, control: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        await wheelUp(page, list);
        await page.waitForTimeout(150);
        // isVisible() tests CSS visibility, even when a mounted header is
        // outside the viewport. Otherwise click() scrolls it into view after
        // we measured the anchor, and the assertion compares two places.
        const [button, viewport, scrollTop] = await Promise.all([
          control.boundingBox(),
          list.boundingBox(),
          list.evaluate((element) => element.scrollTop),
        ]);
        return (
          button !== null &&
          viewport !== null &&
          scrollTop <= 1 &&
          button.y >= viewport.y &&
          button.y + button.height <= viewport.y + viewport.height
        );
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(true);
}

/**
 * Clicks "Load earlier messages" once from the top of the list and measures
 * where the row that was first on screen ends up.
 */
async function loadEarlierOnce(page: Page, list: Locator, trail: Trail, label: string) {
  const control = page.getByRole("button", { name: "Load earlier messages", exact: true });
  await scrollToTop(page, list, control);
  const before = await firstVisibleRow(list);
  const anchorStop = before ? trail.stopInText(before.text) : undefined;
  expect(anchorStop, `${label}: the first visible row must name a trail stop`).toBeDefined();
  await control.click();
  // The click either retires the control (history complete) or offers it again.
  await expect(page.getByRole("button", { name: "Loading…", exact: true })).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect
    .poll(
      async () => {
        const anchor = await rowPosition(list, trail, anchorStop!);
        return anchor ? Math.abs(anchor.offset - before!.offset) : Infinity;
      },
      { timeout: 5_000, intervals: [100] },
    )
    .toBeLessThanOrEqual(8);
  const after = await firstVisibleRow(list);
  const anchor = anchorStop === undefined ? null : await rowPosition(list, trail, anchorStop);
  const measurement = {
    anchorStop,
    anchorIndexBefore: before?.index,
    anchorOffsetBefore: before?.offset,
    anchorAfter: anchor,
    firstVisibleStopAfter: after ? trail.stopInText(after.text) : undefined,
    scrollTopAfter: after?.scrollTop,
    controlStillOffered: await control.isVisible(),
  };
  note(`${label}-load-earlier`, measurement);
  return measurement;
}

/**
 * The row that was first on screen is still on screen after the click. When
 * the page put rows above it, the list must also have moved off the top: a
 * list that keeps its offset shows the loaded page and pushes the reader's
 * row down by the page's height, which short rows alone can keep on screen.
 */
function expectPlaceHeld(measured: Awaited<ReturnType<typeof loadEarlierOnce>>, label: string) {
  expect(measured.anchorStop, `${label}: no observable trail tool to anchor`).toBeDefined();
  expect(measured.anchorAfter?.visible, `${label}: lost the reader's place`).toBe(true);
  expect(
    Math.abs(measured.anchorAfter!.offset - measured.anchorOffsetBefore!),
    `${label}: the original tool moved within the viewport`,
  ).toBeLessThanOrEqual(8);
  const landedAbove =
    measured.anchorAfter !== null &&
    measured.anchorIndexBefore !== undefined &&
    measured.anchorAfter.index > measured.anchorIndexBefore;
  if (landedAbove) {
    expect(
      measured.scrollTopAfter,
      `${label}: stayed at the top of the loaded page`,
    ).toBeGreaterThan(0);
  }
}

/** Scrolls up through everything loaded and returns the first row's text. */
async function oldestRenderedText(page: Page, list: Locator): Promise<string> {
  await expect
    .poll(
      async () => {
        await wheelUp(page, list);
        await page.waitForTimeout(150);
        return list.evaluate((element) => Math.round(element.scrollTop));
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(0);
  return list
    .locator('[data-chat-message-index="0"]')
    .first()
    .innerText({ timeout: 15_000 })
    .catch(() => "");
}

/** Expands the rendered tool row that read `stop` and waits for its output. */
async function expandStop(list: Locator, trail: Trail, stop: number): Promise<void> {
  const name = trail.files[stop - 1]!.replace(".txt", "");
  // A folded tool group shows only its newest call; open the rendered ones so
  // the stop's own row is reachable.
  const folded = list.getByRole("button", { name: /^Show \d+ tool calls:/ });
  for (let opened = 0; opened < 20 && (await folded.count()) > 0; opened += 1) {
    await folded.first().click();
  }
  const trigger = list.getByRole("button").filter({ hasText: name }).first();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await expect(list.getByText(`Trail stop ${stop} of ${trail.stops}.`).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function openApp(page: Page, status: Status, fixture: Project, environmentName: string) {
  await page.goto(status.browserUrl!);
  const expand = page.getByRole("button", { name: `Expand project ${fixture.name}` });
  const entry = page.getByText(environmentName, { exact: true }).first();
  await expect(expand.or(entry)).toBeVisible({ timeout: 60_000 });
  for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    if (await button.isVisible()) await button.click();
  }
  if (await expand.isVisible()) await expand.click();
  await page.mouse.move(1100, 20);
  await entry.click({ timeout: 15_000 });
}

async function connect(page: Page) {
  const status = profileStatus();
  const invoke = await signIn(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
  return { status, invoke, fixture: fixture! };
}

async function createEnvironment(
  invoke: Invoke,
  fixture: Project,
  name: string,
): Promise<Environment> {
  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture.id,
    name: `${name}-${Date.now()}`,
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  await invoke("start_environment", { environmentId: environment.id });
  const started = await invoke<Environment>("get_environment", { environmentId: environment.id });
  expect(started.worktreePath).toBeTruthy();
  return started;
}

async function removeEnvironments(invoke: Invoke, environments: Environment[]): Promise<void> {
  for (const environment of environments) {
    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
}

test.describe("live transcript paging", () => {
  test.skip(
    !LIVE_OPT_IN,
    "opt-in live turns against the isolated fixture; set ORKESTRATOR_AGENT_TEST_LIVE_TRANSCRIPT_PAGING=1",
  );

  test("a native conversation pages back past the live window", async ({ page }) => {
    test.setTimeout(TURN_TIMEOUT_MS + 10 * 60_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { status, invoke, fixture } = await connect(page);
    const environments: Environment[] = [];
    try {
      const environment = await createEnvironment(invoke, fixture, "paging-native");
      environments.push(environment);
      const trail = new Trail(NATIVE_STOPS);
      await trail.write(environment.worktreePath!);

      let model = NATIVE_MODEL;
      if (!model) {
        const catalog = await invoke<Array<{ platform: string; id: string; label: string }>>(
          "get_native_agent_model_catalog",
          { environmentId: environment.id },
        );
        model = catalog.find(
          (entry) =>
            entry.platform === NATIVE_PLATFORM &&
            (NATIVE_PLATFORM === "codex" ? /luna/i : /haiku/i).test(`${entry.id} ${entry.label}`),
        )?.id;
      }
      note("native-model", `${NATIVE_PLATFORM} ${model ?? "provider default"}`);
      const tabId = "paging-native-tab";
      const identity = {
        environmentId: environment.id,
        agent: NATIVE_PLATFORM,
        logicalSessionKey: `env-${environment.id}:${tabId}`,
      };
      const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: environment.id,
      });
      await invoke("save_pane_layout", {
        environmentId: environment.id,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "paging-pane",
          root: {
            kind: "leaf",
            id: "paging-pane",
            activeTabId: tabId,
            tabs: [
              {
                id: tabId,
                type: "agent-native",
                displayTitle: "Paging qualification",
                nativeAgentData: {
                  environmentId: environment.id,
                  platform: NATIVE_PLATFORM,
                  isLocal: true,
                },
                ...(model ? { initialAgentModel: model } : {}),
              },
            ],
          },
        },
      });

      const snapshot = () =>
        invoke<ProjectionUpdate>("get_native_agent_projection_update", {
          ...identity,
          syncVersion: 1,
          liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
          forceSnapshot: true,
        });
      /** Every row of the conversation, oldest first: the cursor's pages, then the tail. */
      const wholeTranscript = async () => {
        const live = await snapshot();
        expect(live.status).toBe("snapshot");
        const tail = live.projection!.messages;
        const pages: Row[][] = [];
        let cursor = live.historyCursor;
        let complete = live.historyComplete ?? false;
        while (cursor) {
          const page = await invoke<MessagePage>("get_native_agent_message_page", {
            ...identity,
            syncVersion: 1,
            before: cursor,
            limit: API_PAGE_MESSAGES,
          });
          expect(page.historyEpoch, "the history epoch moved while paging").toBe(live.historyEpoch);
          expect(page.messages.length).toBeLessThanOrEqual(API_PAGE_MESSAGES);
          pages.unshift(page.messages);
          expect(pages.length, "paging did not terminate").toBeLessThan(50);
          complete = page.complete;
          cursor = page.nextCursor;
        }
        return { live, tail, pages, complete, rows: [...pages.flat(), ...tail] };
      };

      await openApp(page, status, fixture, environment.name);
      const composeBar = page.getByTestId("shared-native-compose-bar");
      const composer = composeBar.getByRole("textbox", {
        name: new RegExp(`^Message ${NATIVE_LABEL}`),
      });
      const sendButton = composeBar.getByRole("button", { name: "Send", exact: true });
      const send = async (prompt: string) => {
        await expect(composer).toBeVisible({ timeout: 90_000 });
        await composer.fill(prompt);
        await expect(sendButton).toBeEnabled({ timeout: 90_000 });
        await composer.press("Enter");
        await expect(composer).toHaveText("", { timeout: 30_000 });
      };
      const waitForIdle = async () => {
        let settled: ProjectionUpdate | undefined;
        await page.waitForTimeout(3_000);
        await expect
          .poll(
            async () => {
              settled = await snapshot();
              const turn = settled.projection?.turn;
              if (turn?.phase === "error") {
                throw new Error(`${NATIVE_LABEL} turn failed: ${turn.error ?? "no error"}`);
              }
              return turn?.phase;
            },
            { timeout: TURN_TIMEOUT_MS, intervals: [5_000] },
          )
          .toBe("idle");
        return settled!;
      };

      // Claude reads with its Read tool, one response per read, and the
      // tool-only rows coalesce into tall per-minute blocks: the harder case
      // for holding the reader's place. Codex reads with `cat` and notes each
      // stop in a sentence; with notes off the run is tool calls only, and each
      // response still gets its own row from the bridge's usage report.
      const firstPrompt = [
        `This repository contains a trail of text files. It starts at ${trail.start}.`,
        "Each file names the next file. Follow the trail to its end.",
        ...(NATIVE_PLATFORM === "codex" && CODEX_STEP_NOTES
          ? [
              "Rules: read exactly one file per step with a single `cat` of that one file, wait",
              "for its result, then write one short sentence saying which stop you reached before",
              "reading the next. Never read several files at once, and never list, search or glob",
              "the directory.",
            ]
          : NATIVE_PLATFORM === "codex"
            ? [
                "Rules: read exactly one file per step with a single `cat` of that one file and wait",
                "for its result before reading the next. Write nothing between steps. Never read",
                "several files at once, and never list, search or glob the directory.",
              ]
            : [
                "Rules: read exactly one file per response with your file-reading tool, wait for its",
                "result before reading the next, never read several files at once, and never list,",
                "search or glob the directory or run shell commands. Do not summarise along the way.",
              ]),
        "When you reach the file that ends the trail, reply with only its closing word.",
      ].join(" ");
      await send(firstPrompt);
      let settled = await waitForIdle();
      for (let attempt = 0; attempt < MAX_CONTINUATIONS; attempt += 1) {
        const { rows } = await wholeTranscript();
        const reachedEnd = rows.some(
          (row) => row.role === "assistant" && rowText(row).includes(trail.closingWord),
        );
        if (reachedEnd) break;
        note("native-continuation", `${attempt + 1}`);
        await send(
          "Continue following the trail from the last file you read, one file per response, until it ends. Then reply with only the closing word.",
        );
        settled = await waitForIdle();
      }

      // Backend truth: a bounded live window that says history is incomplete.
      const whole = await wholeTranscript();
      const order = trail.verifyOrder(whole.rows, "native");
      note("native-transcript", {
        rows: whole.rows.length,
        tail: whole.tail.length,
        apiPages: whole.pages.map((rows) => rows.length),
        complete: whole.complete,
        messageWindow: settled.projection?.messageWindow,
        ...order,
      });
      expect(order.highest, `${NATIVE_LABEL} never reached the end of the trail`).toBe(trail.stops);
      expect(whole.rows.length).toBeGreaterThan(LIVE_WINDOW);
      expect(whole.tail.length).toBeLessThanOrEqual(LIVE_WINDOW);
      expect(whole.live.historyCursor, "a window past the live limit offers a cursor").toBeTruthy();
      expect(whole.pages.length, "the cursor was followed more than once").toBeGreaterThan(1);
      expect(whole.complete, "paging reached the start of the conversation").toBe(true);
      expect(rowText(whole.rows[0]!)).toContain(trail.start);
      const deferred = findDeferredTool(trail, whole.pages.flat(), 2);
      expect(deferred, "paged native history must contain a deferred trail body").toBeDefined();
      expect(deferred!.stop, "the oversized stop 2 body must be deferred").toBe(2);
      const details = await invoke<{ toolOutput?: string; toolError?: string }>(
        "get_native_agent_tool_details",
        {
          ...identity,
          detailRef: deferred!.detailRef,
        },
      );
      note("native-detail", {
        stop: deferred!.stop,
        bytes: expectDeferredTrailBody(trail, deferred!.stop, details),
        resolved: true,
      });
      const firstStopInTail = Math.min(...whole.tail.flatMap((row) => trail.stopsRead(row)));
      expect(firstStopInTail, "the tail alone cannot show the start").toBeGreaterThan(1);

      // A tab mounted through the whole turn may have retained every row as
      // the live window advanced. Start from a fresh bounded snapshot so the
      // click actually prepends history instead of just retiring its cursor.
      await page.reload();
      await openApp(page, status, fixture, environment.name);
      // Browser: Load earlier messages brings the start back and keeps the reader's place.
      const list = scroller(page);
      await expect(list).toBeVisible({ timeout: 30_000 });
      const verifyBrowserPaging = async (label: string) => {
        const control = page.getByRole("button", { name: "Load earlier messages", exact: true });
        const clicks: Awaited<ReturnType<typeof loadEarlierOnce>>[] = [];
        for (let click = 0; click < 10; click += 1) {
          await wheelUp(page, list);
          await page.waitForTimeout(300);
          if (click > 0 && !(await control.isVisible())) break;
          clicks.push(await loadEarlierOnce(page, list, trail, `${label}-${click + 1}`));
        }
        expect(clicks.length).toBeGreaterThan(0);
        for (const measured of clicks) {
          expectPlaceHeld(measured, label);
        }
        const oldest = await oldestRenderedText(page, list);
        expect(oldest, `${label}: the first prompt is not the oldest row`).toContain(trail.start);
        // A tool row from the loaded history expands to its deferred output.
        await expandStop(list, trail, 2);
      };
      await verifyBrowserPaging("native");

      await page.reload();
      await openApp(page, status, fixture, environment.name);
      await expect(scroller(page)).toBeVisible({ timeout: 30_000 });
      await verifyBrowserPaging("native-after-reload");
    } finally {
      await removeEnvironments(invoke, environments);
    }
  });

  test("Multi Review reviewers page back past the live window", async ({ page }) => {
    test.setTimeout(TURN_TIMEOUT_MS + 15 * 60_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { status, invoke, fixture } = await connect(page);
    const environments: Environment[] = [];
    let workflowId: string | undefined;
    try {
      const environment = await createEnvironment(invoke, fixture, "paging-review");
      environments.push(environment);
      const trail = new Trail(REVIEW_STOPS);
      await trail.write(environment.worktreePath!);
      const protocol = [
        "# Review protocol",
        "",
        "This applies only to a reviewer: a session asked to review a change and report findings.",
        "Preparation, consolidation and fix sessions must ignore it.",
        "",
        `Before reviewing anything, a reviewer must walk the audit trail that starts at \`${trail.start}\`.`,
        "Each file names the next file. Read exactly one trail file per response with your",
        "file-reading tool (or a single `cat` of that one file), wait for its result, then read",
        "the next. After each trail file, write one short sentence saying which stop you reached",
        "before you read the next one. Never read several trail files at once and never list,",
        "search or glob the trail directory. Keep going until the file that ends the trail,",
        "then review the change.",
        "The trail itself is not part of the change and has no findings.",
        "",
      ].join("\n");
      // Codex loads AGENTS.md as instructions. A Claude reviewer runs read-only
      // without project instructions (READ_ONLY_TURN_POLICY), so it meets the
      // protocol as part of the change it reviews; the trail stays untracked.
      await fs.writeFile(path.join(environment.worktreePath!, "AGENTS.md"), protocol);
      // A small change with one real defect, so reviewers have something to report.
      await fs.writeFile(
        path.join(environment.worktreePath!, "discount.ts"),
        [
          "// Reviewers: follow the review protocol in AGENTS.md before reviewing this file.",
          "/** Applies a percentage discount to a price in cents. */",
          "export function applyDiscount(priceCents: number, percent: number): number {",
          "  if (percent > 100) throw new Error('percent must be at most 100');",
          "  return priceCents - priceCents * percent;",
          "}",
          "",
        ].join("\n"),
      );

      // Launch through the real launcher, as the live Multi Review spec does.
      await openApp(page, status, fixture, environment.name);
      const launcher = page.getByRole("button", { name: "Multi Review", exact: true });
      await expect(launcher).toBeEnabled({ timeout: 60_000 });
      await launcher.click({ button: "right" });
      const dialog = page.getByRole("dialog", { name: "Configure Multi Review" });
      await expect(dialog).toBeVisible();
      const chooseModel = async (row: string, platform: string, label: string, effort?: string) => {
        const trigger = page.getByRole("button", { name: `${row} model`, exact: true });
        const menu = page.locator("[data-native-model-picker]");
        await trigger.click();
        await menu.getByRole("button", { name: `${platform} models`, exact: true }).click();
        await menu
          .getByRole("group", { name: "Models" })
          .getByRole("menuitemradio", {
            name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
          })
          .first()
          .click();
        if (effort) {
          if (!(await menu.isVisible())) await trigger.click();
          await menu
            .getByRole("group", { name: "Reasoning" })
            .getByRole("menuitemradio", { name: effort, exact: true })
            .click();
        }
        if (await menu.isVisible()) await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
      };
      if (FIRST_REVIEWER_CODEX) {
        await chooseModel("Reviewer 1", "codex", REVIEW_CODEX_MODEL, "Medium");
      } else {
        await chooseModel("Reviewer 1", "claude", REVIEW_CLAUDE_MODEL);
      }
      await chooseModel("Reviewer 2", "codex", REVIEW_CODEX_MODEL, "Low");
      await chooseModel("Preparation & consolidation model", "codex", REVIEW_CODEX_MODEL, "Low");
      await chooseModel("Fix model", "codex", REVIEW_CODEX_MODEL, "Low");
      await dialog.getByRole("button", { name: "Start 2-model review", exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      const workflows = await invoke<Array<{ id: string; snapshot: MultiReviewWorkflow }>>(
        "list_multi_review_workflows",
        { environmentId: environment.id },
      );
      expect(workflows).toHaveLength(1);
      workflowId = workflows[0]!.id;
      const read = async () =>
        (
          await invoke<{ snapshot: MultiReviewWorkflow }>("get_multi_review_workflow", {
            workflowId,
          })
        ).snapshot;

      // Progress probes: while reviewers walk the trail, none may be flagged
      // as stalled, and one that runs past a few probe intervals must show
      // its progress clock advancing.
      const digests = new Map<string, Set<string>>();
      const progressTimes = new Map<string, Set<string>>();
      const running = new Map<string, { first: number; last: number }>();
      const stalls: string[] = [];
      let workflow: MultiReviewWorkflow | undefined;
      await expect
        .poll(
          async () => {
            workflow = await read();
            for (const reviewer of workflow.reviewers) {
              if (reviewer.status !== "running") continue;
              const span = running.get(reviewer.id);
              running.set(reviewer.id, { first: span?.first ?? Date.now(), last: Date.now() });
              if (reviewer.progressDigest) {
                const seen = digests.get(reviewer.id) ?? new Set<string>();
                seen.add(reviewer.progressDigest);
                digests.set(reviewer.id, seen);
              }
              if (reviewer.progressAt) {
                const seen = progressTimes.get(reviewer.id) ?? new Set<string>();
                seen.add(reviewer.progressAt);
                progressTimes.set(reviewer.id, seen);
              }
              if (reviewer.stalledSince) stalls.push(`${reviewer.agent}:${reviewer.stalledSince}`);
            }
            return SETTLED_PHASES.has(workflow.phase);
          },
          { timeout: TURN_TIMEOUT_MS, intervals: [2_000] },
        )
        .toBe(true);
      const settled = workflow!;
      const runningMs = (id: string) => {
        const span = running.get(id);
        return span ? span.last - span.first : 0;
      };
      note("review-settled", {
        phase: settled.phase,
        error: settled.error,
        reviewers: settled.reviewers.map((reviewer) => ({
          agent: reviewer.agent,
          status: reviewer.status,
          error: reviewer.error,
          distinctProgressDigests: digests.get(reviewer.id)?.size ?? 0,
          distinctProgressTimes: progressTimes.get(reviewer.id)?.size ?? 0,
          runningSeconds: runningMs(reviewer.id) / 1_000,
        })),
        stalls,
      });
      expect(settled.phase, settled.error ?? "").toBe("ready");
      expect(stalls, "a reviewer walking the trail was reported stalled").toEqual([]);

      const longReviewers: Array<{ index: number; reviewerId: string; agent: string }> = [];
      for (const [index, reviewer] of settled.reviewers.entries()) {
        expect(reviewer.status, `reviewer ${index + 1}: ${reviewer.error ?? ""}`).toBe("completed");
        const transcript = await invoke<ReviewerTranscript>(
          "get_multi_review_reviewer_transcript",
          { workflowId, reviewerId: reviewer.id },
        );
        expect(transcript.fallback ?? false).toBe(false);
        expect(transcript.messages.length).toBeLessThanOrEqual(LIVE_WINDOW);
        if (transcript.sourceToken) {
          const again = await invoke<ReviewerTranscript>("get_multi_review_reviewer_transcript", {
            workflowId,
            reviewerId: reviewer.id,
            knownSourceToken: transcript.sourceToken,
          });
          expect(again.transcript).toBe("unchanged");
          expect(again.messages).toHaveLength(0);
        }
        const pages: Row[][] = [];
        let cursor = transcript.historyCursor;
        let complete = !transcript.truncated;
        while (cursor) {
          const page = await invoke<ReviewerPage>("get_multi_review_reviewer_history_page", {
            workflowId,
            reviewerId: reviewer.id,
            before: cursor,
            limit: API_PAGE_MESSAGES,
          });
          expect(page.status, JSON.stringify(page.status === "expired" ? page : {})).toBe("page");
          if (page.status !== "page") break;
          expect(page.historyEpoch).toBe(transcript.historyEpoch);
          pages.unshift(page.messages);
          expect(pages.length, "reviewer paging did not terminate").toBeLessThan(50);
          complete = page.complete;
          cursor = page.nextCursor;
        }
        const rows = [...pages.flat(), ...transcript.messages];
        const order = trail.verifyOrder(rows, `reviewer ${index + 1}`);
        note(`reviewer-${index + 1}-${reviewer.agent}-transcript`, {
          rows: rows.length,
          tail: transcript.messages.length,
          truncated: transcript.truncated,
          apiPages: pages.map((page) => page.length),
          complete,
          ...order,
        });
        // Probes run once per probe interval (60 s by default): the first
        // sets the baseline, and a later one must see the walk move.
        if (runningMs(reviewer.id) >= PROGRESS_EVIDENCE_MS) {
          expect(
            progressTimes.get(reviewer.id)?.size ?? 0,
            `reviewer ${index + 1} progress never moved`,
          ).toBeGreaterThan(1);
        }
        if (rows.length <= LIVE_WINDOW) continue;
        expect(order.highest, `reviewer ${index + 1} never reached the final trail stop`).toBe(
          trail.stops,
        );
        expect(transcript.historyCursor, "a long reviewer offers a cursor").toBeTruthy();
        expect(complete, "reviewer paging reached the first prompt").toBe(true);
        expect(rows[0]!.role, "the oldest reviewer row is its prompt").toBe("user");
        // A deferred tool body from paged history resolves on expansion.
        const deferred = findDeferredTool(trail, pages.flat(), 2);
        expect(
          deferred,
          `reviewer ${index + 1}: paged history must contain a deferred trail body`,
        ).toBeDefined();
        expect(deferred!.stop, "the oversized stop 2 body must be deferred").toBe(2);
        const details = await invoke<{ toolOutput?: string; toolError?: string }>(
          "get_multi_review_reviewer_tool_details",
          { workflowId, reviewerId: reviewer.id, detailRef: deferred!.detailRef },
        );
        note(`reviewer-${index + 1}-detail`, {
          stop: deferred!.stop,
          bytes: expectDeferredTrailBody(trail, deferred!.stop, details),
          resolved: true,
        });
        longReviewers.push({ index, reviewerId: reviewer.id, agent: reviewer.agent });
      }
      expect(
        longReviewers.length,
        "no reviewer's transcript outgrew the live window",
      ).toBeGreaterThan(0);

      // Browser: the reviewer tab's Load earlier messages, per long reviewer.
      for (const [visit, { index }] of longReviewers.entries()) {
        if (visit > 0) {
          // Back to the Multi Review pane tab before opening the next reviewer.
          await page
            .locator('[aria-roledescription="sortable"]')
            .filter({ has: page.getByRole("button", { name: /^Close Multi Review\b/ }) })
            .first()
            .click();
        }
        const pipeline = page.getByRole("tablist", { name: "Multi Review pipeline" }).first();
        await expect(pipeline).toBeVisible({ timeout: 30_000 });
        await pipeline.getByRole("tab", { name: new RegExp(`^Reviewer ${index + 1} · `) }).click();
        await page
          .getByTestId("multi-review-inspector")
          .getByRole("button", { name: new RegExp(`^Open Reviewer ${index + 1} transcript`) })
          .click();
        await expect(
          page
            .getByText(/· Read only$/)
            .filter({ visible: true })
            .first(),
        ).toBeVisible({ timeout: 30_000 });
        const list = scroller(page);
        await expect(list).toBeVisible({ timeout: 30_000 });
        const label = `reviewer-${index + 1}`;
        const control = page.getByRole("button", { name: "Load earlier messages", exact: true });
        const clicks: Awaited<ReturnType<typeof loadEarlierOnce>>[] = [];
        for (let click = 0; click < 10; click += 1) {
          await wheelUp(page, list);
          await page.waitForTimeout(300);
          if (click > 0 && !(await control.isVisible())) break;
          clicks.push(await loadEarlierOnce(page, list, trail, `${label}-${click + 1}`));
        }
        expect(clicks.length, `${label}: reviewer paging must run`).toBeGreaterThan(0);
        for (const measured of clicks) {
          expectPlaceHeld(measured, label);
        }
        const oldest = await oldestRenderedText(page, list);
        note(`${label}-oldest-row`, { isPrompt: !trail.stopInText(oldest) });
        await expandStop(list, trail, 2);
      }
    } finally {
      if (workflowId) {
        await invoke("cancel_multi_review", { workflowId }).catch(() => undefined);
      }
      await removeEnvironments(invoke, environments);
    }
  });
});

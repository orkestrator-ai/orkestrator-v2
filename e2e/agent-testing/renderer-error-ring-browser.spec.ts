import { acknowledgeDockerReachabilityWarning } from "../docker-reachability-warning";
import { expect, test, type Page } from "./browser-test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * A browser tab's renderer error ring reaches the essential log of the backend
 * it is signed in to (to-do 6300 task 2), against the running profile: a real
 * uncaught error in the signed-in tab becomes one `renderer-errors`
 * `error.recorded` line with route `browser` and the five content-free fields,
 * and one tab's writes are held to its own share of the minute. A tab opened
 * from it, which starts with a copy of its session storage, takes its own id
 * and so its own share; a reload keeps the id. Nothing the error said, and no
 * client id, reaches the file.
 */

type Status = { status: string; browserUrl?: string; dataDir?: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const SECRET = "synthetic-private-browser-ring";
/** `RENDERER_ERROR_CLIENT_KEY` in apps/web/src/lib/renderer-error-client.ts. */
const CLIENT_KEY = "orkestrator:renderer-error-client";
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function profileCommand<T>(command: string): T {
  const result = spawnSync("mise", ["run", command, "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!result.stdout.trim()) throw new Error(`${command} returned nothing`);
  return JSON.parse(result.stdout) as T;
}

async function signIn(page: Page): Promise<void> {
  // Each attempt needs its own single-use link; a first navigation can be
  // aborted by a network change (flake 2340).
  await expect(async () => {
    const { loginUrl } = profileCommand<{ loginUrl: string }>("dev:login");
    await page.goto(loginUrl, { timeout: 60_000 });
    await expect(
      page.getByRole("button", { name: /^(Expand|Collapse) project / }).first(),
    ).toBeVisible({ timeout: 60_000 });
  }).toPass({ timeout: 180_000 });
}

/** Through the tab's own gateway, as the uploader sends. */
function pageInvoke(page: Page): Invoke {
  return (command, args = {}) =>
    page.evaluate(
      ({ command, args }) =>
        (
          window as unknown as {
            orkestrator: { invoke(command: string, args: unknown): Promise<never> };
          }
        ).orkestrator.invoke(command, args),
      { command, args },
    );
}

type EssentialRecord = { area?: string; event?: string; fields?: Record<string, unknown> };

function records(text: string): EssentialRecord[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as EssentialRecord];
      } catch {
        return [];
      }
    });
}

test.beforeEach(async ({ page }) => acknowledgeDockerReachabilityWarning(page));

test("a browser tab sends its error ring to its backend's essential log, within its share", async ({
  page,
}) => {
  test.setTimeout(480_000);
  const status = profileCommand<Status>("dev:status");
  expect(status.status).toBe("ready");
  if (!status.dataDir) throw new Error("The profile reports no data directory");
  const essentialFile = path.join(status.dataDir, "logs", "essential", "essential.jsonl");
  const essential = () => readFile(essentialFile, "utf8").catch(() => "");
  const browserEntries = async () =>
    records(await essential()).filter(
      (record) =>
        record.area === "renderer-errors" &&
        record.event === "error.recorded" &&
        record.fields?.route === "browser",
    );
  const before = (await browserEntries()).length;

  await signIn(page);
  // A browser tab, not a desktop window: the route the ring records.
  expect(
    await page.evaluate(() => {
      const gateway = (window as { orkestratorGateway?: { enabled?: boolean; desktop?: boolean } })
        .orkestratorGateway;
      return Boolean(gateway?.enabled && !gateway.desktop);
    }),
  ).toBe(true);

  // A real uncaught error, caught by the page's own `error` handler.
  await page.evaluate((secret) => {
    setTimeout(() => {
      throw new TypeError(secret);
    }, 0);
  }, SECRET);
  await expect
    .poll(async () => (await browserEntries()).length, { timeout: 90_000 })
    .toBeGreaterThan(before);
  const entry = (await browserEntries()).at(-1)!;
  expect(Object.keys(entry.fields ?? {}).sort()).toEqual([
    "boundary",
    "count",
    "errorClass",
    "fingerprint",
    "route",
  ]);
  expect(entry.fields).toMatchObject({ errorClass: "TypeError", boundary: "window" });
  expect(await essential()).not.toContain(SECRET);

  // A tab opened from this one starts with a copy of its session storage, id
  // included, and must take an id of its own.
  const storedId = (target: Page) =>
    target.evaluate((key) => sessionStorage.getItem(key), CLIENT_KEY);
  const parentId = await storedId(page);
  expect(parentId).toMatch(ID_PATTERN);
  await page.evaluate(() => sessionStorage.setItem("renderer-ring-copy-probe", "copied"));
  const [child] = await Promise.all([
    page.context().waitForEvent("page"),
    page.evaluate(() => void window.open(location.href)),
  ]);
  await child.waitForLoadState("domcontentloaded");
  // Proves the browser copied the storage, so the case below is the real one.
  expect(await child.evaluate(() => sessionStorage.getItem("renderer-ring-copy-probe"))).toBe(
    "copied",
  );
  await expect.poll(() => storedId(child), { timeout: 60_000 }).toMatch(ID_PATTERN);
  const childId = (await storedId(child))!;
  expect(childId).not.toBe(parentId);

  // A reload of the same tab keeps its id.
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^(Expand|Collapse) project / }).first(),
  ).toBeVisible({ timeout: 60_000 });
  expect(await storedId(page)).toBe(parentId);

  // Each tab's share, on the real transport. A minute some other write already
  // used cannot show it, so wait for a fresh one: a write 61 s after the last
  // starts a new minute. Fresh fingerprints keep these apart from the uploader's.
  const invoke = pageInvoke(page);
  let attempt = 0;
  const batch = (length: number) => {
    attempt += 1;
    return Array.from({ length }, (_, index) => ({
      errorClass: "Error",
      boundary: "boundary",
      route: "browser",
      fingerprint: (0xe0000000 + attempt * 32 + index).toString(16),
      count: 1,
    }));
  };
  type Result = { accepted: number; dropped: number };
  let share: Record<string, Result> = {};
  await expect(async () => {
    // A lone tab has a full batch of 20 logged...
    const burst = await invoke<Result>("record_renderer_errors", {
      entries: batch(20),
      client: parentId,
    });
    expect(burst).toEqual({ accepted: 20, dropped: 0 });
    // ...and no more, so the minute keeps room for another renderer...
    const over = await invoke<Result>("record_renderer_errors", {
      entries: batch(10),
      client: parentId,
    });
    // ...which the tab opened from it has, under its own id.
    const other = await invoke<Result>("record_renderer_errors", {
      entries: batch(10),
      client: childId,
    });
    share = { burst, over, other };
  }).toPass({ intervals: [61_000], timeout: 200_000 });
  expect(share.over).toEqual({ accepted: 0, dropped: 10 });
  expect(share.other).toEqual({ accepted: 10, dropped: 0 });
  const written = await essential();
  expect(written).not.toContain(parentId!);
  expect(written).not.toContain(childId);
  await child.close();
  await test.info().attach("renderer-error-ring-browser", {
    body: JSON.stringify({ entry: entry.fields, share }),
    contentType: "application/json",
  });
});

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
 * and one tab's writes are held to its own share of the minute. Nothing the
 * error said, and no client id, reaches the file.
 */

type Status = { status: string; browserUrl?: string; dataDir?: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const SECRET = "synthetic-private-browser-ring";

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
  test.setTimeout(300_000);
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

  // One renderer's writes stop at its share while the minute still has room
  // for others. Fresh fingerprints keep these apart from the uploader's.
  const invoke = pageInvoke(page);
  const batch = (seed: number) =>
    Array.from({ length: 10 }, (_, index) => ({
      errorClass: "Error",
      boundary: "boundary",
      route: "browser",
      fingerprint: (0xe0000000 + seed * 16 + index).toString(16),
      count: 1,
    }));
  const client = `share-probe-${Date.now().toString(36)}`;
  const first = await invoke<{ accepted: number; dropped: number }>("record_renderer_errors", {
    entries: batch(1),
    client,
  });
  expect(first.accepted + first.dropped).toBe(10);
  expect(
    await invoke<{ accepted: number; dropped: number }>("record_renderer_errors", {
      entries: batch(2),
      client,
    }),
  ).toEqual({ accepted: 0, dropped: 10 });
  expect(await essential()).not.toContain(client);
  await test.info().attach("renderer-error-ring-browser", {
    body: JSON.stringify({ entry: entry.fields, share: first }),
    contentType: "application/json",
  });
});

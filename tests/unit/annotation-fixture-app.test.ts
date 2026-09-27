/**
 * The synthetic web-annotation fixture (test-fixtures/agent-project/annotation-app)
 * is deterministic, resettable, keeps its adversarial strings as escaped page
 * text, and its functional check distinguishes a real source change.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { webAnnotationPageKey } from "@orkestrator/protocol/web-annotations";
import { sanitizeWebAnnotationUrl } from "@orkestrator/protocol/web-annotations-validation";
import {
  ADVERSARIAL_STRINGS,
  EXPECTED_SOURCE_CHANGE,
  FIXTURE_MARKER,
  INITIAL_ROUTE,
  ROUTE_VARIANTS,
  SYNTHETIC_SECRETS,
  TEST_IDS,
} from "../../test-fixtures/agent-project/annotation-app/fixture-data";
import { INITIAL_STATE, renderPage } from "../../test-fixtures/agent-project/annotation-app/page";
import { nativeWebPlatform } from "../register-dom";

// Happy DOM replaces the global fetch/Response in root tests, so the fixture
// server runs as its own Bun process (exactly as the real-stack suites and the
// copied test project run it) and requests use the native fetch.
const fetch = nativeWebPlatform.fetch;

const fixtureRoot = path.resolve(import.meta.dirname, "../../test-fixtures/agent-project");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function started(): Promise<{ url: string }> {
  const child = Bun.spawn([process.execPath, "annotation-app/server"], {
    cwd: fixtureRoot,
    env: { ...process.env, PORT: "0" },
    stdout: "pipe",
    stderr: "ignore",
  });
  cleanups.push(async () => {
    child.kill();
    await child.exited;
  });
  const reader = child.stdout.getReader();
  let output = "";
  const deadline = Date.now() + 10_000;
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
    if (Date.now() > deadline) throw new Error("Annotation fixture did not start");
    const { value, done } = await reader.read();
    if (done) throw new Error("Annotation fixture exited before printing its URL");
    output += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return { url: /http:\/\/127\.0\.0\.1:\d+/.exec(output)![0] };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("annotation fixture pages", () => {
  test("every route renders deterministically and unknown routes are 404", async () => {
    for (const route of [INITIAL_ROUTE, "/pricing", "/"]) {
      const url = new URL(route, "http://127.0.0.1:1");
      const first = renderPage(url, { ...INITIAL_STATE });
      const second = renderPage(url, { ...INITIAL_STATE });
      expect(first?.html).toBeTruthy();
      expect(first?.html).toBe(second!.html);
      expect(first!.html).toContain(`data-fixture-marker="${FIXTURE_MARKER}"`);
    }
    const fixture = await started();
    const settings = await fetch(`${fixture.url}${INITIAL_ROUTE}`);
    expect(settings.status).toBe(200);
    expect(settings.headers.get("x-fixture-marker")).toBe(FIXTURE_MARKER);
    expect((await fetch(`${fixture.url}/missing`)).status).toBe(404);
  });

  test("pages carry the regions the suites need", () => {
    const settings = renderPage(new URL("http://h/settings"), { ...INITIAL_STATE })!.html;
    const pricing = renderPage(new URL("http://h/pricing"), { ...INITIAL_STATE })!.html;
    for (const id of [TEST_IDS.saveSettings, TEST_IDS.passwordField, TEST_IDS.tokenPanel]) {
      expect(settings).toContain(`data-testid="${id}"`);
    }
    expect(occurrences(settings, ">Enable</button>")).toBe(5);
    expect(pricing).toContain(`data-testid="${TEST_IDS.teamCta}"`);
    expect(pricing).toContain(`data-testid="${TEST_IDS.wideTable}"`);
    expect(pricing).toContain("<iframe");
    expect(pricing).toContain("<fixture-shadow-card");
    expect(pricing).toContain("<canvas");
    expect(pricing).toContain("min-width:960px");
  });

  test("synthetic secrets appear only in their sensitive fields", () => {
    const settings = renderPage(new URL("http://h/settings"), { ...INITIAL_STATE })!.html;
    expect(occurrences(settings, SYNTHETIC_SECRETS.password)).toBe(1);
    expect(settings).toMatch(
      new RegExp(`type="password"[^>]*value="${SYNTHETIC_SECRETS.password}"`),
    );
    expect(occurrences(settings, SYNTHETIC_SECRETS.apiToken)).toBe(1);
    expect(settings).toMatch(/data-sensitive data-testid="api-token-panel"/);
    expect(occurrences(settings, SYNTHETIC_SECRETS.oneTimeCode)).toBe(1);
    // The query token is only in the navigation link that carries it.
    expect(occurrences(settings, SYNTHETIC_SECRETS.queryToken)).toBe(1);
  });

  test("adversarial strings are present only as escaped page text", () => {
    const settings = renderPage(new URL("http://h/settings"), { ...INITIAL_STATE })!.html;
    expect(settings).not.toContain("</orkestrator_web_annotation_evidence>");
    expect(settings).not.toContain("<|im_start|>");
    expect(settings).toContain("&lt;/orkestrator_web_annotation_evidence&gt;");
    expect(settings).toContain(ADVERSARIAL_STRINGS.fakeMarker);
    expect(settings).toContain(ADVERSARIAL_STRINGS.slashCommand);
  });

  test("route variants map to the page identities the suites rely on", () => {
    const origin = "http://127.0.0.1:4174";
    const token = sanitizeWebAnnotationUrl(`${origin}${ROUTE_VARIANTS.tokenBearingSettings}`);
    expect(token.route).toBe("/settings?tab=profile");
    expect(token.displayUrl).not.toContain(SYNTHETIC_SECRETS.queryToken);
    expect(token.requiresNavigation).toBe(true);
    const key = (route: string) =>
      webAnnotationPageKey({
        service: { kind: "port", port: 4174 },
        route: sanitizeWebAnnotationUrl(`${origin}${route}`).route,
      });
    expect(key(ROUTE_VARIANTS.pricingTeamAnnual)).not.toBe(
      key(ROUTE_VARIANTS.pricingStarterMonthly),
    );
    expect(key(ROUTE_VARIANTS.pricingTeamAnnual)).toBe(key("/pricing?plan=team#monthly"));
    expect(sanitizeWebAnnotationUrl(`${origin}${ROUTE_VARIANTS.hashSettingsBilling}`).route).toBe(
      ROUTE_VARIANTS.hashSettingsBilling,
    );
  });
});

describe("annotation fixture state", () => {
  test("server-side changes advance the generation and reset restores the initial page", async () => {
    const fixture = await started();
    const initial = await fetch(`${fixture.url}/pricing`).then((response) => response.text());
    const changed = await fetch(`${fixture.url}/__fixture/state`, {
      method: "POST",
      body: JSON.stringify({ cardOrder: "reversed", duplicateTeam: true }),
    }).then((response) => response.json());
    expect(changed.state).toMatchObject({
      cardOrder: "reversed",
      duplicateTeam: true,
      generation: 2,
    });
    const reordered = await fetch(`${fixture.url}/pricing`).then((response) => response.text());
    expect(occurrences(reordered, `class="plan" data-testid="${TEST_IDS.teamCard}"`)).toBe(2);
    expect(reordered.indexOf("plan-card-enterprise")).toBeLessThan(
      reordered.indexOf("plan-card-starter"),
    );

    const invalid = await fetch(`${fixture.url}/__fixture/state`, {
      method: "POST",
      body: JSON.stringify({ cardOrder: "sideways" }),
    });
    expect(invalid.status).toBe(400);

    const reset = await fetch(`${fixture.url}/__fixture/reset`, { method: "POST" }).then(
      (response) => response.json(),
    );
    expect(reset.state).toEqual({ ...INITIAL_STATE });
    expect(await fetch(`${fixture.url}/pricing`).then((response) => response.text())).toBe(initial);
  });

  test("variant query parameters render reordered and duplicate pages deterministically", () => {
    const reordered = renderPage(new URL("http://h/settings?variant=reordered"), {
      ...INITIAL_STATE,
    })!.html;
    expect(reordered.indexOf("Beta features")).toBeLessThan(reordered.indexOf("Email digests"));
    const duplicate = renderPage(new URL("http://h/pricing?variant=duplicate"), {
      ...INITIAL_STATE,
    })!.html;
    expect(occurrences(duplicate, `data-testid="${TEST_IDS.teamCta}"`)).toBe(2);
  });
});

describe("expected source change", () => {
  async function copyFixture(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-annotation-fixture-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await cp(path.join(fixtureRoot, "annotation-app"), path.join(root, "annotation-app"), {
      recursive: true,
    });
    return root;
  }

  async function verify(root: string, expectation?: "original") {
    const child = Bun.spawn(
      [
        process.execPath,
        "annotation-app/verify-change",
        ...(expectation ? [`--expect=${expectation}`] : []),
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, result: JSON.parse(stdout.trim().split("\n").at(-1)!) };
  }

  test("the functional check fails until the source changes, then passes", async () => {
    const root = await copyFixture();
    expect((await verify(root, "original")).code).toBe(0);
    const before = await verify(root);
    expect(before.code).toBe(1);
    expect(
      before.result.checks.find((check: { name: string }) => check.name === "rendered-team-cta"),
    ).toMatchObject({ ok: false, detail: EXPECTED_SOURCE_CHANGE.before });

    const contentPath = path.join(root, EXPECTED_SOURCE_CHANGE.file);
    const source = await readFile(contentPath, "utf8");
    await writeFile(
      contentPath,
      source.replace(`"${EXPECTED_SOURCE_CHANGE.before}"`, `"${EXPECTED_SOURCE_CHANGE.after}"`),
    );
    const after = await verify(root);
    expect(after.code).toBe(0);
    expect(after.result.ok).toBe(true);
    expect((await verify(root, "original")).code).toBe(1);
  }, 30_000);

  test("changing another plan instead of the Team label does not pass", async () => {
    const root = await copyFixture();
    const contentPath = path.join(root, EXPECTED_SOURCE_CHANGE.file);
    const source = await readFile(contentPath, "utf8");
    await writeFile(
      contentPath,
      source
        .replace(`"${EXPECTED_SOURCE_CHANGE.before}"`, `"${EXPECTED_SOURCE_CHANGE.after}"`)
        .replace('"Choose Starter"', '"Start Starter trial"'),
    );
    const result = await verify(root);
    expect(result.code).toBe(1);
    expect(
      result.result.checks.find(
        (check: { name: string }) => check.name === "module-starter-unchanged",
      ).ok,
    ).toBe(false);
  }, 30_000);
});

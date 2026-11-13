/**
 * The webkit engine, part 2 of 3: popups, frame self-navigation, message validator and shell refusal.
 * Part of the executable-document policy qualification described in
 * `content-server.engines-test-support.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  GENERATION,
  NAVIGATION_PATHS,
  SANDBOX,
  SHELL_SANDBOX,
  allowed,
  childFrame,
  denied,
  enginesNamed,
  fixture,
  messages,
  pathHits,
  pause,
  realClick,
  registerEngineFixtures,
  settle,
  sink,
  useEngineBrowser,
  waitForMessages,
  waitUntil,
} from "./content-server.engines-test-support.js";

let decoyRequests = 0;
registerEngineFixtures("webkit", () => {
  decoyRequests += 1;
});

for (const engine of enginesNamed("webkit")) {
  const engineTest = engine.executablePath ? test : test.skip;

  describe(`executable document policy in ${engine.name}`, () => {
    const { open, resetObservations, openIsolated, closeIsolated, results } = useEngineBrowser(
      engine,
      () => {
        decoyRequests = 0;
      },
    );

    engineTest(
      "popups, new-window links and top navigation reach the sink zero times",
      async () => {
        const target = fixture("navigation");
        const attempts = ["popup", "blank", "top"] as const;
        const control: Record<string, number> = {};
        for (const attempt of attempts) {
          sink.reset();
          const page = await open(
            allowed.page(
              allowed.control(`navigation-${engine.name}`, target.bytes),
              null,
              // The control grants the navigation privileges the policy withholds.
              "allow-scripts allow-same-origin allow-popups allow-top-navigation allow-forms",
            ),
          );
          await page.waitForLoadState("load");
          await childFrame(page).click(`#${attempt}`);
          // A positive observation: done once this attempt's own path arrived.
          await waitUntil(() => pathHits(NAVIGATION_PATHS[attempt]) > 0, 10_000).catch(
            () => undefined,
          );
          control[attempt] = pathHits(NAVIGATION_PATHS[attempt]);
        }
        results.navigationControl = control;
        for (const attempt of attempts) expect(control[attempt]).toBeGreaterThan(0);

        // Every attempt at once, each in its own context and on its own sink path.
        try {
          await resetObservations();
          const opened = await Promise.all(
            attempts.map(async (attempt) => {
              const { context: own, page } = await openIsolated(
                allowed.page(target.url, target, SANDBOX),
              );
              await waitForMessages(page, `m.verdict === "ready"`);
              // The handler ran on a real click (activation where the engine reports it).
              const clicked = await realClick(childFrame(page), `#${attempt}`, async () =>
                (await messages(page)).some(
                  (message) =>
                    (message.data as { probe?: string; id?: string })?.probe === "clicked" &&
                    (message.data as { id?: string }).id === attempt,
                ),
              );
              expect(clicked).toBe(true);
              return { attempt, context: own, page };
            }),
          );
          // One no-hit window after the last click: every attempt gets at least its full window.
          await pause(1_500);
          const restricted: Record<string, number> = {};
          for (const { attempt, context: own, page } of opened) {
            restricted[attempt] = pathHits(NAVIGATION_PATHS[attempt]);
            expect(page.url().startsWith(allowed.origin)).toBe(true);
            expect(own.pages()).toHaveLength(1);
          }
          results.navigationRestricted = restricted;
          for (const attempt of attempts) expect(restricted[attempt]).toBe(0);
          // Nothing reached the sink on any path.
          expect(sink.hits).toEqual([]);
        } finally {
          await closeIsolated();
        }
      },
      90_000,
    );

    engineTest(
      "self-navigation of the frame: not prevented by the document's policy; the application's frame-src stops it",
      async () => {
        const target = fixture("navigation");
        // Both attempts at once, each in its own context and on its own sink path.
        const observe = async (frameSrc?: string) => {
          try {
            await resetObservations();
            const opened = await Promise.all(
              (["self", "refresh"] as const).map(async (attempt) => {
                const { context: own, page } = await openIsolated(
                  allowed.page(target.url, target, SANDBOX, frameSrc ? { frameSrc } : {}),
                );
                await waitForMessages(page, `m.verdict === "ready"`);
                // Self-navigation needs no user activation; a DOM click does not
                // depend on routing real input into the out-of-process frame.
                await childFrame(page).evaluate(
                  (id) => document.getElementById(id)?.click(),
                  attempt,
                );
                await waitForMessages(
                  page,
                  `m.data && m.data.probe === "clicked" && m.data.id === "${attempt}"`,
                );
                return { attempt, context: own, page };
              }),
            );
            // One window after the last click: each attempt gets at least its full window.
            if (frameSrc) await pause(2_500);
            else
              await waitUntil(
                () => opened.every(({ attempt }) => pathHits(NAVIGATION_PATHS[attempt]) > 0),
                5_000,
              ).catch(() => undefined);
            const observed: Record<string, number> = {};
            for (const { attempt, context: own, page } of opened) {
              observed[attempt] = pathHits(NAVIGATION_PATHS[attempt]);
              // Whatever the frame loads stays inside the sandboxed frame.
              expect(page.url().startsWith(allowed.origin)).toBe(true);
              expect(own.pages()).toHaveLength(1);
            }
            return { observed, total: sink.hits.length };
          } finally {
            await closeIsolated();
          }
        };
        // The document's own CSP has no navigation directive (navigate-to was
        // never shipped) and the sandbox allows a frame to navigate itself, so
        // this is recorded rather than asserted: at least the meta refresh
        // reaches the sink in every engine.
        const unrestricted = await observe();
        results.selfNavigationReachedSink = unrestricted.observed;
        expect(unrestricted.observed.refresh).toBeGreaterThan(0);
        // The embedding page's `frame-src` governs what its frames may load.
        const contained = await observe(new URL(target.url).origin);
        results.selfNavigationWithParentFrameSrc = contained.observed;
        expect(contained.observed).toEqual({ self: 0, refresh: 0 });
        expect(contained.total).toBe(0);
      },
      90_000,
    );

    engineTest(
      "only ready, size and link-request pass the validator; the runtime accepts the host's theme",
      async () => {
        const target = fixture("channel");
        const page = await open(allowed.page(target.url, target, SANDBOX));
        await waitForMessages(page, `m.verdict === "link-request"`);
        await waitForMessages(page, `m.verdict === "size"`);
        await settle(page, 1_000);
        const all = (await messages(page)).filter((message) => message.fromFrame);
        const accepted = new Set(
          all.filter((message) => !message.verdict.startsWith("rejected:")).map((m) => m.verdict),
        );
        expect([...accepted].sort()).toEqual(["link-request", "ready", "size"]);
        const accept = all.filter((message) => !message.verdict.startsWith("rejected:"));
        // Every accepted size/link carries the host's generation and identity.
        for (const message of accept) {
          if (message.verdict === "ready") continue;
          expect(message.data).toMatchObject({
            artifactId: target.artifactId,
            revision: 1,
            generation: GENERATION,
          });
        }
        const rejected = all
          .filter((message) => message.verdict.startsWith("rejected:"))
          .map((message) => message.verdict);
        expect(rejected).toEqual(
          expect.arrayContaining([
            "rejected:unknown-type",
            "rejected:identity-mismatch",
            "rejected:bad-shape",
            "rejected:wrong-channel",
            "rejected:wrong-version",
            "rejected:too-large",
            "rejected:not-object",
          ]),
        );
        // tool-call, prompt and a frame-sent theme are unknown types.
        expect(rejected.filter((verdict) => verdict === "rejected:unknown-type")).toHaveLength(3);
        // The real runtime applied the host's theme inside the frame.
        const theme = await childFrame(page).evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          accent: document.documentElement.style.getPropertyValue("--accent"),
        }));
        expect(theme).toEqual({ theme: "dark", accent: "#123456" });
        results.channel = { accepted: [...accepted].sort(), rejected: rejected.length };
      },
      60_000,
    );

    engineTest(
      "the shell is refused by a non-permitted ancestor and frames nothing at the top level",
      async () => {
        const target = fixture("isolation");
        const refused = await open(
          denied.page(target.shellUrl, target, SHELL_SANDBOX, { generation: target.generation }),
        );
        await settle(refused, 2_000);
        expect(await messages(refused)).toEqual([]);
        expect(refused.frames().length).toBeLessThanOrEqual(2);

        const top = await open(target.shellUrl);
        await settle(top, 1_000);
        expect(top.frames()).toHaveLength(1);
        results.shellAncestors = "refused outside the permitted ancestor; no frame at top level";
      },
      60_000,
    );
  });
}

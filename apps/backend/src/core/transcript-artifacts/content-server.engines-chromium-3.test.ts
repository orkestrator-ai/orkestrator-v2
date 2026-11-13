/**
 * The chromium engine, part 3 of 3: isolation, CSP sandbox and the viewer-shell attacks and channel.
 * Part of the executable-document policy qualification described in
 * `content-server.engines-test-support.ts`.
 */
import { describe, expect, test } from "bun:test";
import { type Frame, type Page } from "playwright-core";
import {
  CANARY,
  CONTROL_SANDBOX,
  PageMessage,
  SANDBOX,
  SHELL_ATTACKS,
  SHELL_ATTACK_PATHS,
  SHELL_SANDBOX,
  ShellAttack,
  UNRESTRICTED,
  allowed,
  artifactFrame,
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
registerEngineFixtures("chromium", () => {
  decoyRequests += 1;
});

for (const engine of enginesNamed("chromium")) {
  const engineTest = engine.executablePath ? test : test.skip;

  describe(`executable document policy in ${engine.name}`, () => {
    const { open, resetObservations, openIsolated, closeIsolated, results } = useEngineBrowser(
      engine,
      () => {
        decoyRequests = 0;
      },
    );

    engineTest(
      "the frame cannot read the parent's DOM, cookies or storage, nor its own",
      async () => {
        const target = fixture("isolation");
        const control = await open(
          allowed.page(
            allowed.control(`isolation-${engine.name}`, target.bytes),
            null,
            UNRESTRICTED,
          ),
        );
        await waitForMessages(control, `m.data && m.data.probe === "isolation"`);
        const controlOut = (
          (await messages(control)).find(
            (message) => (message.data as { probe?: string })?.probe === "isolation",
          )!.data as { out: string[] }
        ).out;
        // The unrestricted control does read every canary.
        for (const name of [
          "parentDom",
          "parentVar",
          "parentCookie",
          "parentStorage",
          "cookie",
          "storage",
        ]) {
          expect(controlOut.find((entry) => entry.startsWith(`${name}=`))).toContain(CANARY);
        }

        for (const sandbox of [SANDBOX, null]) {
          const page = await open(allowed.page(target.url, target, sandbox));
          await waitForMessages(page, `m.data && m.data.probe === "isolation"`);
          const all = await messages(page);
          const out = (
            all.find((message) => (message.data as { probe?: string })?.probe === "isolation")!
              .data as { out: string[] }
          ).out;
          expect(JSON.stringify(all)).not.toContain(CANARY);
          expect(sink.hits.join(" ")).not.toContain(CANARY);
          for (const name of ["parentDom", "parentVar", "parentCookie", "parentStorage"]) {
            expect(out.find((entry) => entry.startsWith(name))).toMatch(new RegExp(`^${name}!`));
          }
          // Opaque origin: no cookie jar or storage of its own.
          const own = out.filter((entry) => /^(cookie|storage|session)[=!]/.test(entry));
          for (const entry of own) expect(entry === "cookie=" || entry.includes("!")).toBe(true);
          results[sandbox ? "isolationWithSandboxAttribute" : "isolationWithoutSandboxAttribute"] =
            out;
        }
      },
      60_000,
    );

    engineTest(
      "the header's CSP sandbox applies without an iframe sandbox attribute",
      async () => {
        const target = fixture("isolation");
        // Control: the same bytes unsandboxed run with a real origin.
        const control = await open(
          allowed.page(
            allowed.control(`sandbox-${engine.name}`, target.bytes),
            target,
            UNRESTRICTED,
          ),
        );
        await waitForMessages(control, `m.verdict === "ready"`);
        expect(
          (await messages(control)).find((message) => message.verdict === "ready")!.origin,
        ).toBe(allowed.origin);

        const page = await open(allowed.page(target.url, target, null));
        await waitForMessages(page, `m.verdict === "ready"`);
        const ready = (await messages(page)).find((message) => message.verdict === "ready")!;
        expect(ready.origin).toBe("null");
        results.cspSandboxWithoutAttribute = "opaque origin (null)";
      },
      60_000,
    );
    /** Click one attack button in the artifact frame; returns the id the handler recorded. */
    async function trigger(page: Page, attack: ShellAttack): Promise<string | null> {
      const frame = artifactFrame(page);
      if (attack === "popup") {
        // A real click, so the popup has user activation where the engine requires it.
        await realClick(
          frame,
          "#popup",
          async () => (await frame.evaluate(() => document.body.dataset.clicked ?? null)) !== null,
        );
        return frame.evaluate(() => document.body.dataset.clicked ?? null);
      }
      return frame.evaluate((id) => {
        document.getElementById(id)?.click();
        return document.body.dataset.clicked ?? null;
      }, attack);
    }

    function disposals(all: PageMessage[]): string[] {
      return all
        .filter((message) => (message.data as { type?: string })?.type === "shell-disposed")
        .map((message) => (message.data as { reason: string }).reason);
    }

    engineTest(
      "through the shell, every self-navigation, popup, form and redirect reaches the sink zero times",
      async () => {
        const target = fixture("shellNavigation");
        const reach = () => sink.hits.length + decoyRequests;
        /** Reach of one attack: its own sink paths (and the decoy capability for the decoy). */
        const reachOf = (attack: (typeof SHELL_ATTACKS)[number]) =>
          pathHits(SHELL_ATTACK_PATHS[attack]) + (attack === "decoy" ? decoyRequests : 0);
        const run = async (mode: "control" | "direct" | "shell") => {
          const observed: Record<string, number> = {};
          const disposed: Record<string, string[]> = {};
          if (mode === "control") {
            // Positive observations, one at a time: each stops once it reached a sink.
            for (const attack of SHELL_ATTACKS) {
              sink.reset();
              decoyRequests = 0;
              const page = await open(
                allowed.page(
                  allowed.control(`shell-navigation-${engine.name}`, target.bytes),
                  null,
                  CONTROL_SANDBOX,
                ),
              );
              await waitForMessages(page, `m.verdict === "ready"`);
              // The handler ran (on a real click for the popup).
              expect(await trigger(page, attack)).toBe(attack);
              await waitUntil(() => reach() > 0, 5_000).catch(() => {});
              observed[attack] = reach();
            }
            return { observed, disposed, total: 0 };
          }
          // Every attack at once, each in its own context and on its own sink
          // path (or the decoy capability), so each hit names its attack.
          try {
            await resetObservations();
            const url =
              mode === "direct"
                ? allowed.page(target.url, target, SANDBOX)
                : allowed.page(target.shellUrl, target, SHELL_SANDBOX, {
                    generation: target.generation,
                  });
            const opened = await Promise.all(
              SHELL_ATTACKS.map(async (attack) => {
                const { context: own, page } = await openIsolated(url);
                await waitForMessages(page, `m.verdict === "ready"`);
                // The handler ran (on a real click for the popup).
                expect(await trigger(page, attack)).toBe(attack);
                return { attack, context: own, page };
              }),
            );
            // One no-hit window after the last trigger: every attack gets at least its full window.
            await pause(2_000);
            for (const { attack, context: own, page } of opened) {
              observed[attack] = reachOf(attack);
              if (mode === "shell") {
                disposed[attack] = disposals(await messages(page));
                // Whatever happened stayed inside the frame: same page, no new window.
                expect(page.url().startsWith(allowed.origin)).toBe(true);
                expect(own.pages()).toHaveLength(1);
              }
            }
            return { observed, disposed, total: reach() };
          } finally {
            await closeIsolated();
          }
        };
        // Control: same bytes, no policy, same origin as the page, with the
        // withheld sandbox privileges: every attack reaches its sink.
        const control = await run("control");
        results.shellAttackControl = control.observed;
        for (const attack of SHELL_ATTACKS) expect(control.observed[attack]).toBeGreaterThan(0);
        // The document framed directly by the page (browser mode before the
        // shell): its own policy stops the popup and the form only.
        const direct = await run("direct");
        results.shellAttackWithoutShell = direct.observed;
        expect(direct.observed.refresh).toBeGreaterThan(0);
        // Through the shell: nothing reaches any sink.
        const shell = await run("shell");
        results.shellAttackThroughShell = shell.observed;
        results.shellAttackDisposals = shell.disposed;
        for (const attack of SHELL_ATTACKS) expect(shell.observed[attack]).toBe(0);
        // Nor did anything reach the sink or the decoy on any other path.
        expect(shell.total).toBe(0);
        // Every attempted frame navigation also disposed the frame (the reason
        // depends on whether the engine reports the violation or loads an
        // error page); the popup and the form never navigated the frame.
        for (const attack of SHELL_ATTACKS) {
          if (attack === "popup" || attack === "form") expect(shell.disposed[attack]).toEqual([]);
          else expect(shell.disposed[attack]).toHaveLength(1);
        }
      },
      240_000,
    );

    engineTest(
      "through the shell, an unexpected load disposes the frame and notifies the host",
      async () => {
        const target = fixture("shellNavigation");
        const page = await open(
          allowed.page(target.shellUrl, target, SHELL_SANDBOX, { generation: target.generation }),
        );
        await waitForMessages(page, `m.verdict === "ready"`);
        // Reloading its own (permitted) URL is the one navigation frame-src allows.
        expect(await trigger(page, "reload")).toBe("reload");
        await waitForMessages(page, `m.data && m.data.type === "shell-disposed"`);
        const all = await messages(page);
        expect(disposals(all)).toEqual(["unexpected-load"]);
        expect(all.find((message) => message.verdict === "ready")).toMatchObject({
          fromFrame: true,
          origin: new URL(target.shellUrl).origin,
        });
        // The shell tore the artifact frame down.
        await page.waitForFunction(
          () => document.querySelector("iframe")?.contentWindow?.frames.length === 0,
          undefined,
          { timeout: 5_000 },
        );
        expect(page.frames()).toHaveLength(2);
        results.shellUnexpectedLoad = disposals(all);
      },
      60_000,
    );

    engineTest(
      "through the shell, the channel works: ready, size and link-request out, theme in",
      async () => {
        const target = fixture("channel");
        const page = await open(
          allowed.page(target.shellUrl, target, SHELL_SANDBOX, { generation: target.generation }),
        );
        await waitForMessages(page, `m.verdict === "link-request"`);
        await waitForMessages(page, `m.verdict === "size"`);
        await settle(page, 1_000);
        const all = (await messages(page)).filter((message) => message.fromFrame);
        // The relay dropped every hostile message: the host saw only valid ones.
        expect(
          all.map((message) => message.verdict).filter((v) => v.startsWith("rejected:")),
        ).toEqual([]);
        expect(Array.from(new Set(all.map((message) => message.verdict))).sort()).toEqual([
          "link-request",
          "ready",
          "size",
        ]);
        const contentOrigin = new URL(target.shellUrl).origin;
        for (const message of all) {
          expect(message.origin).toBe(contentOrigin);
          if (message.verdict === "ready") continue;
          expect(message.data).toMatchObject({
            artifactId: target.artifactId,
            revision: 1,
            generation: target.generation,
          });
        }
        expect(all.find((message) => message.verdict === "link-request")?.data).toMatchObject({
          url: "https://example.com/docs",
          label: "Docs",
        });
        // The host's theme reached the real runtime through the shell.
        const theme = await artifactFrame(page).evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          accent: document.documentElement.style.getPropertyValue("--accent"),
        }));
        expect(theme).toEqual({ theme: "dark", accent: "#123456" });
        // Neither frame can reach its parent: the artifact is opaque, the shell cross-site.
        const reads = async (frame: Frame) =>
          frame.evaluate(() => {
            try {
              return String(parent.document.title);
            } catch (error) {
              return `denied:${(error as Error).name}`;
            }
          });
        expect(await reads(artifactFrame(page))).toBe("denied:SecurityError");
        const shellFrame = page.frames().find((frame) => frame.parentFrame() === page.mainFrame())!;
        expect(await reads(shellFrame)).toBe("denied:SecurityError");
        results.shellChannel = Array.from(new Set(all.map((message) => message.verdict))).sort();
      },
      60_000,
    );
  });
}

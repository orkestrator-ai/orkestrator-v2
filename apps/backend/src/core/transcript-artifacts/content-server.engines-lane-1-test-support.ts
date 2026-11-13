/**
 * Lane 1 of 3 of the executable-document policy qualification: frame ancestors, script hashes, network and forms.
 * Each `content-server.engines-<engine>-1.test.ts` file calls
 * {@link defineEngineLane1} for its own engine, so the test bodies exist once
 * while `bun test --parallel` still runs every engine and lane in its own
 * worker. The qualification itself is described in
 * `content-server.engines-test-support.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  NETWORK_PATHS,
  SANDBOX,
  UNRESTRICTED,
  allowed,
  denied,
  enginesNamed,
  fixture,
  messages,
  registerEngineFixtures,
  settle,
  sink,
  sinkHits,
  useEngineBrowser,
  waitForMessages,
  waitUntil,
  type EngineSpec,
} from "./content-server.engines-test-support.js";

/** Registers lane 1's fixtures and tests for one engine. Call once, at a test file's top level. */
export function defineEngineLane1(engineName: EngineSpec["name"]): void {
  let decoyRequests = 0;
  registerEngineFixtures(engineName, () => {
    decoyRequests += 1;
  });

  for (const engine of enginesNamed(engineName)) {
    const engineTest = engine.executablePath ? test : test.skip;

    describe(`executable document policy in ${engine.name}`, () => {
      const { open, results } = useEngineBrowser(engine, () => {
        decoyRequests = 0;
      });

      engineTest(
        "loads only in a permitted ancestor; refused by any other (frame-ancestors)",
        async () => {
          const target = fixture("isolation");
          const page = await open(allowed.page(target.url, target, SANDBOX));
          await waitForMessages(page, `m.verdict === "ready"`);
          const ready = (await messages(page)).find((message) => message.verdict === "ready")!;
          expect(ready).toMatchObject({ fromFrame: true, origin: "null" });

          const refused = await open(denied.page(target.url, target, SANDBOX));
          await settle(refused, 2_000);
          expect(await messages(refused)).toEqual([]);
          results.frameAncestors = "refused outside the permitted ancestor";
        },
        60_000,
      );

      engineTest(
        "an inline script or handler whose hash is not in the policy never runs; eval is refused",
        async () => {
          const target = fixture("hash");
          // Control: the same bytes without the policy run the injected code.
          const control = await open(
            allowed.page(allowed.control(`hash-${engine.name}`, target.bytes), null, UNRESTRICTED),
          );
          await waitForMessages(control, `m.data && m.data.probe === "injected-script"`);
          await waitForMessages(control, `m.data && m.data.probe === "injected-attribute"`);
          const controlEval = (await messages(control)).find(
            (message) => (message.data as { probe?: string })?.probe === "eval",
          );
          expect(controlEval?.data).toMatchObject({ result: "42", fn: "7" });

          const page = await open(allowed.page(target.url, target, SANDBOX));
          await waitForMessages(page, `m.data && m.data.probe === "eval"`);
          await settle(page);
          const probes = (await messages(page)).map(
            (message) => (message.data as { probe?: string })?.probe,
          );
          expect(probes).not.toContain("injected-script");
          expect(probes).not.toContain("injected-attribute");
          const evaluated = (await messages(page)).find(
            (message) => (message.data as { probe?: string })?.probe === "eval",
          )!.data as { result: string; fn: string };
          expect(evaluated.result.startsWith("refused:")).toBe(true);
          expect(evaluated.fn.startsWith("refused:")).toBe(true);
          results.scriptHashes = {
            injectedBlocked: true,
            eval: evaluated.result,
            fn: evaluated.fn,
          };
        },
        60_000,
      );

      engineTest(
        "network, image, font and WebSocket attempts reach the sink zero times",
        async () => {
          const target = fixture("network");
          sink.reset();
          await open(
            allowed.page(
              allowed.control(`network-${engine.name}`, target.bytes),
              null,
              UNRESTRICTED,
            ),
          );
          const reachedPaths = () =>
            NETWORK_PATHS.filter((sinkPath) =>
              sink.hits.some((hit) => hit.split(" ")[1] === sinkPath),
            );
          // A positive observation: stop as soon as every channel has arrived,
          // else after the full window (a channel the engine never attempts).
          await waitUntil(() => reachedPaths().length === NETWORK_PATHS.length, 2_500).catch(
            () => undefined,
          );
          const reached = reachedPaths();
          results.networkControlReached = reached;
          // The unrestricted control proves the sink observes every channel the
          // engine implements (a channel the engine never attempts is noted).
          expect(reached).toEqual(
            expect.arrayContaining(["/fetch", "/xhr", "/websocket", "/image", "/font"]),
          );

          sink.reset();
          const page = await open(allowed.page(target.url, target, SANDBOX));
          await waitForMessages(page, `m.verdict === "ready"`);
          await settle(page, 2_500);
          expect(sink.hits).toEqual([]);
          results.networkRestrictedHits = sink.hits.length;
        },
        60_000,
      );

      engineTest(
        "form submission reaches the sink zero times",
        async () => {
          const target = fixture("form");
          sink.reset();
          const control = await open(
            allowed.page(allowed.control(`form-${engine.name}`, target.bytes), null, UNRESTRICTED),
          );
          await waitUntil(() => sinkHits("/form").length > 0);
          await settle(control, 500);
          expect(sinkHits("POST /form").length).toBeGreaterThan(0);

          sink.reset();
          const page = await open(allowed.page(target.url, target, SANDBOX));
          await waitForMessages(page, `m.verdict === "ready"`);
          await settle(page, 2_000);
          expect(sink.hits).toEqual([]);
          results.form = "blocked";
        },
        60_000,
      );
    });
  }
}

/**
 * Phase 2 exit, browser (plan item 2013): one page holds its command scope
 * and a leaf scope at once, against two running `dev:test` profiles, the leaf
 * attached to the command node, over the direct route and then the relay.
 *
 * The page drives the dev-only harness `window.orkestratorScopeProof`
 * (`apps/web/src/lib/node-scope/scope-proof-harness.ts`). The relay is forced
 * by blocking the leaf's origin in the browser (CDP `Network.setBlockedURLs`,
 * no request interception), so the registry's direct probe fails and it falls
 * back to the command node's relay. While the leaf scope is held, CDP records
 * every request and WebSocket per origin: those still open after a quiet
 * window are the long-lived ones. `nextHopProtocol` comes from the page's
 * resource timing. Evidence: `output/agent-testing/<run>/scope-proof/`.
 *
 * mise run dev:test --profile <cmd> --fixture ...; mise run dev:test --profile <leaf> --fixture ...
 * ORKESTRATOR_AGENT_TEST_PROFILE=<cmd> ORKESTRATOR_AGENT_TEST_LEAF_PROFILE=<leaf> \
 *   bunx playwright test --config e2e/agent-testing/playwright.scope-proof.config.ts --project browser
 */
import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "./browser-test";
import {
  SKIP_REASON,
  attachLeaf,
  commandProfile,
  createLeafEnvironment,
  deleteLeafEnvironment,
  gateway,
  leafProfile,
  loginUrl,
  scopeProofFailures,
  secondLeafProfile,
  writeEvidence,
  type ScopeProofReport,
} from "./scope-proof-support";

test.skip(!commandProfile || !leafProfile, SKIP_REASON);
test.describe.configure({ mode: "serial" });

/** How long the held leaf scope is watched for requests that stay open. */
const QUIET_WINDOW_MS = Number(process.env.ORKESTRATOR_AGENT_TEST_SCOPE_PROOF_WINDOW_MS ?? 20_000);

interface RequestRecord {
  origin: string;
  path: string;
  done: boolean;
  protocol?: string;
}

/** Every HTTP request and WebSocket of the page, by CDP request id. */
async function recordNetwork(page: Page): Promise<{
  session: CDPSession;
  requests: Map<string, RequestRecord>;
  sockets: Map<string, string>;
}> {
  const session = await page.context().newCDPSession(page);
  await session.send("Network.enable");
  const requests = new Map<string, RequestRecord>();
  const sockets = new Map<string, string>();
  const redact = (pathname: string) =>
    pathname
      .replace(/\/nodes\/[^/]+/u, "/nodes/<leaf>")
      .replace(/terminal-output-[^/?]+/u, "terminal-output-<id>");
  session.on("Network.requestWillBeSent", (event) => {
    const url = new URL(event.request.url);
    if (!url.protocol.startsWith("http")) return;
    requests.set(event.requestId, { origin: url.origin, path: redact(url.pathname), done: false });
  });
  session.on("Network.responseReceived", (event) => {
    const record = requests.get(event.requestId);
    if (record && event.response.protocol) record.protocol = event.response.protocol;
  });
  const finish = (event: { requestId: string }) => {
    const record = requests.get(event.requestId);
    if (record) record.done = true;
  };
  session.on("Network.loadingFinished", finish);
  session.on("Network.loadingFailed", finish);
  session.on("Network.webSocketCreated", (event) => {
    const url = new URL(event.url);
    sockets.set(event.requestId, `${url.origin}${redact(url.pathname)}`);
  });
  session.on("Network.webSocketClosed", (event) => sockets.delete(event.requestId));
  return { session, requests, sockets };
}

async function signedIn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => performance.setResourceTimingBufferSize(20_000));
  const response = await page.goto(loginUrl(commandProfile), { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(
          () => typeof (window as { orkestratorScopeProof?: unknown }).orkestratorScopeProof,
        ),
      {
        timeout: 60_000,
        message: "the dev:test renderer installs the scope-proof harness",
      },
    )
    .toBe("object");
}

for (const route of ["direct", "relay"] as const) {
  test(`one page holds the command scope and a leaf scope (${route})`, async ({ page }) => {
    test.setTimeout(300_000);
    const command = gateway(commandProfile);
    const leaf = gateway(leafProfile);
    const { nodeId: leafNodeId } = await attachLeaf(command, leaf);
    const { nodeId: commandNodeId } = await command.invoke<{ nodeId: string }>("get_node_status");
    const environment = await createLeafEnvironment(leaf, `scope-proof-${route}-${Date.now()}`);
    try {
      const network = await recordNetwork(page);
      if (route === "relay") {
        await network.session.send("Network.setBlockedURLs", { urls: [`${leaf.origin}/*`] });
      }
      await signedIn(page);
      const report = (await page.evaluate(
        (input) =>
          (
            window as unknown as {
              orkestratorScopeProof: { run(input: unknown): Promise<unknown> };
            }
          ).orkestratorScopeProof.run(input),
        { leafNodeId, leafEnvironmentId: environment.id, keepOpen: true },
      )) as ScopeProofReport;

      // Hold both scopes through a quiet window, then count what is still open.
      await page.waitForTimeout(QUIET_WINDOW_MS);
      const longLived: Record<string, string[]> = {};
      const protocols: Record<string, string[]> = {};
      for (const record of network.requests.values()) {
        if (!record.done) (longLived[record.origin] ??= []).push(record.path);
        if (record.protocol && !(protocols[record.origin] ??= []).includes(record.protocol)) {
          protocols[record.origin]!.push(record.protocol);
        }
      }
      const nextHopProtocol = await page.evaluate(() => {
        const out: Record<string, string[]> = {};
        for (const entry of performance.getEntriesByType(
          "resource",
        ) as PerformanceResourceTiming[]) {
          if (!entry.name.includes("/__orkestrator/")) continue;
          const origin = new URL(entry.name).origin;
          const list = (out[origin] ??= []);
          if (!list.includes(entry.nextHopProtocol)) list.push(entry.nextHopProtocol);
        }
        return out;
      });
      const scopesWhileHeld = await page.evaluate(() =>
        (
          window as unknown as {
            orkestratorScopeProof: { scopes(): unknown };
          }
        ).orkestratorScopeProof.scopes(),
      );
      await page.evaluate(
        (nodeId) =>
          (
            window as unknown as { orkestratorScopeProof: { close(nodeId: string): void } }
          ).orkestratorScopeProof.close(nodeId),
        leafNodeId,
      );
      const roleOf = (origin: string) =>
        origin === command.origin ? "command" : origin === leaf.origin ? "leaf" : "other";
      const byRole = <T>(value: Record<string, T>) =>
        Object.fromEntries(Object.entries(value).map(([origin, entry]) => [roleOf(origin), entry]));
      const evidence = {
        host: "browser",
        route,
        commandProfile,
        leafProfile,
        report: {
          ...report,
          route: report.route && {
            ...report.route,
            baseUrl: report.route.baseUrl && roleOf(new URL(report.route.baseUrl).origin),
          },
        },
        scopesWhileHeld,
        quietWindowMs: QUIET_WINDOW_MS,
        longLivedRequestsPerOrigin: Object.fromEntries(
          Object.entries(byRole(longLived)).map(([role, paths]) => [
            role,
            { count: paths.length, paths },
          ]),
        ),
        openWebSockets: [...network.sockets.values()].map((url) => {
          const parsed = new URL(url);
          return `${roleOf(parsed.origin)}${parsed.pathname}`;
        }),
        cdpProtocolPerOrigin: byRole(protocols),
        nextHopProtocolPerOrigin: byRole(nextHopProtocol),
        blockedLeafOrigin: route === "relay",
      };
      writeEvidence(`browser-${route}`, evidence);
      expect(
        scopeProofFailures(report, { commandNodeId, leafNodeId, relayed: route === "relay" }),
      ).toEqual([]);
      if (route === "relay") {
        // No response came from the leaf's own origin: every leaf call went through the relay.
        expect(protocols[leaf.origin] ?? []).toEqual([]);
      } else {
        expect(protocols[leaf.origin]?.length ?? 0).toBeGreaterThan(0);
        // The held leaf scope keeps its own event stream open on the leaf's origin.
        expect(longLived[leaf.origin] ?? []).toContain("/__orkestrator/events");
      }
    } finally {
      await deleteLeafEnvironment(leaf, environment.id);
    }
  });
}

test("one page holds the command scope and two leaf scopes at once (direct)", async ({ page }) => {
  test.skip(
    !secondLeafProfile,
    "Set ORKESTRATOR_AGENT_TEST_SECOND_LEAF_PROFILE to a third running profile.",
  );
  test.setTimeout(300_000);
  const command = gateway(commandProfile);
  const leaves = [gateway(leafProfile), gateway(secondLeafProfile)];
  const { nodeId: commandNodeId } = await command.invoke<{ nodeId: string }>("get_node_status");
  const attached = [];
  for (const leaf of leaves) attached.push((await attachLeaf(command, leaf)).nodeId);
  const environments = [];
  for (const [index, leaf] of leaves.entries()) {
    environments.push(await createLeafEnvironment(leaf, `scope-proof-two-${index}-${Date.now()}`));
  }
  try {
    await signedIn(page);
    const reports: ScopeProofReport[] = [];
    for (const [index, leafNodeId] of attached.entries()) {
      reports.push(
        (await page.evaluate(
          (input) =>
            (
              window as unknown as {
                orkestratorScopeProof: { run(input: unknown): Promise<unknown> };
              }
            ).orkestratorScopeProof.run(input),
          { leafNodeId, leafEnvironmentId: environments[index]!.id, keepOpen: true },
        )) as ScopeProofReport,
      );
    }
    const scopes = (await page.evaluate(() =>
      (
        window as unknown as {
          orkestratorScopeProof: { scopes(): unknown };
        }
      ).orkestratorScopeProof.scopes(),
    )) as Array<{ nodeId: string; role: string; connection: string }>;
    for (const leafNodeId of attached) {
      await page.evaluate(
        (nodeId) =>
          (
            window as unknown as { orkestratorScopeProof: { close(nodeId: string): void } }
          ).orkestratorScopeProof.close(nodeId),
        leafNodeId,
      );
    }
    writeEvidence("browser-two-leaves", {
      host: "browser",
      commandProfile,
      leafProfiles: [leafProfile, secondLeafProfile],
      reports: reports.map((report) => ({
        ...report,
        route: report.route && { ...report.route, baseUrl: null },
      })),
      scopesWhileHeld: scopes,
    });
    for (const [index, report] of reports.entries()) {
      expect(
        scopeProofFailures(report, { commandNodeId, leafNodeId: attached[index]!, relayed: false }),
      ).toEqual([]);
    }
    // Both leaves were open together, each live on its own scope.
    expect(scopes.map((scope) => scope.role).sort()).toEqual(["command", "leaf", "leaf"]);
    expect(scopes.every((scope) => scope.connection === "live")).toBe(true);
    expect(new Set(scopes.map((scope) => scope.nodeId)).size).toBe(3);
  } finally {
    for (const [index, leaf] of leaves.entries())
      await deleteLeafEnvironment(leaf, environments[index]!.id);
  }
});

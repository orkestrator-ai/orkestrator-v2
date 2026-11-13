// Not `./browser-test`: the client under test is the real gateway module in a
// blank page on its own link, as in `client-outage.spec.ts`.
import { expect, test, type Page, type Request } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BLANK_PATH,
  installReactRefreshPreamble,
  startOutageLink,
  type OutageLink,
} from "./client-outage-support";
import { openAt, percentile, type OpenInterval } from "./bearer-terminal-stream-support";

/**
 * A bearer client in a real headless browser holds one terminal stream for
 * all its terminals while `/invoke` stays prompt (to-do 5380 (retired), task
 * 1; efficiency report 0120, GW-3).
 *
 * The client is the web client's own gateway code
 * (`apps/web/src/lib/native/web-gateway.ts`) loaded into a blank page and
 * given the profile's gateway token, which is the path a hosted or
 * workspace-realm client takes: it reads terminal output with `fetch`, because
 * an `EventSource` cannot send a bearer. The page reaches the gateway through
 * a loopback link (`client-outage-support.ts`), which records each request's
 * kind, open and close times and command name, never a body or header. Plain
 * HTTP on loopback is HTTP/1.1, so Chromium's six connections per host apply.
 *
 * With `TERMINALS` terminals all printing, it records:
 *
 * - the terminal streams the link saw open at once, and the same from the
 *   browser's own network log;
 * - every terminal's output arriving (byte counts only, kept in the page);
 * - `/invoke` round trips, one after another and in parallel bursts, timed in
 *   the page;
 * - a control on a second link: six bearer streams opened by hand, one per
 *   terminal as clients did before GW-3, and whether an `/invoke` behind them
 *   still answers. It shows the browser's limit is real on this origin.
 *
 * Run against a credential-free profile of its own:
 *
 *   ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile bearer-terminals \
 *     --fixture --headless --no-agent-credentials --no-host-seed --agent-platforms claude
 *   ORKESTRATOR_AGENT_TEST_PROFILE=bearer-terminals ORKESTRATOR_AGENT_TEST_LIVE_BEARER_TERMINALS=1 \
 *     mise run test:logged -- --name bearer-terminals -- bunx playwright test \
 *     --config e2e/agent-testing/playwright.browser.config.ts \
 *     bearer-terminal-stream-live.spec.ts --workers=1
 *
 * Evidence (counts and milliseconds) goes to
 * `output/agent-testing/<run id>/bearer-terminal-stream.json`.
 */

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  rendererUrl?: string;
  testProject?: string;
  authFile?: string;
};
type Project = { id: string; localPath: string | null };
type Environment = { id: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type BearerReport = {
  outputBytes: Record<string, number>;
  outputChunks: Record<string, number>;
  desyncs: number;
};

declare global {
  interface Window {
    bearerClient: {
      report(): BearerReport;
      timeInvokes(count: number, parallel: number, gapMs: number): Promise<number[]>;
      addTerminal(session: string): void;
      dispose(): void;
    };
  }
}

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "bearer-terminals";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_BEARER_TERMINALS === "1";
const TERMINALS = Number(process.env.ORKESTRATOR_AGENT_TEST_BEARER_TERMINALS ?? 7);
/** Lines each terminal prints, one every 50 ms. */
const LINES = 400;
/** No round trip here should come near this; a starved one never answers. */
const INVOKE_BUDGET_MS = 5_000;
const CONTROL_STREAMS = 6;
const CONTROL_WAIT_MS = 4_000;

test.skip(!LIVE, "Set ORKESTRATOR_AGENT_TEST_LIVE_BEARER_TERMINALS=1 against a disposable profile");
// The durable token reaches the page as an argument.
test.use({ trace: "off", screenshot: "off", video: "off" });

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  const status = JSON.parse(command.stdout) as Status;
  expect(status.profile).toBe(profile);
  expect(status.status).toBe("ready");
  expect(status.flavor, "runs only in an agent-test profile").toBe("agent-test");
  return status;
}

function gatewayToken(status: Status): string {
  return (JSON.parse(readFileSync(status.authFile!, "utf8")) as { token: string }).token;
}

function directInvoke(status: Status, token: string): Invoke {
  const url = new URL("/__orkestrator/invoke", status.browserUrl!).href;
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    });
    if (!response.ok) throw new Error(`${command} failed with HTTP ${response.status}`);
    return ((await response.json()) as { result: T }).result;
  };
}

/** Terminal-stream requests in the browser's own network log, open to close. */
function browserTerminalStreams(page: Page): () => OpenInterval[] {
  const intervals = new Map<Request, OpenInterval>();
  const isTerminalStream = (request: Request) => {
    const url = new URL(request.url());
    return url.pathname === "/__orkestrator/events" && url.searchParams.has("includeEvents");
  };
  page.on("request", (request) => {
    if (isTerminalStream(request)) intervals.set(request, { at: Date.now() });
  });
  const close = (request: Request) => {
    const interval = intervals.get(request);
    if (interval && interval.closedAt === undefined) interval.closedAt = Date.now();
  };
  page.on("requestfinished", close);
  page.on("requestfailed", close);
  return () => [...intervals.values()];
}

test("a bearer client holds one terminal stream while /invoke stays prompt", async ({
  context,
}) => {
  test.setTimeout(6 * 60_000);
  const status = profileStatus();
  const token = gatewayToken(status);
  const invoke = directInvoke(status, token);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `bearer-terminals-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  const links: OutageLink[] = [];
  const sessions: string[] = [];
  const evidence: Record<string, unknown> = { profile, terminals: TERMINALS, lines: LINES };
  try {
    await invoke("start_environment", { environmentId: environment.id });
    for (let index = 0; index < TERMINALS; index += 1) {
      const { sessionId } = await invoke<{ sessionId: string }>("create_local_terminal_session", {
        environmentId: environment.id,
        cols: 100,
        rows: 30,
        terminalKey: `bearer-${index}`,
      });
      await invoke("start_local_terminal_session", { sessionId });
      sessions.push(sessionId);
    }

    const link = await startOutageLink({
      owner: "bearer",
      gatewayUrl: status.browserUrl!,
      rendererUrl: status.rendererUrl!,
    });
    links.push(link);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const browserStreams = browserTerminalStreams(page);
    await page.goto(new URL(BLANK_PATH, link.url).href);
    await page.evaluate(installReactRefreshPreamble);
    await page.evaluate(
      async ({ baseUrl, token, sessionIds }) => {
        // Claim the slot first, or loading the module installs the page's own
        // cookie-session gateway, whose 401 reloads this blank page.
        const page = window as unknown as { orkestrator?: object };
        page.orkestrator ??= {};
        const modulePath = "/src/lib/native/web-gateway.ts";
        const { createBrowserGatewayApi } = await import(/* @vite-ignore */ modulePath);
        const api = createBrowserGatewayApi({ baseUrl, token, terminalTransport: "http-sse" });
        const report: BearerReport = { outputBytes: {}, outputChunks: {}, desyncs: 0 };
        const stops = [api.listen("environment-updated", () => undefined)];
        const addTerminal = (session: string) => {
          report.outputBytes[session] = 0;
          report.outputChunks[session] = 0;
          stops.push(
            api.listen(`terminal-output-${session}`, (payload: unknown) => {
              const output = payload as {
                desynced?: boolean;
                bytes?: Uint8Array;
                text?: string;
              } | null;
              if (output?.desynced) {
                report.desyncs += 1;
                return;
              }
              // Counts only; terminal bytes stay in the page.
              report.outputBytes[session]! +=
                output?.bytes instanceof Uint8Array
                  ? output.bytes.byteLength
                  : (output?.text?.length ?? 0);
              report.outputChunks[session]! += 1;
            }),
          );
        };
        for (const session of sessionIds) addTerminal(session);
        window.bearerClient = {
          report: () => report,
          addTerminal,
          async timeInvokes(count, parallel, gapMs) {
            const durations: number[] = [];
            for (let round = 0; round < count; round += 1) {
              await Promise.all(
                Array.from({ length: parallel }, async () => {
                  const started = performance.now();
                  await api.invoke("get_projects");
                  durations.push(Math.round(performance.now() - started));
                }),
              );
              await new Promise((resolve) => setTimeout(resolve, gapMs));
            }
            return durations;
          },
          dispose: () => {
            for (const stop of stops) stop();
          },
        };
      },
      { baseUrl: link.url, token, sessionIds: sessions },
    );
    // The main stream and the shared terminal stream are both up.
    await expect
      .poll(() =>
        ["main-stream", "terminal-stream"].every((kind) =>
          link.requests.some((request) => request.kind === kind && request.status === 200),
        ),
      )
      .toBe(true);
    const idleInvokeMs = await page.evaluate(() => window.bearerClient.timeInvokes(10, 1, 50));

    // Every terminal prints for about 20 s.
    const outputFrom = Date.now();
    for (const sessionId of sessions) {
      await invoke("local_terminal_write", {
        sessionId,
        data: `for i in $(seq 1 ${LINES}); do echo bearer-tick-$i; sleep 0.05; done\n`,
      });
    }
    await page.waitForTimeout(2_000);
    const measureFrom = Date.now();
    // About 10 s of round trips while all terminals print.
    const sequentialMs = await page.evaluate(() => window.bearerClient.timeInvokes(30, 1, 200));
    const burstMs = await page.evaluate(() => window.bearerClient.timeInvokes(8, 5, 300));
    const measureTo = Date.now();
    const streamingReport = await page.evaluate(() => window.bearerClient.report());

    const linkTerminalStreams = link.requests.filter(
      (request) => request.kind === "terminal-stream",
    );
    const linkMainStreams = link.requests.filter((request) => request.kind === "main-stream");
    const linkOpen = openAt(linkTerminalStreams, measureFrom, measureTo);
    const browserOpen = openAt(browserStreams(), measureFrom, measureTo);
    const mainOpen = openAt(linkMainStreams, measureFrom, measureTo);
    evidence.streaming = {
      outputStartedBeforeMeasureMs: measureFrom - outputFrom,
      measureMs: measureTo - measureFrom,
      terminalStreamsOpenedSoFar: linkTerminalStreams.length,
      linkTerminalStreamsOpen: linkOpen,
      browserTerminalStreamsOpen: browserOpen,
      mainStreamsOpen: mainOpen,
      idleInvoke: summarize(idleInvokeMs),
      sequentialInvoke: summarize(sequentialMs),
      burstInvoke: summarize(burstMs),
      terminalsWithOutput: Object.values(streamingReport.outputBytes).filter((bytes) => bytes > 0)
        .length,
    };

    // Let every loop finish, then check each terminal's output arrived.
    await expect
      .poll(
        async () => {
          const report = await page.evaluate(() => window.bearerClient.report());
          return Math.min(...Object.values(report.outputBytes));
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBeGreaterThan(LINES * "bearer-tick-1\r\n".length);
    const finalReport = await page.evaluate(() => window.bearerClient.report());
    evidence.output = {
      minBytesPerTerminal: Math.min(...Object.values(finalReport.outputBytes)),
      minChunksPerTerminal: Math.min(...Object.values(finalReport.outputChunks)),
      desyncs: finalReport.desyncs,
      terminalStreamsOpenedInAll: link.requests.filter(
        (request) => request.kind === "terminal-stream",
      ).length,
    };

    // One more terminal: the filter changes, so the stream is rebuilt once and
    // each terminal it already carried is told to re-read its snapshot.
    const { sessionId: extra } = await invoke<{ sessionId: string }>(
      "create_local_terminal_session",
      { environmentId: environment.id, cols: 100, rows: 30, terminalKey: "bearer-extra" },
    );
    await invoke("start_local_terminal_session", { sessionId: extra });
    sessions.push(extra);
    const streamsBefore = link.requests.filter((request) => request.kind === "terminal-stream");
    const desyncsBefore = finalReport.desyncs;
    const reopenFrom = Date.now();
    await page.evaluate((session) => window.bearerClient.addTerminal(session), extra);
    await expect
      .poll(
        () =>
          link.requests.filter(
            (request) => request.kind === "terminal-stream" && request.status === 200,
          ).length,
      )
      .toBe(streamsBefore.length + 1);
    await invoke("local_terminal_write", { sessionId: extra, data: "echo bearer-extra-ready\n" });
    await expect
      .poll(
        async () => (await page.evaluate(() => window.bearerClient.report())).outputBytes[extra],
      )
      .toBeGreaterThan(0);
    await page.waitForTimeout(1_000);
    const reopenTo = Date.now();
    const settledFrom = reopenTo - 500;
    const terminalStreams = link.requests.filter((request) => request.kind === "terminal-stream");
    const reopenReport = await page.evaluate(() => window.bearerClient.report());
    const settledOpen = openAt(terminalStreams, settledFrom, reopenTo);
    evidence.reopen = {
      streamsOpenedForTheNewTerminal: terminalStreams.length - streamsBefore.length,
      openDuringReopen: openAt(terminalStreams, reopenFrom, reopenTo),
      openAfterReopen: settledOpen,
      desyncsToEarlierTerminals: reopenReport.desyncs - desyncsBefore,
      reopenMs: reopenTo - reopenFrom,
    };

    // Control: one bearer stream per terminal, as before GW-3, on a fresh link.
    const controlLink = await startOutageLink({
      owner: "control",
      gatewayUrl: status.browserUrl!,
      rendererUrl: status.rendererUrl!,
    });
    links.push(controlLink);
    const control = await context.newPage();
    await control.goto(new URL(BLANK_PATH, controlLink.url).href);
    const controlResult = await control.evaluate(
      async ({ token, sessionIds, streams, waitMs }) => {
        const headers = { authorization: `Bearer ${token}` };
        const aborts: AbortController[] = [];
        const opened = await Promise.all(
          sessionIds.slice(0, streams).map(async (session) => {
            const abort = new AbortController();
            aborts.push(abort);
            const query = new URLSearchParams({ includeEvents: `terminal-output-${session}` });
            const response = await fetch(`/__orkestrator/events?${query}`, {
              headers,
              signal: abort.signal,
            });
            return response.status;
          }),
        );
        const started = performance.now();
        const answered = await Promise.race([
          fetch("/__orkestrator/invoke", {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ command: "get_projects", args: {} }),
          }).then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), waitMs)),
        ]);
        const waitedMs = Math.round(performance.now() - started);
        for (const abort of aborts) abort.abort();
        return { opened, answered, waitedMs };
      },
      { token, sessionIds: sessions, streams: CONTROL_STREAMS, waitMs: CONTROL_WAIT_MS },
    );
    evidence.control = {
      streams: CONTROL_STREAMS,
      streamStatuses: controlResult.opened,
      invokeAnsweredWithin: controlResult.answered ? controlResult.waitedMs : null,
      waitedMs: controlResult.waitedMs,
    };
    await control.close();

    expect(linkOpen.max, "the link saw more than one terminal stream open").toBe(1);
    expect(linkOpen.min, "no terminal stream was open while terminals printed").toBe(1);
    expect(browserOpen.max, "the browser held more than one terminal stream").toBe(1);
    expect(mainOpen.max).toBe(1);
    expect((evidence.streaming as { terminalsWithOutput: number }).terminalsWithOutput).toBe(
      TERMINALS,
    );
    for (const durations of [sequentialMs, burstMs]) {
      expect(Math.max(...durations), "an /invoke waited behind the streams").toBeLessThan(
        INVOKE_BUDGET_MS,
      );
    }
    expect(terminalStreams.length - streamsBefore.length, "the stream was not rebuilt once").toBe(
      1,
    );
    expect(settledOpen.max, "the old terminal stream stayed open").toBe(1);
    expect(reopenReport.desyncs - desyncsBefore, "earlier terminals were not told to re-read").toBe(
      TERMINALS,
    );
    expect(controlResult.opened.every((code) => code === 200)).toBe(true);
    // Six streams fill the browser's connections to this origin.
    expect(controlResult.answered, "the control /invoke was not held by six streams").toBe(false);
    await page.evaluate(() => window.bearerClient.dispose());
  } finally {
    try {
      const output = path.join(repositoryRoot, "output", "agent-testing", runId);
      mkdirSync(output, { recursive: true });
      writeFileSync(
        path.join(output, "bearer-terminal-stream.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
    } finally {
      for (const link of links) await link.close().catch(() => undefined);
      for (const sessionId of sessions) {
        await invoke("close_local_terminal_session", { sessionId }).catch(() => undefined);
      }
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  }
});

function summarize(durations: number[]) {
  return {
    count: durations.length,
    p50Ms: percentile(durations, 0.5),
    p90Ms: percentile(durations, 0.9),
    maxMs: Math.max(...durations),
  };
}

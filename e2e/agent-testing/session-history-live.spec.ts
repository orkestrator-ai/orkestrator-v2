/**
 * Fork, rewind and branch switching on the profile's real Codex app-server and
 * real Pi SDK, against a loopback model (`session-history-loopback-model.ts`):
 * no login and no billed turn. To-do 0006, task 6.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_SESSION_HISTORY=1`) against an already
 * running `dev:test --fixture` profile. Start it with a made-up Codex key so no
 * real login is copied in, and with both platforms provisioned:
 *
 *   CODEX_HOME=<throwaway dir whose auth.json holds a made-up OPENAI_API_KEY> \
 *   ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
 *     mise run dev:test --profile <name> --fixture --headless \
 *     --credential-source codex --agent-platforms codex,pi
 *
 * The spec points the profile's own Codex home (`openai_base_url`) and its own
 * Pi agent directory (`models.json`) at the loopback, never the host's, and
 * restores both afterwards. `ORKESTRATOR_AGENT_TEST_SESSION_HISTORY_PLATFORMS`
 * narrows the run (`codex`, `pi`; both by default).
 *
 * Every step goes through the profile's gateway as the renderer's commands do,
 * with the fork boundaries the renderer would send. Three turns, then:
 *
 * 1. Fork at the first response: the fork shows turn 1 only, and its next
 *    model call sees turn 1's marker and the new one.
 * 2. Fork at the third prompt (the "edit and resend" fork): the fork shows
 *    turns 1 and 2.
 * 3. Rewind the source to before the second prompt: it shows turn 1 only, also
 *    after a bridge reload before the next prompt, and its next model call
 *    does not see turns 2 or 3.
 * 4. Pi only: switch back to the branch that ends at turn 3.
 * 5. Reload: the platform's bridge is replaced by a new process, and every
 *    session's next transcript read matches what it showed before.
 *
 * The model's view is checked from the loopback's own record of the markers
 * each call carried, which is the vendor's truth about what the conversation
 * holds. Only markers, ids and counts reach annotations.
 */
import { expect, test, type Page } from "./browser-test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { createHistoryEnvironment, cleanupHistoryEnvironment } from "./session-history-environment";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import { DEFAULT_NATIVE_AGENT_LIVE_WINDOW } from "@orkestrator/protocol/native-agent";

type Status = {
  status: string;
  profile?: string;
  browserUrl?: string;
  testProject?: string;
  dataDir?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Part = { type?: string; content?: unknown; sourceMessageId?: string; parts?: Part[] };
type Row = {
  id: string;
  role: string;
  content?: unknown;
  parts?: Part[];
  turnId?: string;
  latestSourceMessageId?: string;
};
type ProjectionUpdate = {
  status: string;
  projection?: { turn: { phase: string; error?: string }; messages: Row[] };
  historyCursor?: string;
};
type ForkOutcome = { sessionId: string; title?: string; draft?: string; controls?: unknown };
type Platform = "codex" | "pi";
type Call = { api: string; markers: string[] };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_SESSION_HISTORY === "1";
const PLATFORMS = (process.env.ORKESTRATOR_AGENT_TEST_SESSION_HISTORY_PLATFORMS ?? "codex,pi")
  .split(",")
  .map((name) => name.trim())
  .filter((name): name is Platform => name === "codex" || name === "pi");
const PI_PROVIDER = "history-loopback";
const PI_MODEL = "loop-1";
const TURN_TIMEOUT_MS = 3 * 60_000;

test.describe.configure({ mode: "serial" });
test.use({ trace: "off" });

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(`dev:status for "${profile}" returned no manifest`);
  const status = JSON.parse(command.stdout) as Status;
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  expect(status.dataDir, "dev:status reported no data directory").toBeTruthy();
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
      { data: { command: name, args }, timeout: 120_000 },
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

async function startLoopbackModel(): Promise<{ origin: string; child: ChildProcess }> {
  const child = spawn(
    "bun",
    [path.join(import.meta.dirname, "session-history-loopback-model.ts")],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const lines = createInterface({ input: child.stdout! });
  const origin = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    child.once("exit", () => reject(new Error("the loopback model exited")));
  });
  return { origin, child };
}

async function loopbackCalls(origin: string): Promise<Call[]> {
  const response = await fetch(`${origin}/__calls`);
  return (await response.json()) as Call[];
}

/** Points the profile's own Codex home at the loopback; returns the restore. */
function pointCodexAt(status: Status, baseUrl: string): () => void {
  const configFile = path.join(status.dataDir!, "agent-credentials", "codex", "config.toml");
  const restore = snapshotFixtureFiles([configFile]);
  const earlier = existsSync(configFile)
    ? readFileSync(configFile, "utf8").replace(/^openai_base_url = .*\n/m, "")
    : "";
  // A top-level key goes before any table.
  writeFileSync(configFile, `openai_base_url = ${JSON.stringify(baseUrl)}\n${earlier}`, {
    mode: 0o600,
  });
  return restore;
}

/**
 * Adds the loopback provider to the profile's own Pi `models.json`. Agent-test
 * backends run with `HOME=<dataDir>/agent-credentials/home`, so the local Pi
 * bridge reads `~/.pi/agent` there, never the host's.
 */
function pointPiAt(status: Status, baseUrl: string): () => void {
  const directory = path.join(status.dataDir!, "agent-credentials", "home", ".pi", "agent");
  const file = path.join(directory, "models.json");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const restore = snapshotFixtureFiles([file]);
  const existing = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { providers?: Record<string, unknown> })
    : {};
  const config = {
    ...existing,
    providers: {
      ...existing.providers,
      [PI_PROVIDER]: {
        name: "History loopback",
        baseUrl,
        api: "openai-completions",
        // A literal placeholder: the only server it can reach is the loopback.
        apiKey: "history-loopback-no-provider",
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
        },
        models: [
          {
            id: PI_MODEL,
            name: "Loop 1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32_000,
            maxTokens: 256,
          },
        ],
      },
    },
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return restore;
}

/**
 * The id of the Pi entry that acknowledges `marker`, read from the session
 * files the profile's Pi bridges wrote since `since` (`PI_SESSION_DIR` is
 * `<dataDir>/pi-bridge-sessions/<environment>`). Only the source session
 * holds turn 3, so exactly one entry matches.
 */
function piEntryAcknowledging(status: Status, since: number, marker: string): string {
  const root = path.join(status.dataDir!, "pi-bridge-sessions");
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".jsonl") && statSync(file).mtimeMs >= since) {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const record = JSON.parse(line) as {
            type?: string;
            id?: string;
            message?: { role?: string; content?: unknown };
          };
          if (record.type !== "message" || record.message?.role !== "assistant") continue;
          if (JSON.stringify(record.message.content).includes(`Acknowledged ${marker}.`)) {
            found.push(record.id!);
          }
        }
      }
    }
  };
  walk(root);
  expect(found, `Pi entries acknowledging ${marker}`).toHaveLength(1);
  return found[0]!;
}

function rowText(row: Row): string {
  if (typeof row.content === "string" && row.content) return row.content;
  const texts: string[] = [];
  const walk = (parts: Part[] | undefined) => {
    for (const part of parts ?? []) {
      if (part.type === "text" && typeof part.content === "string") texts.push(part.content);
      walk(part.parts);
    }
  };
  walk(row.parts);
  return texts.join("\n");
}

const markersIn = (text: string) => [...text.matchAll(/\bHX\d+\b/g)].map((match) => match[0]);

/** The conversation as marker pairs: each user marker, and each acknowledged one. */
function conversation(rows: Row[]): string[] {
  const shape: string[] = [];
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    for (const marker of markersIn(rowText(row))) {
      shape.push(`${row.role === "user" ? "U" : "A"}:${marker}`);
    }
  }
  return shape;
}

// The renderer's own boundary rules (`native-agent-fork.ts`), on these rows.
function sourceId(id: string): string {
  const split = id.indexOf(":text-block:");
  return split < 0 ? id : id.slice(0, split);
}

function lastPartSource(parts: Part[] | undefined): string | undefined {
  for (const part of [...(parts ?? [])].reverse()) {
    const nested = lastPartSource(part.parts);
    if (nested) return nested;
    if (part.sourceMessageId) return part.sourceMessageId;
  }
  return undefined;
}

function boundarySourceId(row: Row): string {
  return row.latestSourceMessageId ?? lastPartSource(row.parts) ?? sourceId(row.id);
}

function responseBoundary(platform: Platform, row: Row): string {
  return platform === "codex" ? sourceId(row.id) : boundarySourceId(row);
}

/** A prompt fork branches at the response before the prompt. */
function promptBoundary(platform: Platform, rows: Row[], prompt: Row): string {
  const index = rows.findIndex((row) => row.id === prompt.id);
  const before = rows
    .slice(0, index)
    .reverse()
    .find((row) =>
      platform === "codex"
        ? Boolean(row.turnId) && row.turnId !== prompt.turnId
        : row.role === "user" || row.role === "assistant",
    );
  if (!before) throw new Error("the prompt has no earlier message to branch at");
  return platform === "codex" ? sourceId(before.id) : boundarySourceId(before);
}

function userRow(rows: Row[], marker: string): Row {
  const row = rows.find(
    (candidate) => candidate.role === "user" && rowText(candidate).includes(marker),
  );
  if (!row) throw new Error(`no prompt row holds ${marker}`);
  return row;
}

function responseRow(rows: Row[], marker: string): Row {
  const row = [...rows]
    .reverse()
    .find(
      (candidate) =>
        candidate.role === "assistant" && rowText(candidate).includes(`Acknowledged ${marker}`),
    );
  if (!row) throw new Error(`no response row acknowledges ${marker}`);
  return row;
}

test.describe("fork and rewind on loopback models", () => {
  test.skip(
    !LIVE_OPT_IN,
    "opt-in loopback-model turns against the isolated fixture; set ORKESTRATOR_AGENT_TEST_LIVE_SESSION_HISTORY=1",
  );

  for (const platform of PLATFORMS) {
    test(`${platform}: fork, rewind and reload agree with the vendor`, async ({ page }) => {
      test.setTimeout(20 * 60_000);
      const status = profileStatus();
      const invoke = await signIn(page, status);
      const fixture = (await invoke<Project[]>("get_projects")).find(
        (project) => project.localPath === status.testProject,
      );
      expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
      note("model", `${platform}: loopback model, no login`);

      const startedAt = Date.now();
      const loopback = await startLoopbackModel();
      const restores: Array<() => void> = [];
      let environment: Environment | undefined;
      try {
        // The loopback is in place before the environment's bridge starts.
        restores.push(
          platform === "codex"
            ? pointCodexAt(status, `${loopback.origin}/v1`)
            : pointPiAt(status, `${loopback.origin}/v1`),
        );
        environment = await createHistoryEnvironment<Environment>(
          invoke,
          fixture!.id,
          `history-${platform}`,
        );
        const environmentId = environment.id;
        const model = platform === "pi" ? `${PI_PROVIDER}/${PI_MODEL}` : undefined;
        const tab = (name: string) => ({
          environmentId,
          agent: platform,
          logicalSessionKey: `env-${environmentId}:history-${name}`,
        });
        const source = tab("source");
        await invoke("ensure_native_agent_session", { ...source, ...(model ? { model } : {}) });

        const snapshot = async (identity: ReturnType<typeof tab>) => {
          const update = await invoke<ProjectionUpdate>("get_native_agent_projection_update", {
            ...identity,
            syncVersion: 1,
            liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
            forceSnapshot: true,
          });
          expect(update.status).toBe("snapshot");
          expect(update.historyCursor, "a short conversation fits the live window").toBeFalsy();
          return update.projection!;
        };
        const rowsOf = async (identity: ReturnType<typeof tab>) =>
          (await snapshot(identity)).messages;
        let prompts = 0;
        /** Sends one prompt and waits for its acknowledgement; returns the model call it made. */
        const prompt = async (identity: ReturnType<typeof tab>, marker: string) => {
          const before = (await loopbackCalls(loopback.origin)).length;
          prompts += 1;
          await invoke("dispatch_native_agent_prompt", {
            ...identity,
            prompt: `History check ${marker}. Reply briefly.`,
            requestId: `history-${platform}-${prompts}-${Date.now()}`,
            ...(model ? { model } : {}),
          });
          await expect
            .poll(
              async () => {
                const projection = await snapshot(identity);
                if (projection.turn.phase === "error") {
                  throw new Error(`turn failed: ${projection.turn.error ?? "no error"}`);
                }
                const acknowledged = projection.messages.some(
                  (row) =>
                    row.role === "assistant" && rowText(row).includes(`Acknowledged ${marker}`),
                );
                return acknowledged && projection.turn.phase === "idle";
              },
              { timeout: TURN_TIMEOUT_MS, intervals: [1_000] },
            )
            .toBe(true);
          const calls = (await loopbackCalls(loopback.origin)).slice(before);
          const call = calls.findLast((candidate) => candidate.markers.at(-1) === marker);
          expect(call, `no model call carried ${marker}`).toBeTruthy();
          return call!;
        };

        /** Replaces the environment's bridge with a new process. */
        const reloadBridge = async () => {
          const server = `local_${platform}_server`;
          const old = await invoke<{ pid: number | null }>(`get_${server}_status`, {
            environmentId,
          });
          expect(old.pid, `no ${platform} bridge was running`).toBeGreaterThan(0);
          await invoke(`stop_${server}_cmd`, { environmentId });
          const restarted = await invoke<{ pid: number }>(`start_${server}_cmd`, { environmentId });
          expect(restarted.pid, "the bridge was not replaced").not.toBe(old.pid);
        };

        // Three turns on the source.
        await prompt(source, "HX1");
        await prompt(source, "HX2");
        const third = await prompt(source, "HX3");
        expect(third.markers).toEqual(["HX1", "HX2", "HX3"]);
        const sourceRows = await rowsOf(source);
        expect(conversation(sourceRows)).toEqual([
          "U:HX1",
          "A:HX1",
          "U:HX2",
          "A:HX2",
          "U:HX3",
          "A:HX3",
        ]);
        note("source", { rows: sourceRows.length, ids: sourceRows.map((row) => row.id) });

        // 1. Fork at the first response.
        const responseFork = await invoke<ForkOutcome>("fork_native_agent_session", {
          ...source,
          messageId: responseBoundary(platform, responseRow(sourceRows, "HX1")),
        });
        const responseTab = tab("fork-response");
        await invoke("adopt_native_agent_session", {
          ...responseTab,
          providerSessionId: responseFork.sessionId,
          ...(responseFork.controls ? { controls: responseFork.controls } : {}),
        });
        expect(conversation(await rowsOf(responseTab)), "the response fork's transcript").toEqual([
          "U:HX1",
          "A:HX1",
        ]);
        const responseForkCall = await prompt(responseTab, "HX4");
        expect(responseForkCall.markers, "the response fork's model context").toEqual([
          "HX1",
          "HX4",
        ]);
        note("fork-at-response", {
          draft: responseFork.draft ?? null,
          call: responseForkCall.markers,
        });

        // 2. Fork at the third prompt: the fork keeps turns 1 and 2.
        const promptFork = await invoke<ForkOutcome>("fork_native_agent_session", {
          ...source,
          messageId: promptBoundary(platform, sourceRows, userRow(sourceRows, "HX3")),
        });
        const promptTab = tab("fork-prompt");
        await invoke("adopt_native_agent_session", {
          ...promptTab,
          providerSessionId: promptFork.sessionId,
          ...(promptFork.controls ? { controls: promptFork.controls } : {}),
        });
        expect(conversation(await rowsOf(promptTab)), "the prompt fork's transcript").toEqual([
          "U:HX1",
          "A:HX1",
          "U:HX2",
          "A:HX2",
        ]);
        const promptForkCall = await prompt(promptTab, "HX5");
        expect(promptForkCall.markers, "the prompt fork's model context").toEqual([
          "HX1",
          "HX2",
          "HX5",
        ]);
        note("fork-at-prompt", { draft: promptFork.draft ?? null, call: promptForkCall.markers });

        // The source is unchanged by either fork.
        expect(conversation(await rowsOf(source))).toEqual(conversation(sourceRows));

        // 3. Rewind the source to before the second prompt.
        await invoke("perform_native_agent_session_action", {
          ...source,
          action: { kind: "rewind-messages", messageId: sourceId(userRow(sourceRows, "HX2").id) },
        });
        expect(conversation(await rowsOf(source)), "the rewound transcript").toEqual([
          "U:HX1",
          "A:HX1",
        ]);
        // A reload before anything is appended under the rewind keeps it.
        await reloadBridge();
        expect(conversation(await rowsOf(source)), "the rewound transcript after a reload").toEqual(
          ["U:HX1", "A:HX1"],
        );
        const rewoundCall = await prompt(source, "HX6");
        expect(rewoundCall.markers, "the rewound model context").toEqual(["HX1", "HX6"]);
        note("rewind", { call: rewoundCall.markers });

        // 4. Pi keeps the abandoned branch: switch back to it. No client
        // surface lists another branch's entries (live rows carry bridge ids),
        // so the entry id comes from Pi's own session file.
        if (platform === "pi") {
          const entryId = piEntryAcknowledging(status, startedAt, "HX3");
          const staleRowSwitch = await page.request.post(
            new URL("/__orkestrator/invoke", status.browserUrl!).href,
            {
              data: {
                command: "perform_native_agent_session_action",
                args: {
                  ...source,
                  action: {
                    kind: "switch-branch",
                    entryId: sourceId(responseRow(sourceRows, "HX3").id),
                  },
                },
              },
            },
          );
          expect(
            staleRowSwitch.ok(),
            "a live row id from before the rewind names no Pi entry",
          ).toBe(false);
          expect(await staleRowSwitch.text()).toContain("409");
          await invoke("perform_native_agent_session_action", {
            ...source,
            action: { kind: "switch-branch", entryId },
          });
          expect(conversation(await rowsOf(source)), "the restored branch").toEqual(
            conversation(sourceRows),
          );
          const branchCall = await prompt(source, "HX7");
          expect(branchCall.markers, "the restored branch's model context").toEqual([
            "HX1",
            "HX2",
            "HX3",
            "HX7",
          ]);
          note("switch-branch", { call: branchCall.markers });
        }

        // 5. Reload: a new bridge process, then the next transcript read of each session.
        const tabs = [source, responseTab, promptTab];
        const before = await Promise.all(
          tabs.map(async (identity) => conversation(await rowsOf(identity))),
        );
        await reloadBridge();
        const after = await Promise.all(
          tabs.map(async (identity) => conversation(await rowsOf(identity))),
        );
        expect(after, "every session reads back the same conversation after a reload").toEqual(
          before,
        );
        // And the reloaded source still continues the conversation it shows.
        const reloadedCall = await prompt(source, "HX8");
        expect(reloadedCall.markers.slice(0, -1)).toEqual(
          before[0]!.filter((entry) => entry.startsWith("U:")).map((entry) => entry.slice(2)),
        );
        note("reload", { before, after, call: reloadedCall.markers });
      } finally {
        if (environment) {
          await cleanupHistoryEnvironment(invoke, environment.id);
        }
        for (const restore of restores.reverse()) restore();
        loopback.child.kill();
      }
    });
  }
});

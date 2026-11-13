/**
 * Shared by `suborks-live.spec.ts` and `suborks-restart-live.spec.ts`
 * (4340 (retired) tasks 1 and 4): the scripted model's wiring into a profile's
 * own Pi and OpenCode settings, the tab layout, the `/subork` dispatch and the
 * waits on a call's durable row.
 *
 * Every file the wiring changes is under the profile's data directory (never
 * `~/.pi` or a real OpenCode home) and is restored by the returned `stop`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { NativeAgentSuborkBatchView } from "@orkestrator/protocol/suborks";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import { pointPiAt } from "./coordinator-two-node-support";
import { startModel } from "./idle-observation-fake-models";
import {
  allowOpenCodeFakeProvider,
  mergeOpenCodeFakeProvider,
  profileOpenCodeConfigFile,
} from "./opencode-fake-provider";
import { profileStatus, type Invoke, type Status } from "./slash-command-live-support";
import type { TurnFacts } from "./suborks-fake-model-script";

export const ALL_PLATFORMS = ["claude", "codex", "opencode", "cursor", "grok", "pi"] as const;
export type Platform = (typeof ALL_PLATFORMS)[number];

export const FAKE_PROVIDER = "subqa-fake";
export const FAKE_MODEL = "subqa-1";
/** `provider/modelId`, how a Pi or OpenCode dispatch names the fake. */
export const FAKE_MODEL_REF = `${FAKE_PROVIDER}/${FAKE_MODEL}`;
const FAKE_SCRIPT = path.join(import.meta.dirname, "suborks-fake-model.ts");

/** A fresh `QATAG` tag for one call. */
export function newTag(): string {
  return `QATAG${randomBytes(4).toString("hex").toUpperCase()}`;
}

export interface FakeCalls {
  refused: number;
  completions: Record<string, number>;
  toolCalls: Record<string, number>;
  turns: Array<TurnFacts & { platform: string }>;
  held: string[];
}

export interface ScriptedModel {
  origin: string;
  calls(): Promise<FakeCalls>;
  hold(tag: string): Promise<void>;
  release(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Starts `suborks-fake-model.ts` and points the profile's own Pi and OpenCode
 * at it: Pi's isolated `models.json`/`settings.json` (its saved default
 * becomes the fake), OpenCode's isolated global `opencode.json` (the fake
 * becomes its only provider) and Orkestrator's OpenCode provider allowlist.
 */
export async function startScriptedModel(status: Status, invoke: Invoke): Promise<ScriptedModel> {
  const dataDir = status.dataDir;
  if (!dataDir) throw new Error("dev:status names no data directory");
  const model = await startModel(FAKE_SCRIPT);
  const undo: Array<() => unknown> = [
    () =>
      new Promise<void>((resolve) => {
        if (model.child.exitCode !== null || model.child.signalCode !== null) return resolve();
        model.child.once("exit", () => resolve());
        model.child.kill("SIGTERM");
      }),
  ];
  const stop = async () => {
    const errors: unknown[] = [];
    for (const step of undo.splice(0).reverse()) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "scripted model cleanup failed");
  };
  try {
    undo.push(
      pointPiAt(status, `${model.origin}/pi/v1`, {
        id: FAKE_PROVIDER,
        name: "Subork fake",
        model: FAKE_MODEL,
        modelName: "Subork QA 1",
        apiKey: "fixture-only-not-a-key",
      }),
    );
    const file = profileOpenCodeConfigFile(dataDir);
    if (!path.resolve(file).startsWith(`${path.resolve(dataDir)}${path.sep}`)) {
      throw new Error("OpenCode settings escape the profile");
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    undo.push(snapshotFixtureFiles([file]));
    writeFileSync(
      file,
      mergeOpenCodeFakeProvider(existsSync(file) ? readFileSync(file, "utf8") : undefined, {
        provider: FAKE_PROVIDER,
        providerName: "Subork fake",
        baseUrl: `${model.origin}/opencode/v1`,
        model: FAKE_MODEL,
        modelName: "Subork QA 1",
      }),
      { mode: 0o600 },
    );
    undo.push(await allowOpenCodeFakeProvider(invoke, FAKE_PROVIDER));
  } catch (error) {
    await stop();
    throw error;
  }
  const control = async (method: string, route: string) => {
    const response = await fetch(`${model.origin}${route}`, { method });
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
    return response.json();
  };
  return {
    origin: model.origin,
    calls: () => control("GET", "/__calls") as Promise<FakeCalls>,
    hold: async (tag) => void (await control("POST", `/__hold?tag=${tag}`)),
    release: async () => void (await control("POST", "/__release")),
    stop,
  };
}

export type Identity = { environmentId: string; agent: Platform; logicalSessionKey: string };

/** Opens one native tab per platform in one pane, so no tab closes while another works. */
export async function openTabs(
  invoke: Invoke,
  environmentId: string,
  platforms: readonly Platform[],
  container: string | null = null,
): Promise<Map<Platform, Identity>> {
  const layout = await invoke<{ revision?: number } | null>("get_pane_layout", { environmentId });
  const tabs = platforms.map((platform) => ({
    id: `subork-${platform}`,
    type: "agent-native",
    nativeAgentData: { environmentId, platform, isLocal: container === null },
  }));
  await invoke("save_pane_layout", {
    environmentId,
    expectedRevision: layout?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: container,
      activePaneId: "pane-suborks",
      root: { kind: "leaf", id: "pane-suborks", activeTabId: tabs[0]!.id, tabs },
    },
  });
  return new Map(
    platforms.map((platform) => [
      platform,
      {
        environmentId,
        agent: platform,
        logicalSessionKey: `env-${environmentId}:subork-${platform}`,
      },
    ]),
  );
}

export type Row = { id?: string; role?: string; content?: unknown; parts?: unknown };
export type Projection = {
  turn: { phase: string; error?: string };
  messages?: Row[];
  suborks?: NativeAgentSuborkBatchView[];
  notices?: unknown;
  recoverableDispatch?: unknown;
} | null;

export function rowText(row: Row): string {
  if (typeof row.content === "string") return row.content;
  const parts = Array.isArray(row.parts)
    ? row.parts
    : Array.isArray(row.content)
      ? row.content
      : [];
  return parts
    .map((part) =>
      part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : "",
    )
    .join("\n");
}

/** Types `/subork <request>` into the tab, as the composer sends it. */
export async function sendSubork(
  invoke: Invoke,
  identity: Identity,
  request: string,
  model?: string,
): Promise<void> {
  await invoke("dispatch_native_agent_intent", {
    ...identity,
    prompt: `/subork ${request}`,
    requestId: `subork-qa-${identity.agent}-${Date.now()}`,
    command: { kind: "typed" },
    ...(model ? { model } : {}),
  });
}

export async function until<T>(
  label: string,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs: number,
  describe: (value: T | undefined) => string = (value) =>
    JSON.stringify(value)?.slice(0, 2_000) ?? "",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError = "";
  let reported = Date.now();
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (ok(last)) return last;
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 300) : String(error);
    }
    // A content-free progress line every 30 s, so a long wait is visible (and
    // a logged runner's no-output watchdog sees the suite is alive).
    if (Date.now() - reported >= 30_000) {
      reported = Date.now();
      console.log(`[suborks] still waiting for ${label}: ${describe(last).slice(0, 600)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? ` (last error: ${lastError})` : ""}\nlast: ${describe(last)}`,
  );
}

/** What the fake saw of one call, by role and platform: counts only. */
export function callFacts(calls: FakeCalls, tag: string): Record<string, number> {
  const facts: Record<string, number> = {};
  for (const turn of calls.turns) {
    if (turn.tag !== tag) continue;
    const key = `${turn.role}:${turn.platform}:${turn.turnStart ? "start" : "step"}`;
    facts[key] = (facts[key] ?? 0) + 1;
  }
  facts.held = calls.held.filter((entry) => entry.endsWith(tag)).length;
  return facts;
}

/**
 * Copies the profile's bounded, content-free logs into the test's output, so a
 * failure keeps them after the isolated runner resets the profile.
 */
export function keepProfileLogs(profile: string, destination: string): void {
  try {
    const logDir = (profileStatus(profile) as { logDir?: string }).logDir;
    if (logDir && existsSync(logDir)) cpSync(logDir, destination, { recursive: true });
  } catch {
    // Evidence only: a missing log directory must not mask the failure.
  }
}

/** A content-free view of a projection for a failure message. */
export function describeProjection(
  view: Projection | undefined,
  options: { lines?: boolean } = {},
): string {
  return JSON.stringify({
    turn: view?.turn,
    rows: view?.messages?.length,
    // `line` can hold the start of an answer, so only a scripted run (whose
    // answers are fixed fake text) keeps it.
    suborks: view?.suborks?.map((batch) => ({
      status: batch.status,
      delivery: batch.delivery,
      deliveryDetail: batch.deliveryDetail,
      suborks: batch.suborks.map(({ line, ...rest }) => ({
        ...rest,
        ...(options.lines && line ? { line: line.slice(0, 200) } : {}),
      })),
    })),
    notices: view?.notices,
    recoverableDispatch: view?.recoverableDispatch,
  }).slice(0, 3_000);
}

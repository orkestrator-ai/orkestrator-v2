import { readStoredValue } from "../apps/backend/src/core/storage-test-support";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  startFakeAnthropicModel,
  type FakeAnthropicModel,
} from "../e2e/agent-testing/fake-anthropic-model";
import { pickKindCounters, type KindCounters } from "./recurring-live-ab-summary";
import { checkoutEnv, withTerminationSignals } from "./recurring-live-ab";

/**
 * Agent mail into a real claude-tmux tab on a loopback fake model: the live
 * evidence for BG-15 (to-do 1202 task 1, to-do 7211).
 *
 * It drives a running, credential-free `dev:test` profile through its
 * gateway. It starts a loopback Anthropic Messages endpoint
 * (`e2e/agent-testing/fake-anthropic-model.ts`) and points the profile's own
 * isolated Claude directory (`<dataDir>/agent-credentials/claude`, never a
 * real Claude home) at it with a fixture token. It opens one claude-tmux tab
 * on the fixture's local environment, waits until the real Claude CLI in it
 * is idle, and turns mail injection on for that tab. Then:
 *
 * 0. Priming: one queued prompt is typed into the tab and one draft is saved
 *    and cleared, as any user of the tab does. A keyed read of a store that
 *    was never written is not counted, and a fresh profile has neither store,
 *    so without this the queue and draft reads BG-15 removed would be
 *    invisible on both sides.
 * 1. Idle: it reads the `mail-injection` counters across a quiet window, which
 *    gives the storage reads of a drain pass with nothing to deliver.
 * 2. Deliveries: it sends `--deliveries` messages one at a time. Each must be
 *    typed into the tab (`injectedAt`) and reach the fake model exactly once,
 *    and the tab must go idle again. The counters are read on either side.
 * 3. Draft hold: it saves a compose draft on the tab, sends one more message,
 *    checks that it is not typed and never reaches the model, deletes the
 *    draft and checks that the message is then delivered.
 *
 * Afterwards it stops the tab's tmux session and restores the two Claude
 * files it changed. Stopping and resetting the profile is the caller's.
 *
 *   mise run dev:test --profile bg15-after --fixture --fixture-environments local \
 *     --no-agent-credentials --agent-platforms claude --headless
 *   mise exec -- bun scripts/tmux-mail-inject-live.ts --profile bg15-after \
 *     [--checkout /abs/path/to/older/worktree] [--deliveries 5] [--out output/benchmarks/x.json]
 *   mise run dev:stop --profile bg15-after && mise run dev:reset --profile bg15-after
 *
 * `--checkout` names the checkout that started the profile, so `dev:status`
 * runs there. No billed turn is possible: the CLI's only endpoint is the
 * loopback model. The gateway token is read from the profile's mode-0600
 * auth file and only sent as a loopback request header. The artifact holds
 * counts, durations and outcomes only, never prompts, mail bodies or tokens.
 */

type Options = {
  profile: string;
  checkout?: string;
  deliveries: number;
  quietMs: number;
  out: string;
};

export function parseOptions(argv: string[]): Options {
  const options: Partial<Options> = {
    deliveries: 5,
    quietMs: 30_000,
    out: `output/benchmarks/tmux-mail-inject-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    index += 1;
    if (name === "--profile") {
      if (!/^[a-z0-9-]+$/.test(value)) throw new Error("--profile takes a profile name");
      options.profile = value;
    } else if (name === "--checkout") {
      if (!path.isAbsolute(value)) throw new Error("--checkout takes an absolute path");
      options.checkout = value;
    } else if (name === "--deliveries" || name === "--quiet-ms") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1)
        throw new Error(`${name} needs a positive integer`);
      if (name === "--deliveries") options.deliveries = parsed;
      else options.quietMs = parsed;
    } else if (name === "--out") options.out = value;
    else throw new Error(`Unknown option ${name}`);
  }
  if (!options.profile) throw new Error("--profile is required");
  return options as Options;
}

type Status = {
  status?: string;
  dataDir?: string;
  browserUrl?: string;
  authFile?: string;
};

type Environment = {
  id: string;
  environmentType?: string;
  worktreePath?: string | null;
  status?: string;
};

const log = (message: string) => console.error(`[tmux-mail-inject-live] ${message}`);

function profileStatus(options: Options): Status {
  const result = spawnSync("mise", ["run", "dev:status", "--profile", options.profile, "--json"], {
    encoding: "utf8",
    env: checkoutEnv(options.checkout),
    ...(options.checkout ? { cwd: options.checkout } : {}),
  });
  return JSON.parse(result.stdout) as Status;
}

/**
 * The gateway's whole metrics document, unvalidated, for drivers that need
 * more than {@link gatewayFor}'s `kinds` (unattributed work, signal health).
 * Same loopback and token rules; the token never leaves this function.
 */
export async function gatewayMetrics(
  status: Status,
  signal?: AbortSignal,
  request: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): Promise<unknown> {
  const { origin, token } = gatewayCredentials(status);
  const response = await request(new URL("/__orkestrator/metrics", origin), {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Metrics request failed: HTTP ${response.status}`);
  return response.json();
}

function gatewayCredentials(status: Status) {
  if (!status.browserUrl || !status.authFile) throw new Error("Profile has no browser gateway");
  const origin = new URL(status.browserUrl);
  if (origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost") {
    throw new Error("Profile browser gateway is not loopback; refusing to send its token");
  }
  const token = (JSON.parse(readFileSync(status.authFile, "utf8")) as { token?: unknown }).token;
  if (typeof token !== "string" || !token) throw new Error("Gateway auth file has no token");
  return { origin, token };
}

/** Backend commands over the profile's gateway; the token stays in here. */
export function gatewayFor(
  status: Status,
  signal?: AbortSignal,
  request: (url: URL, init: RequestInit) => Promise<Response> = fetch,
) {
  const { origin, token } = gatewayCredentials(status);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    async invoke<T>(
      command: string,
      args: Record<string, unknown> = {},
      cleanup = false,
    ): Promise<T> {
      const response = await request(new URL("/__orkestrator/invoke", origin), {
        method: "POST",
        headers,
        body: JSON.stringify({ command, args }),
        redirect: "error",
        signal:
          !cleanup && signal
            ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
            : AbortSignal.timeout(60_000),
      });
      const payload = (await response.json()) as { result?: T; error?: string };
      if (!response.ok || payload.error)
        throw new Error(`${command}: ${payload.error ?? "failed"}`);
      return payload.result as T;
    },
    async kinds(): Promise<Record<string, KindCounters>> {
      const response = await request(new URL("/__orkestrator/metrics", origin), {
        headers,
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Metrics request failed: HTTP ${response.status}`);
      const metrics = (await response.json()) as {
        recurringWork?: { metrics?: { kinds?: unknown } };
      };
      const raw = metrics.recurringWork?.metrics?.kinds as Record<string, KindCounters> | undefined;
      const mail = raw?.["mail-injection"];
      const counts = mail && [
        mail.started,
        mail.changed,
        mail.failed,
        mail.bytes,
        mail.workUnits?.["storage-read"],
      ];
      if (
        !counts ||
        !counts.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
      )
        throw new Error("Mail-injection measurement counters unavailable or invalid");
      return pickKindCounters(raw);
    },
  };
}

type Gateway = ReturnType<typeof gatewayFor>;

/** Counter movement per kind between two reads, only for kinds that moved. */
export function kindDelta(
  before: Record<string, KindCounters>,
  after: Record<string, KindCounters>,
): Record<string, { started: number; storageReads: number; bytes: number }> {
  if (!before["mail-injection"] || !after["mail-injection"])
    throw new Error("Mail-injection measurement counters unavailable");
  const delta: Record<string, { started: number; storageReads: number; bytes: number }> = {};
  for (const [kind, counters] of Object.entries(after)) {
    const prior = before[kind];
    const started = counters.started - (prior?.started ?? 0);
    const storageReads =
      (counters.workUnits["storage-read"] ?? 0) - (prior?.workUnits["storage-read"] ?? 0);
    const bytes = counters.bytes - (prior?.bytes ?? 0);
    if (![started, storageReads, bytes].every((value) => Number.isFinite(value) && value >= 0))
      throw new Error(`Measurement counters reset or invalid: ${kind}`);
    if (started || storageReads || bytes) delta[kind] = { started, storageReads, bytes };
  }
  return delta;
}

/**
 * Reads a delivery drain made beyond a drain pass with nothing to deliver:
 * every pass in the window is charged the idle cost, and what is left is the
 * delivery's own.
 */
export function deliveryReads(
  delta: { started: number; storageReads: number } | undefined,
  idleReadsPerPass: number,
): number {
  if (
    !delta ||
    delta.started < 1 ||
    ![delta.started, delta.storageReads, idleReadsPerPass].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  )
    throw new Error("No valid measured mail-injection pass");
  return Math.round((delta.storageReads - delta.started * idleReadsPerPass) * 100) / 100;
}

async function pollFor<T>(
  label: string,
  timeoutMs: number,
  probe: () => Promise<T | null | undefined | false>,
  signal?: AbortSignal,
  sleep = abortableSleep,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const value = await probe().catch(() => null);
    signal?.throwIfAborted();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(250, signal);
  }
}

type TmuxStatus = { running?: boolean; busy?: boolean; session_id?: string | null };
type MailStatus = { injectedAt?: string; placement?: string; placementReason?: string };

/**
 * The profile's own isolated Claude directory. Refuses a data directory that
 * is not `…/profiles/<profile>/data`, the layout every `dev:test` profile
 * has, so a wrong manifest can never point this at a real installation.
 */
export function profileClaudeDirectory(dataDir: string, profile: string): string {
  const resolved = path.resolve(dataDir);
  const parts = resolved.split(path.sep);
  if (parts.at(-1) !== "data" || parts.at(-2) !== profile || parts.at(-3) !== "profiles")
    throw new Error("Refusing a data directory outside a dev:test profile");
  return path.join(resolved, "agent-credentials", "claude");
}

/** Fail closed before fixture writes or launching any provider process. */
export function isolatedClaudeDirectory(dataDir: string, profile: string): string {
  const directory = profileClaudeDirectory(dataDir, profile);
  const manifest = JSON.parse(readFileSync(path.join(dataDir, "..", "profile.json"), "utf8")) as {
    id?: string;
    flavor?: string;
    dataDir?: string;
    credentialSources?: unknown;
  };
  if (
    manifest.id !== profile ||
    manifest.flavor !== "agent-test" ||
    manifest.dataDir !== path.resolve(dataDir) ||
    !Array.isArray(manifest.credentialSources) ||
    manifest.credentialSources.length !== 0
  )
    throw new Error(
      "Benchmark requires a credential-free dev:test profile (--no-agent-credentials)",
    );
  // Read only this profile's registry, never probe host credential directories.
  // Older --checkout targets still keep this registry as JSON. Do not open
  // a new database in those profiles just to inspect their account choice.
  const legacy = path.join(dataDir, "agent-accounts.json");
  // Snapshot JSON first: opening the database can migrate/move that file.
  const registries = [
    existsSync(legacy)
      ? (JSON.parse(readFileSync(legacy, "utf8")) as { active?: { claude?: unknown } })
      : undefined,
    existsSync(path.join(dataDir, "orkestrator.sqlite"))
      ? readStoredValue<{ active?: { claude?: unknown } }>(dataDir, "agent-accounts.json")
      : undefined,
  ];
  // An older checkout can still read JSON even if another tool opened a DB.
  // Reject either active override rather than guessing which backend is live.
  if (
    registries.some(
      (accounts) =>
        accounts !== undefined &&
        accounts.active?.claude !== undefined &&
        accounts.active.claude !== "default",
    )
  )
    throw new Error("Benchmark refuses an active added Claude account");
  return directory;
}

/** Saves and restores the files this run changes in the profile's Claude directory. */
function claudeFixture(
  directory: string,
  origin: string,
  worktreePath: string,
  write = writeFileSync,
) {
  const settingsPath = path.join(directory, "settings.json");
  const statePath = path.join(directory, ".claude.json");
  const saved = new Map<string, string | null>();
  const readJson = (file: string): Record<string, unknown> => {
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  for (const file of [settingsPath, statePath])
    saved.set(file, existsSync(file) ? readFileSync(file, "utf8") : null);
  const restore = () => {
    const failures: string[] = [];
    for (const [file, contents] of saved) {
      try {
        if (contents === null) rmSync(file, { force: true });
        else write(file, contents, { mode: 0o600 });
      } catch {
        failures.push(path.basename(file));
      }
    }
    if (failures.length) throw new Error(`Fixture rollback failed: ${failures.join(", ")}`);
  };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const settings = readJson(settingsPath);
    write(
      settingsPath,
      `${JSON.stringify(
        {
          ...settings,
          env: {
            ...(settings.env as Record<string, string> | undefined),
            ANTHROPIC_BASE_URL: origin,
            // A bearer token, so the CLI asks no API-key approval question.
            ANTHROPIC_AUTH_TOKEN: "fixture-only-not-a-key",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
            DISABLE_AUTOUPDATER: "1",
          },
          skipDangerousModePermissionPrompt: true,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    // The first-run screens a terminal CLI would otherwise stop at.
    const state = readJson(statePath);
    const projects = (state.projects as Record<string, Record<string, unknown>> | undefined) ?? {};
    write(
      statePath,
      `${JSON.stringify(
        {
          ...state,
          hasCompletedOnboarding: true,
          bypassPermissionsModeAccepted: true,
          projects: {
            ...projects,
            [worktreePath]: { ...projects[worktreePath], hasTrustDialogAccepted: true },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    try {
      restore();
    } catch (rollbackError) {
      throw new Error(
        `Fixture installation failed; ${rollbackError instanceof Error ? rollbackError.message : "rollback failed"}`,
        { cause: error },
      );
    }
    throw error;
  }
  return restore;
}

async function localEnvironment(gateway: Gateway): Promise<Environment> {
  const projects = await gateway.invoke<Array<{ id: string }>>("get_projects");
  for (const project of projects) {
    const environments = await gateway.invoke<Environment[]>("get_environments", {
      projectId: project.id,
    });
    const local = environments.find(
      (environment) => environment.environmentType === "local" && environment.worktreePath,
    );
    if (local) return local;
  }
  throw new Error("The profile has no local fixture environment (start it with --fixture)");
}

const abortableSleep = async (ms: number, signal?: AbortSignal) => {
  await delay(ms, undefined, { signal });
};
const mailRuntime = {
  profileStatus,
  gatewayFor,
  startFakeAnthropicModel,
  claudeFixture,
  sleep: abortableSleep,
};
export const __testing = { mailRuntime };

export async function runMailBenchmark(
  options: Options,
  signal?: AbortSignal,
  runtime = mailRuntime,
): Promise<number> {
  const status = runtime.profileStatus(options);
  if (status.status !== "ready" || !status.dataDir) throw new Error("Profile is not ready");
  const directory = isolatedClaudeDirectory(status.dataDir, options.profile);
  const gateway = runtime.gatewayFor(status, signal);
  const environment = await localEnvironment(gateway);
  const tabId = `bg15-${randomUUID().slice(0, 8)}`;
  const run = randomUUID().slice(0, 8);
  let fake: FakeAnthropicModel | undefined;
  let restore: (() => void) | undefined;
  let started = false;
  const result: Record<string, unknown> = {
    profile: options.profile,
    commit: spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      ...(options.checkout ? { cwd: options.checkout } : {}),
    }).stdout.trim(),
    platform: process.platform,
    arch: process.arch,
    model: "loopback fake (e2e/agent-testing/fake-anthropic-model.ts); no provider was called",
    at: new Date().toISOString(),
  };
  const sleep = (ms: number) => runtime.sleep(ms, signal);
  const waitFor = <T>(
    label: string,
    timeout: number,
    probe: () => Promise<T | null | undefined | false>,
  ) => pollFor(label, timeout, probe, signal, runtime.sleep);
  try {
    signal?.throwIfAborted();
    fake = await runtime.startFakeAnthropicModel();
    signal?.throwIfAborted();
    restore = runtime.claudeFixture(directory, fake.origin, environment.worktreePath!);
    log(`opening a claude-tmux tab on the local fixture environment`);
    const launchAt = Date.now();
    started = true; // An interrupted launch may already have reached the backend.
    await gateway.invoke("launch_terminal_job", {
      environmentId: environment.id,
      requestId: `bg15-${run}`,
      tabId,
      tabType: "claude-tmux",
      title: "BG-15 live",
    });
    const tab = () =>
      gateway.invoke<TmuxStatus | null>("claude_tmux_status", {
        environmentId: environment.id,
        tabId,
      });
    await waitFor("the tab to run idle", 120_000, async () => {
      const current = await tab();
      return current?.running && current.busy !== true ? current : null;
    });
    result.tabReadyMs = Date.now() - launchAt;
    // Starting the CLI may itself have asked the model something.
    result.modelCallsAtStart = fake.calls().length;
    await gateway.invoke("mute_agent_mail", {
      environmentId: environment.id,
      tabId,
      inject: "idle",
    });

    // A keyed read of a store that has never been written returns before it
    // is counted, and a fresh profile has no prompt-queue or compose-draft
    // store. So first do what any user of the tab does once: queue a prompt
    // (typed into the tab, a turn on the fake model) and save, then clear, a
    // draft. Without this the queue and draft reads cost nothing to count.
    const stateKey = `env:${environment.id}:tab:${tabId}`;
    const queueKey = `claude-tmux\0${stateKey}`;
    const draftKey = `claude-tmux:${environment.id}:${encodeURIComponent(stateKey)}`;
    const saveDraft = async () => {
      await gateway.invoke("save_compose_draft", {
        draftKey,
        ownerType: "environment",
        ownerId: environment.id,
        value: { text: "a draft the user is still writing", mentions: [], attachments: [] },
      });
    };
    log("priming the queue and draft stores");
    // A settle after the first idle report. On 2026-11-06 one pass's prompt,
    // queued the moment the tab first reported idle, never reached the model;
    // the cause was not established.
    await sleep(10_000);
    const primeMarker = `bg15-${run}-prime`;
    await gateway.invoke("enqueue_prompt_queue_message", {
      queueKey,
      environmentId: environment.id,
      message: {
        id: primeMarker,
        text: `Fixture prompt ${primeMarker}. Reply with one word.`,
        attachments: [],
      },
    });
    await waitFor(
      "the queued prompt to reach the model",
      120_000,
      async () => fake!.callsWith(primeMarker).length > 0,
    );
    await waitFor("the tab to go idle after the queued prompt", 120_000, async () => {
      const current = await tab();
      return current?.running && current.busy !== true;
    });
    await saveDraft();
    await gateway.invoke("delete_compose_draft", { draftKey });
    result.primed = {
      queuedPromptModelCalls: fake.callsWith(primeMarker).length,
      draft: "saved-and-deleted",
    };

    log(`idle window, ${options.quietMs} ms`);
    const quietBefore = await gateway.kinds();
    await sleep(options.quietMs);
    const quiet = kindDelta(quietBefore, await gateway.kinds());
    const idle = quiet["mail-injection"];
    if (!idle || idle.started <= 0)
      throw new Error("Idle window contains no measured mail-injection passes");
    const idleReadsPerPass = idle.storageReads / idle.started;
    result.idle = {
      windowMs: options.quietMs,
      kinds: quiet,
      mailInjectionReadsPerPass: idleReadsPerPass,
    };

    const send = async (marker: string) => {
      const sent = await gateway.invoke<{ id?: string; message?: { id?: string } }>(
        "send_agent_mail",
        {
          requestId: `${marker}-request`,
          toEnvironmentId: environment.id,
          toTabId: tabId,
          subject: "BG-15 live probe",
          body: `Fixture mail ${marker}. Reply with one word.`,
        },
      );
      const id = sent.id ?? sent.message?.id;
      if (!id) throw new Error("send_agent_mail returned no message id");
      return id;
    };
    const mailStatus = (id: string) =>
      gateway.invoke<MailStatus>("get_agent_mail_status", { messageId: id });
    const deliver = async (marker: string, id: string, sentAt: number) => {
      await waitFor(`${marker} to be typed`, 60_000, async () => (await mailStatus(id)).injectedAt);
      const typedMs = Date.now() - sentAt;
      await waitFor(
        `${marker} to reach the model`,
        60_000,
        async () => fake!.callsWith(marker).length > 0,
      );
      await waitFor(`the tab to go idle after ${marker}`, 120_000, async () => {
        const current = await tab();
        return current?.running && current.busy !== true;
      });
      // Let the turn's own follow-up drains finish inside this window.
      await sleep(3_000);
      return { typedMs, modelCalls: fake!.callsWith(marker).length };
    };

    const deliveries: unknown[] = [];
    for (let index = 1; index <= options.deliveries; index += 1) {
      const marker = `bg15-${run}-${index}`;
      const before = await gateway.kinds();
      const windowStart = Date.now();
      const id = await send(marker);
      const outcome = await deliver(marker, id, windowStart);
      const delta = kindDelta(before, await gateway.kinds());
      deliveries.push({
        index,
        ...outcome,
        windowMs: Date.now() - windowStart,
        kinds: delta,
        mailInjectionReadsBeyondIdle: deliveryReads(delta["mail-injection"], idleReadsPerPass),
      });
      log(`delivery ${index}: typed in ${outcome.typedMs} ms`);
    }
    result.deliveries = deliveries;

    log("draft hold");
    await saveDraft();
    const heldMarker = `bg15-${run}-held`;
    const heldSentAt = Date.now();
    const heldId = await send(heldMarker);
    await sleep(15_000);
    const held = await mailStatus(heldId);
    const heldResult: Record<string, unknown> = {
      typedWhileDraft: Boolean(held.injectedAt),
      modelCallsWhileDraft: fake.callsWith(heldMarker).length,
      placement: held.placement ?? null,
      placementReason: held.placementReason ?? null,
    };
    await gateway.invoke("delete_compose_draft", { draftKey });
    const released = await deliver(heldMarker, heldId, heldSentAt);
    heldResult.afterDraftDeleted = released;
    result.draftHold = heldResult;
    result.modelCallsTotal = fake.calls().length;
    signal?.throwIfAborted();
    result.ok =
      deliveries.every((entry) => (entry as { modelCalls: number }).modelCalls === 1) &&
      heldResult.typedWhileDraft === false &&
      heldResult.modelCallsWhileDraft === 0 &&
      released.modelCalls === 1;
  } catch (error) {
    result.ok = false;
    const failure = signal?.aborted ? signal.reason : error;
    result.error = failure instanceof Error ? failure.message : String(failure);
    log(String(result.error));
  } finally {
    const cleanupErrors: string[] = [];
    if (started) {
      await gateway
        .invoke("claude_tmux_stop", { environmentId: environment.id, tabId }, true)
        .catch(() => cleanupErrors.push("tab stop failed"));
    }
    try {
      restore?.();
    } catch {
      cleanupErrors.push("fixture restore failed");
    }
    try {
      await fake?.stop();
    } catch {
      cleanupErrors.push("fake model stop failed");
    }
    if (cleanupErrors.length) {
      result.ok = false;
      result.cleanupErrors = cleanupErrors;
    }
  }
  if (signal?.aborted) {
    result.ok = false;
    result.interrupted = true;
    result.error = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
  }
  const out = path.resolve(options.out);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  log(`wrote ${out}`);
  return result.ok === true ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await withTerminationSignals((signal) =>
    runMailBenchmark(parseOptions(process.argv.slice(2)), signal),
  );
}

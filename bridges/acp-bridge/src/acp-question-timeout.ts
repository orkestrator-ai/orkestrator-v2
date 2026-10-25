/**
 * How long Grok itself waits on an `ask_user_question`, and the environment
 * that makes that wait no shorter than a paused card.
 *
 * Grok abandons a question it asked over ACP on its own timer and answers the
 * model "User declined to answer", whatever the bridge's deadline says. The
 * request carries no deadline, so the bridge works it out the way Grok
 * resolves `[toolset.ask_user_question]` (1.0.67 documents the order
 * requirements, environment, user `config.toml`, managed, default and the
 * live checks below agree), and publishes it as the request's provider limit.
 *
 * When nothing sets the duration, Grok would fall back to 30 minutes, which
 * cut every pause short. The bridge then launches the child with
 * `GROK_ASK_USER_QUESTION_TIMEOUT_SECS` at the hold ceiling, so the bridge's
 * own `InteractionDeadline` (five minutes, a day while paused) decides when an
 * unanswered question is cancelled. A duration or an off switch the user set
 * is left alone and published as it is, so a shorter value is reflected on the
 * card.
 *
 * Checked against Grok 1.0.67 with a loopback model and a throwaway
 * `GROK_HOME` (no credentials): the question was abandoned after the
 * environment's 8 s, the user config's 5 s, and the environment's 9 s over a
 * user config of 5 s. A `$GROK_HOME/managed_config.toml` is not read here:
 * Grok syncs that file from the login's team and deleted the hand-written one
 * without applying it, and the environment outranks it anyway.
 */
import { readFileSync } from "node:fs";
import { AGENT_INTERACTION_HOLD_CEILING_MS } from "@orkestrator/protocol/agent-interactions";

/** Grok CLI's own `ask_user_question` wait when nothing overrides it. */
export const GROK_QUESTION_DEFAULT_TIMEOUT_MS = 1_800_000;

export const GROK_QUESTION_TIMEOUT_SECS_ENV = "GROK_ASK_USER_QUESTION_TIMEOUT_SECS";
export const GROK_QUESTION_TIMEOUT_ENABLED_ENV = "GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED";

/** Organisation requirements outrank the environment; the signed cache is not readable here. */
export const GROK_SYSTEM_REQUIREMENTS_FILE = "/etc/grok/requirements.toml";

/** What a launched Grok child waits on a question, and how the bridge set it. */
export interface GrokQuestionTimeout {
  /** Undefined when Grok's question timeout is off. */
  timeoutMs: number | undefined;
  /** Variables to add to the child's environment; empty unless the bridge raised the default. */
  env: Record<string, string>;
  /** Which layer decided the duration (or the off switch). */
  source: "requirements" | "environment" | "user-config" | "raised" | "off";
}

interface QuestionTimeoutLayer {
  enabled?: boolean;
  secs?: number;
}

const POSITIVE_SECONDS = /^[1-9]\d{0,9}$/;

function environmentLayer(env: NodeJS.ProcessEnv): QuestionTimeoutLayer {
  const layer: QuestionTimeoutLayer = {};
  const enabled = env[GROK_QUESTION_TIMEOUT_ENABLED_ENV]?.trim().toLowerCase();
  if (enabled === "false" || enabled === "0") layer.enabled = false;
  else if (enabled === "true" || enabled === "1") layer.enabled = true;
  const seconds = env[GROK_QUESTION_TIMEOUT_SECS_ENV]?.trim() ?? "";
  // Grok requires a positive integer and ignores anything else.
  if (POSITIVE_SECONDS.test(seconds)) layer.secs = Number(seconds);
  return layer;
}

/** `[toolset.ask_user_question]` of one TOML layer; an unreadable or invalid one adds nothing. */
export function questionTimeoutTomlLayer(text: string | undefined): QuestionTimeoutLayer {
  if (!text) return {};
  // The bridge always runs under Bun (the backend and the image start it with
  // `bun`), whose TOML parser the production tsconfig does not type.
  const toml = (globalThis as { Bun?: { TOML?: { parse(text: string): unknown } } }).Bun?.TOML;
  let parsed: unknown;
  try {
    parsed = toml?.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const toolset = (parsed as { toolset?: unknown }).toolset;
  const table =
    toolset && typeof toolset === "object"
      ? (toolset as { ask_user_question?: unknown }).ask_user_question
      : undefined;
  if (!table || typeof table !== "object") return {};
  const { timeout_enabled: enabled, timeout_secs: secs } = table as Record<string, unknown>;
  const layer: QuestionTimeoutLayer = {};
  if (typeof enabled === "boolean") layer.enabled = enabled;
  if (typeof secs === "number" && Number.isInteger(secs) && secs > 0 && secs < 1e10) {
    layer.secs = secs;
  }
  return layer;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

const RAISED_SECONDS = Math.ceil(AGENT_INTERACTION_HOLD_CEILING_MS / 1_000);

/**
 * The question timeout a Grok child launched with `env` keeps, and the
 * variables that raise Grok's default to the hold ceiling when nothing set it.
 */
export function grokQuestionTimeoutAtLaunch(
  env: NodeJS.ProcessEnv,
  files: { userConfig: string; requirements?: string },
  read: (path: string) => string | undefined = readText,
): GrokQuestionTimeout {
  const layers: Array<[GrokQuestionTimeout["source"], QuestionTimeoutLayer]> = [
    [
      "requirements",
      questionTimeoutTomlLayer(read(files.requirements ?? GROK_SYSTEM_REQUIREMENTS_FILE)),
    ],
    ["environment", environmentLayer(env)],
    ["user-config", questionTimeoutTomlLayer(read(files.userConfig))],
  ];
  // Grok resolves each key on its own, highest layer first.
  const enabled = layers.find(([, layer]) => layer.enabled !== undefined);
  if (enabled?.[1].enabled === false) return { timeoutMs: undefined, env: {}, source: "off" };
  const secs = layers.find(([, layer]) => layer.secs !== undefined);
  if (secs) return { timeoutMs: secs[1].secs! * 1_000, env: {}, source: secs[0] };
  return {
    timeoutMs: RAISED_SECONDS * 1_000,
    env: { [GROK_QUESTION_TIMEOUT_SECS_ENV]: String(RAISED_SECONDS) },
    source: "raised",
  };
}

/**
 * Grok's question timeout from the environment alone, for a child the bridge
 * did not launch through `AcpProcess` (tests hand in a stub). Undefined when
 * the environment turns it off; Grok's documented default otherwise.
 */
export function grokQuestionTimeoutFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const layer = environmentLayer(env);
  if (layer.enabled === false) return undefined;
  return layer.secs !== undefined ? layer.secs * 1_000 : GROK_QUESTION_DEFAULT_TIMEOUT_MS;
}

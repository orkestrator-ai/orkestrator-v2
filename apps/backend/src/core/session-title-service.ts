/**
 * Backend-owned session-title generation.
 *
 * Every native platform gets its title from here, keyed by whichever agent
 * login this machine already has: the session's own platform first when it is
 * Codex or Claude, then the other one. The user's `sessionTitleGeneration`
 * setting can keep a first message from reaching a second vendor, or turn
 * generation off. With no strategy left (or all of them failing) the caller
 * keeps the first-message fallback (`firstMessageSessionTitle`). The renderer
 * never generates a title, and no bridge does any more.
 *
 * Each strategy is a one-shot CLI run with nothing of the user's configuration
 * loaded (`session-title-runners.ts`). A strategy that fails is rested for a
 * while so a missing login does not cost a spawn per new session.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";
import {
  DEFAULT_SESSION_TITLE_GENERATION_POLICY,
  resolveSessionTitleGenerationPolicy,
  type SessionTitleGenerationPolicy,
} from "@orkestrator/protocol/session-title-generation";
import { CLAUDE_PINNED_RUNTIME_ENV } from "@orkestrator/protocol/terminal-agent-launch";
import type { CommandContext } from "./commands-context.js";
import { resolveClaudeBinary, resolveCodexBinary } from "./commands-agent-support.js";
import { applyActiveAgentAccountEnvironment } from "./agent-accounts-active.js";
import { applyClaudeHostCredentialEnvironment } from "./host-agent-credentials.js";
import { runCommand } from "./shell.js";
import {
  generateClaudeSessionTitle,
  generateCodexSessionTitle,
  type SessionTitleRunInput,
} from "./session-title-runners.js";

export type SessionTitleStrategy = Extract<AgentAccountPlatform, "codex" | "claude">;

export interface GeneratedSessionTitle {
  title: string;
  strategy: SessionTitleStrategy;
}

/** What the native agent service needs from a title generator. */
export interface SessionTitleGenerator {
  /** A generated title, or null when no strategy could produce one. */
  generate(input: { agent: AgentPlatform; source: string }): Promise<GeneratedSessionTitle | null>;
  /** Stops every run in flight and refuses new ones. */
  shutdown(): Promise<void>;
}

export interface SessionTitleServiceDependencies {
  /** Whether this platform has a login on this machine. A throw reads as no. */
  signedIn(strategy: SessionTitleStrategy): Promise<boolean>;
  /** The executable and environment one strategy runs with. A throw skips it. */
  launch(strategy: SessionTitleStrategy): Promise<{ executable: string; env: NodeJS.ProcessEnv }>;
  /** Which logins may be used, read per generation. Absent is the default; a throw is "off". */
  policy?(): Promise<SessionTitleGenerationPolicy>;
  run?: typeof runCommand;
  generators?: Partial<
    Record<SessionTitleStrategy, (input: SessionTitleRunInput) => Promise<string>>
  >;
  now?: () => number;
  /** How long a failed strategy is skipped. */
  failureCooldownMs?: number;
  /** Generations running at once; more wait their turn. */
  maxConcurrent?: number;
  /** Generations allowed to wait; past this the caller keeps its fallback. */
  maxQueued?: number;
  timeoutMs?: number;
}

const DEFAULT_FAILURE_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 32;

/** Generator order for a session of this platform, as far as the policy allows. */
export function sessionTitleStrategyOrder(
  agent: AgentPlatform,
  policy: SessionTitleGenerationPolicy = DEFAULT_SESSION_TITLE_GENERATION_POLICY,
): SessionTitleStrategy[] {
  if (policy === "off") return [];
  if (policy === "own-platform") {
    return agent === "claude" || agent === "codex" ? [agent] : [];
  }
  return agent === "claude" ? ["claude", "codex"] : ["codex", "claude"];
}

export class SessionTitleService implements SessionTitleGenerator {
  private readonly run: typeof runCommand;
  private readonly generators: Record<
    SessionTitleStrategy,
    (input: SessionTitleRunInput) => Promise<string>
  >;
  private readonly now: () => number;
  private readonly restingUntil = new Map<SessionTitleStrategy, number>();
  private readonly shutdownController = new AbortController();
  private readonly waiting: Array<() => void> = [];
  private readonly active = new Set<Promise<unknown>>();
  private running = 0;

  constructor(private readonly deps: SessionTitleServiceDependencies) {
    this.run = deps.run ?? runCommand;
    this.generators = {
      codex: deps.generators?.codex ?? generateCodexSessionTitle,
      claude: deps.generators?.claude ?? generateClaudeSessionTitle,
    };
    this.now = deps.now ?? Date.now;
  }

  async generate(input: {
    agent: AgentPlatform;
    source: string;
  }): Promise<GeneratedSessionTitle | null> {
    if (this.shutdownController.signal.aborted || !input.source.trim()) return null;
    if (!(await this.acquire())) return null;
    const work = this.generateWithStrategies(input);
    this.active.add(work);
    try {
      return await work;
    } finally {
      this.active.delete(work);
      this.release();
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownController.abort();
    for (const wake of this.waiting.splice(0)) wake();
    await Promise.allSettled(Array.from(this.active));
  }

  private async generateWithStrategies(input: {
    agent: AgentPlatform;
    source: string;
  }): Promise<GeneratedSessionTitle | null> {
    // Unreadable means unknown consent, so nothing leaves this machine.
    const policy: SessionTitleGenerationPolicy = this.deps.policy
      ? await this.deps.policy().catch(() => "off" as const)
      : DEFAULT_SESSION_TITLE_GENERATION_POLICY;
    for (const strategy of sessionTitleStrategyOrder(input.agent, policy)) {
      if (this.shutdownController.signal.aborted) return null;
      if ((this.restingUntil.get(strategy) ?? 0) > this.now()) continue;
      if (!(await this.deps.signedIn(strategy).catch(() => false))) continue;
      try {
        const { executable, env } = await this.deps.launch(strategy);
        const title = await this.generators[strategy]({
          executable,
          env,
          source: input.source,
          signal: this.shutdownController.signal,
          run: this.run,
          ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
        });
        this.restingUntil.delete(strategy);
        return { title, strategy };
      } catch (error) {
        if (this.shutdownController.signal.aborted) return null;
        this.restingUntil.set(
          strategy,
          this.now() + (this.deps.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS),
        );
        // Content-free: the error of a CLI that was handed the prompt on
        // stdin can quote it back.
        console.warn(
          `[ElectronBackend] ${strategy} session-title generation failed; trying the next strategy`,
          error instanceof Error && /timed out/i.test(error.message) ? "(timed out)" : "",
        );
      }
    }
    return null;
  }

  private acquire(): Promise<boolean> {
    if (this.running < (this.deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)) {
      this.running += 1;
      return Promise.resolve(true);
    }
    if (this.waiting.length >= (this.deps.maxQueued ?? DEFAULT_MAX_QUEUED)) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        if (this.shutdownController.signal.aborted) {
          resolve(false);
          return;
        }
        this.running += 1;
        resolve(true);
      });
    });
  }

  private release(): void {
    this.running -= 1;
    this.waiting.shift()?.();
  }
}

/** Credentials a title run must never hold: it reads no repository. */
const TITLE_RUN_STRIPPED_ENV = ["GITHUB_TOKEN", "GH_TOKEN"] as const;

/** The production composition must never spend a login under the test runner. */
export function sessionTitleGenerationEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV !== "test" && env.ORKESTRATOR_SESSION_TITLE_GENERATION !== "0";
}

/**
 * The production service: the managed CLIs, launched on the active account
 * exactly as that platform's bridge would be, minus the GitHub credential.
 */
export function createSessionTitleService(context: CommandContext): SessionTitleService {
  return new SessionTitleService({
    policy: async () =>
      resolveSessionTitleGenerationPolicy(
        (await context.storage.loadConfig()).global.sessionTitleGeneration,
      ),
    signedIn: async (strategy) => {
      const [{ readAgentSignInStatus }, { listAgentAccounts }] = await Promise.all([
        import("./agent-sign-in-status.js"),
        import("./agent-accounts.js"),
      ]);
      const status = await readAgentSignInStatus(strategy, {
        listAccounts: () => listAgentAccounts(context),
        // Only Claude and Codex are asked, and neither reads it.
        cursorStatus: async () => {
          throw new Error("Cursor status is not used for session titles");
        },
      });
      return status.state === "signed-in";
    },
    launch: async (strategy) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of TITLE_RUN_STRIPPED_ENV) delete env[key];
      if (strategy === "codex") {
        const executable = resolveCodexBinary(context);
        await applyActiveAgentAccountEnvironment(context, "codex", env);
        return { executable, env };
      }
      const executable = resolveClaudeBinary(context);
      if (executable !== "claude") Object.assign(env, CLAUDE_PINNED_RUNTIME_ENV);
      await applyClaudeHostCredentialEnvironment(context, env);
      await applyActiveAgentAccountEnvironment(context, "claude", env);
      return { executable, env };
    },
  });
}

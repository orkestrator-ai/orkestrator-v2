import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { registerTmuxBackendCommands } from "./tmux.js";
import {
  nativeAgentSessionResumeIdentity,
  type Environment,
  type NativeAgentProvider,
  type PersistedNativeAgentSession,
} from "./models.js";
import {
  assertOnlyKeys,
  asNonBlankString,
  stableTerminalKey,
  peekLocalAgentBridge,
  peekContainerAgentBridge,
  conciseError,
} from "./commands-helpers.js";
import type { LocalServerKind } from "./commands-helpers.js";
import type { CommandContext } from "./commands-context.js";
import { closeBridgeSessionRetaining } from "./bridge-session-close.js";
import {
  fenceRetainingCloseSessionId,
  isNativeTabTeardownKind,
  unfenceTabTeardownSessionId,
  isTabTeardownKind,
} from "@orkestrator/protocol/tab-teardown";
import {
  isReplacedSessionCloseKey,
  providerSessionHeldElsewhere,
  withProviderSessionTeardownLock,
} from "./provider-session-ownership.js";

export function registerTeardownCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { commands, options, prepareEnvironmentFirstPrompt } = dependencies;
  registerTmuxBackendCommands(register, { prepareEnvironmentFirstPrompt });

  type TabTeardownIntent = NonNullable<Environment["tabTeardownIntents"]>[string];
  const tabTeardownFetch = options.tabTeardown?.fetch ?? fetch;
  const tabTeardownDeleteTimeoutMs = Math.max(1, options.tabTeardown?.deleteTimeoutMs ?? 5_000);
  const tabTeardownCloseTimeoutMs = Math.max(1, options.tabTeardown?.closeTimeoutMs ?? 20_000);
  const tabTeardownReconciliationConcurrency = 4;
  /**
   * Pending intents are retried by the backend's periodic (60 s, coalesced)
   * reconcile sweep as well as at startup. An intent that keeps failing — a
   * bridge that is down or predates the close route — backs off per intent
   * (30 s, 60 s, 120 s, … capped at 15 min) so the sweep neither hammers the
   * bridge nor floods the log. The backoff is in memory: a restarted backend
   * retries every intent once at startup.
   */
  const TAB_TEARDOWN_RETRY_BASE_DELAY_MS = 30_000;
  const TAB_TEARDOWN_RETRY_MAX_DELAY_MS = 15 * 60_000;
  const tabTeardownNow = options.tabTeardown?.now ?? Date.now;
  const tabTeardownRetryBackoff = new Map<string, { failures: number; retryAt: number }>();
  const tabTeardownRetryKey = (environmentId: string, intent: TabTeardownIntent): string =>
    `${environmentId}\0${intent.tabId}\0${intent.createdAt}`;
  /** OpenCode close is abort + settlement + pending-request reads/rejections. */
  const OPENCODE_CLOSE_REQUEST_BUDGET = 4;
  const peekTabTeardownBridge =
    options.tabTeardown?.peekBridge ??
    (async (
      environment: Environment,
      agent: LocalServerKind,
      context: CommandContext,
    ): Promise<{ port: number; authToken: string } | null> => {
      const bridge =
        environment.environmentType === "local"
          ? await peekLocalAgentBridge(environment.id, context, agent)
          : environment.containerId
            ? await peekContainerAgentBridge(environment.containerId, agent)
            : null;
      if (!bridge) return null;
      return {
        port: "port" in bridge ? bridge.port : bridge.hostPort,
        authToken: bridge.authToken,
      };
    });

  /**
   * One bounded, non-destructive bridge close request.
   */
  const requestProviderTabSession = async (
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response> => {
    const controller = new AbortController();
    let rejectTimeout!: (error: Error) => void;
    const timeoutResult = new Promise<Response>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      rejectTimeout(
        new Error(`Tab teardown request timed out after ${tabTeardownCloseTimeoutMs}ms`),
      );
      controller.abort();
    }, tabTeardownCloseTimeoutMs);
    timeout.unref?.();
    try {
      return await Promise.race([
        tabTeardownFetch(url, {
          method: "POST",
          headers,
          signal: controller.signal,
        }),
        timeoutResult,
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };

  /**
   * OpenCode tab close goes through the provider (via the native agent
   * service), not a raw HTTP abort: the provider's close settles workflow-turn
   * ownership, restores temporary reviewer permissions, rejects pending
   * permissions and questions, treats 404 as already gone, and forgets the
   * session. It never calls OpenCode's `DELETE /session/:id`, which deletes the
   * conversation. Bounded like every other teardown request.
   */
  const closeOpenCodeTabSession = async (
    environmentId: string,
    providerSessionId: string,
    context: CommandContext,
  ): Promise<void> => {
    const service = context.nativeAgents;
    if (!service?.closeProviderSessionIfRunning) {
      throw new Error("OpenCode tab close is unavailable");
    }
    const budgetMs = tabTeardownDeleteTimeoutMs * OPENCODE_CLOSE_REQUEST_BUDGET;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      service.closeProviderSessionIfRunning(environmentId, "opencode", providerSessionId),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`OpenCode tab close timed out after ${budgetMs}ms`)),
          budgetMs,
        );
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    if (outcome === "not-running") {
      throw new Error("Tab teardown bridge is unavailable or unhealthy");
    }
    if (outcome !== "closed") throw new Error("OpenCode tab close is unavailable");
  };

  /** The non-destructive provider close every native teardown ends in. */
  const closeProviderSession = async (
    environment: Environment,
    agent: LocalServerKind,
    providerSessionId: string,
    context: CommandContext,
  ): Promise<void> => {
    if (agent === "opencode") {
      await closeOpenCodeTabSession(environment.id, providerSessionId, context);
      return;
    }
    const bridge = await peekTabTeardownBridge(environment, agent, context);
    if (!bridge) {
      throw new Error("Tab teardown bridge is unavailable or unhealthy");
    }
    await closeBridgeSessionRetaining(agent, providerSessionId, (_method, path) =>
      requestProviderTabSession(new URL(`http://127.0.0.1:${bridge.port}${path}`), {
        Authorization: `Bearer ${bridge.authToken}`,
      }),
    );
  };

  const executeTabTeardown = async (
    environment: Environment,
    intent: TabTeardownIntent,
    context: CommandContext,
  ): Promise<void> => {
    const releaseOwner = context.userCommands?.beginOwnerClose?.(environment.id, intent.tabId);
    try {
      await context.userCommands?.terminateForTab(environment.id, intent.tabId);
      context.humanPrompts?.clearTab(environment.id, intent.tabId);
      await performTabTeardown(environment, intent, context);
      context.humanPrompts?.clearTab(environment.id, intent.tabId);
    } finally {
      releaseOwner?.();
    }
  };

  const performTabTeardown = async (
    environment: Environment,
    intent: TabTeardownIntent,
    context: CommandContext,
  ): Promise<void> => {
    if (intent.kind === "terminal") {
      const sessionIds = new Set<string>();
      if (intent.sessionId) {
        const expectedStableKeys = new Set(
          ["container", "local"].map((kind) =>
            stableTerminalKey(kind as "container" | "local", environment.id, intent.tabId),
          ),
        );
        const actualStableKey = context.runtime.terminals.stableKeyForSession(intent.sessionId);
        if (actualStableKey && !expectedStableKeys.has(actualStableKey)) {
          throw new Error("Terminal session is not owned by the requested environment and tab");
        }
        // An unknown process id is already gone. Only an exact stable-key match
        // is authority to kill a live terminal; renderer-supplied ids are not.
        if (actualStableKey) sessionIds.add(intent.sessionId);
      }
      for (const kind of ["container", "local"] as const) {
        const stableId = context.runtime.terminals.sessionIdForStableKey(
          stableTerminalKey(kind, environment.id, intent.tabId) ?? "",
        );
        if (stableId) sessionIds.add(stableId);
      }
      if (intent.persistentSessionId) {
        const session = await context.storage.getSession(intent.persistentSessionId);
        if (session) {
          if (session.environmentId !== environment.id || session.tabId !== intent.tabId) {
            throw new Error(
              "Persistent terminal session is not owned by the requested environment and tab",
            );
          }
        }
      }
      for (const sessionId of sessionIds)
        context.runtime.terminals.explicitlyCloseSession(sessionId);
      await context.runtime.terminals.history.deleteHistories({
        dataDir: context.storage.getDataDir(),
        environmentId: environment.id,
        tabId: intent.tabId,
      });
      if (intent.persistentSessionId) {
        const session = await context.storage.getSession(intent.persistentSessionId);
        if (session) {
          await context.storage.updateSession(intent.persistentSessionId, {
            status: "disconnected",
          });
        }
      }
      return;
    }
    if (intent.kind === "claude-tmux") {
      const stopTmux = commands.get("claude_tmux_stop");
      if (stopTmux) {
        await stopTmux({ environmentId: environment.id, tabId: intent.tabId }, context);
      }
      return;
    }
    const agent =
      intent.kind === "claude-native"
        ? "claude"
        : intent.kind === "codex-native"
          ? "codex"
          : intent.kind === "opencode-native"
            ? "opencode"
            : intent.kind === "cursor-native"
              ? "cursor"
              : intent.kind === "grok-native"
                ? "grok"
                : intent.kind === "pi-native"
                  ? "pi"
                  : null;
    if (!agent) return;
    // Intents written by this release carry the downgrade fence; older ones do
    // not. Both are replayed with the same non-destructive close.
    const { sessionId: requestedSessionId } = unfenceTabTeardownSessionId(intent.sessionId);
    if (isReplacedSessionCloseKey(intent.tabId)) {
      // A session a resume replaced (`replacedSessionCloseIntent`). The backend
      // wrote its id, and no tab maps it any more, so there is no mapping to
      // check it against or retire: only the last-owner rules apply.
      if (!requestedSessionId) return;
      await withProviderSessionTeardownLock(
        context.storage,
        environment.id,
        agent,
        requestedSessionId,
        async () => {
          // A tab that resumed it again, or a Multi Review, owns it now and
          // closes it itself.
          const heldElsewhere = await providerSessionHeldElsewhere(context.storage, {
            environmentId: environment.id,
            agent,
            providerSessionId: requestedSessionId,
          });
          if (heldElsewhere) return;
          await closeProviderSession(environment, agent, requestedSessionId, context);
          context.nativeAgents?.releaseProviderSession?.(environment.id, agent, requestedSessionId);
        },
      );
      return;
    }
    const logicalSessionKey = `env-${environment.id}:${intent.tabId}`;
    const storageKey = nativeAgentSessionStorageKey(environment.id, agent, logicalSessionKey);
    const persistedSession = await context.storage.getNativeAgentSession(storageKey);
    if (
      persistedSession &&
      (persistedSession.environmentId !== environment.id ||
        persistedSession.agent !== agent ||
        persistedSession.logicalSessionKey !== logicalSessionKey)
    ) {
      throw new Error("Native session mapping is not owned by the requested environment and tab");
    }
    if (
      persistedSession &&
      requestedSessionId &&
      requestedSessionId !== persistedSession.providerSessionId
    ) {
      throw new Error("Native session id does not match the requested environment and tab");
    }
    if (!persistedSession && requestedSessionId) {
      const claimedElsewhere = (await context.storage.listNativeAgentSessions()).find(
        (session) => session.providerSessionId === requestedSessionId,
      );
      if (claimedElsewhere) {
        throw new Error("Native session is owned by a different environment or tab");
      }
    }
    // A provider id supplied by a renderer is not close authority on its own.
    // Legacy/unmapped sessions are left to orphan reconciliation rather than
    // risking closing another tab's conversation.
    const providerSessionId = persistedSession?.providerSessionId;
    let resumable = intent.resumableSessionId;
    if (!providerSessionId) {
      if (resumable)
        await recordDesignLinkSession(context, environment.id, intent.tabId, agent, resumable);
      return;
    }
    await withProviderSessionTeardownLock(
      context.storage,
      environment.id,
      agent,
      providerSessionId,
      async () => {
        // Re-read under the lock: a concurrent teardown of this tab may already
        // have retired the mapping, or rebound it to another provider session.
        const current = await context.storage.getNativeAgentSessionAfterMutations(storageKey);
        if (current?.providerSessionId !== providerSessionId) return;
        // A session another tab shares, or a Multi Review owns, only loses this
        // tab's mapping. Of two tabs closed together, the second one under the
        // lock sees no other owner and performs the real close.
        const heldElsewhere = await providerSessionHeldElsewhere(context.storage, {
          environmentId: environment.id,
          agent,
          providerSessionId,
          exceptLogicalSessionKey: logicalSessionKey,
        });
        // Read before the close: Codex resumes its thread, which only the open
        // session can name.
        const latestIntent = (await context.storage.getEnvironment(environment.id))
          ?.tabTeardownIntents?.[intent.tabId];
        resumable =
          latestIntent?.createdAt === intent.createdAt
            ? latestIntent.resumableSessionId
            : resumable;
        resumable ??= await resumableSessionId(context, environment.id, agent, current);
        if (resumable) {
          // Persist before close: the provider may remove the session and lose
          // its response. Reconciliation must not need that live session again.
          await context.storage.recordTabTeardownSessionId(
            environment.id,
            intent.tabId,
            intent.createdAt,
            resumable,
          );
        }
        if (!heldElsewhere) {
          await closeProviderSession(environment, agent, providerSessionId, context);
          context.nativeAgents?.releaseProviderSession?.(environment.id, agent, providerSessionId);
        }
        // The provider-side close is confirmed (or another owner keeps it), so the
        // durable logical-tab mapping is retired as part of the same idempotent
        // intent. The vendor conversation itself is never deleted here.
        await context.storage.invalidateNativeAgentSession(storageKey, providerSessionId);
      },
    );
    // Canvas writes stay outside the provider teardown lock.
    if (resumable)
      await recordDesignLinkSession(context, environment.id, intent.tabId, agent, resumable);
  };

  const finishTabTeardown = async (
    environmentId: string,
    intent: TabTeardownIntent,
    context: CommandContext,
  ): Promise<void> => {
    // A replaced-session intent names no tab, so it has no credential to revoke.
    if (!isReplacedSessionCloseKey(intent.tabId)) {
      context.agentTools?.revokeTab?.(environmentId, intent.tabId);
    }
    await context.storage.clearTabTeardownIntent(environmentId, intent.tabId, intent.createdAt);
  };

  register("teardown_tab", async (args, context) => {
    assertOnlyKeys(
      args,
      ["environmentId", "tabId", "kind", "sessionId", "persistentSessionId"],
      "arguments",
    );
    const environmentId = asNonBlankString(args.environmentId, "environmentId");
    const tabId = asNonBlankString(args.tabId, "tabId");
    // Those keys carry a backend-written session id that replay trusts; a
    // caller-supplied one is not close authority.
    if (isReplacedSessionCloseKey(tabId)) throw new Error("tabId is reserved");
    const environment = await context.storage.getEnvironment(environmentId);
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    if (!isTabTeardownKind(args.kind)) throw new Error("kind is not a supported tab teardown kind");
    const requestedSessionId =
      args.sessionId === undefined ? undefined : asNonBlankString(args.sessionId, "sessionId");
    const intent: TabTeardownIntent = {
      tabId,
      kind: args.kind,
      // Native intents are fenced so an older backend reading this record after
      // a downgrade can never replay it as a destructive DELETE.
      ...(isNativeTabTeardownKind(args.kind)
        ? { sessionId: fenceRetainingCloseSessionId(requestedSessionId) }
        : requestedSessionId === undefined
          ? {}
          : { sessionId: requestedSessionId }),
      ...(args.persistentSessionId === undefined
        ? {}
        : {
            persistentSessionId: asNonBlankString(args.persistentSessionId, "persistentSessionId"),
          }),
      createdAt: new Date().toISOString(),
    };
    await context.storage.setTabTeardownIntent(environmentId, intent);
    await executeTabTeardown(environment, intent, context);
    await finishTabTeardown(environmentId, intent, context);
    return { completed: true };
  });

  register("reconcile_tab_teardowns", async (_args, context) => {
    const environments = await context.storage.loadEnvironments();
    const pending = environments.flatMap((environment) =>
      Object.values(environment.tabTeardownIntents ?? {}).map((intent) => ({
        environment,
        intent,
      })),
    );
    const now = tabTeardownNow();
    const liveKeys = new Set(
      pending.map(({ environment, intent }) => tabTeardownRetryKey(environment.id, intent)),
    );
    for (const key of tabTeardownRetryBackoff.keys()) {
      if (!liveKeys.has(key)) tabTeardownRetryBackoff.delete(key);
    }
    const due = pending.filter(
      ({ environment, intent }) =>
        (tabTeardownRetryBackoff.get(tabTeardownRetryKey(environment.id, intent))?.retryAt ?? 0) <=
        now,
    );
    let nextPendingIndex = 0;
    let completed = 0;
    const reconcileNext = async (): Promise<void> => {
      while (nextPendingIndex < due.length) {
        const entry = due[nextPendingIndex];
        nextPendingIndex += 1;
        if (!entry) return;
        const { environment, intent } = entry;
        const retryKey = tabTeardownRetryKey(environment.id, intent);
        try {
          await executeTabTeardown(environment, intent, context);
          await finishTabTeardown(environment.id, intent, context);
          tabTeardownRetryBackoff.delete(retryKey);
          completed += 1;
        } catch (error) {
          const failures = (tabTeardownRetryBackoff.get(retryKey)?.failures ?? 0) + 1;
          tabTeardownRetryBackoff.set(retryKey, {
            failures,
            retryAt:
              tabTeardownNow() +
              Math.min(
                TAB_TEARDOWN_RETRY_MAX_DELAY_MS,
                TAB_TEARDOWN_RETRY_BASE_DELAY_MS * 2 ** (failures - 1),
              ),
          });
          console.warn(
            `[backend] Tab teardown remains pending for ${environment.id}/${intent.tabId}:`,
            conciseError(error),
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(tabTeardownReconciliationConcurrency, due.length) }, () =>
        reconcileNext(),
      ),
    );
    return { completed };
  });

  register("reconcile_orphaned_tab_resources", async (_args, context) => {
    const graceMs = 60 * 60 * 1_000;
    const now = Date.now();
    const environments = await context.storage.loadEnvironments();
    const paneLayouts = await context.storage.loadPaneLayoutsForReconciliation();
    if (!paneLayouts.available) {
      console.warn(
        "[backend] Skipping orphaned tab reconciliation because pane layouts are unreadable",
      );
      return {
        terminals: 0,
        nativeSessions: 0,
        tmuxSessions: 0,
        skipped: true,
      };
    }
    const referencedTerminalTabs = new Map<string, Set<string>>();
    const referencedNativeTabs = new Map<string, Set<string>>();
    const terminalTabTypes = new Set([
      "plain",
      "root",
      "claude",
      "opencode",
      "codex",
      "cursor",
      "grok",
      "pi",
    ]);
    const collectTabs = (node: unknown, terminals: Set<string>, native: Set<string>): void => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const record = node as Record<string, unknown>;
      if (record.kind === "leaf" && Array.isArray(record.tabs)) {
        for (const tab of record.tabs) {
          if (!tab || typeof tab !== "object" || Array.isArray(tab)) continue;
          const tabRecord = tab as Record<string, unknown>;
          const id = tabRecord.id;
          if (typeof id !== "string" || id.length === 0) continue;
          if (tabRecord.type === "agent-native") native.add(id);
          else if (typeof tabRecord.type === "string" && terminalTabTypes.has(tabRecord.type)) {
            terminals.add(id);
          }
        }
        return;
      }
      if (record.kind === "split" && Array.isArray(record.children)) {
        for (const child of record.children) collectTabs(child, terminals, native);
      }
    };
    for (const environment of environments) {
      const terminals = new Set<string>();
      const native = new Set<string>();
      const layout = paneLayouts.layouts[environment.id];
      if (layout) collectTabs(layout.root, terminals, native);
      referencedTerminalTabs.set(environment.id, terminals);
      referencedNativeTabs.set(environment.id, native);
    }

    const terminals = context.runtime.terminals.reapOrphanedSessions(
      (environmentId, tabId) => referencedTerminalTabs.get(environmentId)?.has(tabId) === true,
      now,
      graceMs,
    );

    const teardownTab = commands.get("teardown_tab");
    let nativeSessions = 0;
    if (teardownTab) {
      // Startup launch snapshots are backend-owned session identities. If their
      // pane is removed or never survives persistence, expire them with the
      // same grace period as any other orphaned native tab and retire both the
      // provider session and the durable projection.
      for (const environment of environments) {
        const startup = environment.startupAgentSession;
        if (
          startup?.status !== "running" ||
          !startup.providerSessionId ||
          referencedNativeTabs.get(environment.id)?.has(startup.tabId)
        )
          continue;
        const startedAt = Date.parse(startup.startedAt ?? "");
        if (!Number.isFinite(startedAt) || now - startedAt < graceMs) continue;
        const kind =
          startup.agent === "claude"
            ? "claude-native"
            : startup.agent === "codex"
              ? "codex-native"
              : startup.agent === "cursor"
                ? "cursor-native"
                : startup.agent === "grok"
                  ? "grok-native"
                  : startup.agent === "pi"
                    ? "pi-native"
                    : "opencode-native";
        await teardownTab(
          {
            environmentId: environment.id,
            tabId: startup.tabId,
            kind,
            sessionId: startup.providerSessionId,
          },
          context,
        );
        await context.storage.updateEnvironment(environment.id, {
          startupAgentSession: undefined,
        });
        nativeSessions += 1;
      }
      for (const session of await context.storage.listNativeAgentSessions()) {
        if (session.origin !== "interactive-native") continue;
        const prefix = `env-${session.environmentId}:`;
        if (!session.logicalSessionKey.startsWith(prefix)) continue;
        const tabId = session.logicalSessionKey.slice(prefix.length);
        if (!tabId || referencedNativeTabs.get(session.environmentId)?.has(tabId)) continue;
        const environment = environments.find(
          (candidate) => candidate.id === session.environmentId,
        );
        if (!environment || environment.tabTeardownIntents?.[tabId]) continue;
        const updatedAt = Date.parse(session.updatedAt);
        if (!Number.isFinite(updatedAt) || now - updatedAt < graceMs) continue;
        const kind =
          session.agent === "claude"
            ? "claude-native"
            : session.agent === "codex"
              ? "codex-native"
              : session.agent === "cursor"
                ? "cursor-native"
                : session.agent === "grok"
                  ? "grok-native"
                  : session.agent === "pi"
                    ? "pi-native"
                    : "opencode-native";
        console.warn(`[backend] Reaping orphaned native session ${session.environmentId}/${tabId}`);
        await teardownTab(
          {
            environmentId: session.environmentId,
            tabId,
            kind,
            sessionId: session.providerSessionId,
          },
          context,
        );
        nativeSessions += 1;
      }
    }
    const reconcileTmux = commands.get("claude_tmux_reconcile_orphans");
    const tmux = reconcileTmux
      ? ((await reconcileTmux({}, context)) as { reaped?: number })
      : undefined;
    return { terminals, nativeSessions, tmuxSessions: tmux?.reaped ?? 0 };
  });
}

/**
 * The identity a later resume of a closing tab's conversation names: the
 * provider's own (Codex's thread id) read from the still-open session, else
 * the one the provider last reported while the session was open (kept on the
 * mapping, for a close that lands after the bridge lost the session), else the
 * session id for providers that resume by it. `undefined` rather than a guess
 * when a Codex thread cannot be named.
 */
async function resumableSessionId(
  context: CommandContext,
  environmentId: string,
  agent: NativeAgentProvider,
  session: PersistedNativeAgentSession,
): Promise<string | undefined> {
  if (!context.design) return undefined;
  const read = await context.nativeAgents
    ?.resumableSessionIdIfRunning?.(environmentId, agent, session.providerSessionId)
    .catch(() => undefined);
  return (
    read ??
    nativeAgentSessionResumeIdentity(session) ??
    (agent === "codex" ? undefined : session.providerSessionId)
  );
}

/**
 * A design link names the closing tab. Once the tab's native-session mapping
 * is retired the tab id no longer leads to the conversation, so the link
 * keeps the identity a resume needs instead. Never fails the close.
 */
async function recordDesignLinkSession(
  context: CommandContext,
  environmentId: string,
  tabId: string,
  agent: NativeAgentProvider,
  sessionId: string,
): Promise<void> {
  await context.design
    ?.recordTabSession({ environmentId, tabId, platform: agent, providerSessionId: sessionId })
    .catch(() => undefined);
}

import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  isTabTeardownKind,
  nativeAgentSessionStorageKey,
  registerTmuxBackendCommands,
} from "./commands-dependencies.js";
import type { Environment } from "./commands-dependencies.js";
import {
  terminalSessionIdsByStableKey,
  terminalStableKeysBySessionId,
  orphanedTerminalMissingSince,
  assertOnlyKeys,
  asNonBlankString,
  stableTerminalKey,
  explicitlyCloseTerminalSession,
  openCodeHealthHeaders,
  peekLocalAgentBridge,
  peekContainerAgentBridge,
  conciseError,
} from "./commands-helpers.js";
import type { LocalServerKind } from "./commands-helpers.js";
import type { CommandContext } from "./commands-context.js";

export function registerTeardownCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { commands, options, prepareEnvironmentFirstPrompt } = dependencies;
  registerTmuxBackendCommands(register, {
    claudeStatePolls: options.claudeStatePolls,
    prepareEnvironmentFirstPrompt,
  });

  type TabTeardownIntent = NonNullable<Environment["tabTeardownIntents"]>[string];
  const tabTeardownFetch = options.tabTeardown?.fetch ?? fetch;
  const tabTeardownDeleteTimeoutMs = Math.max(1, options.tabTeardown?.deleteTimeoutMs ?? 5_000);
  const tabTeardownReconciliationConcurrency = 4;
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

  const deleteProviderTabSession = async (
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
        new Error(`Tab teardown request timed out after ${tabTeardownDeleteTimeoutMs}ms`),
      );
      controller.abort();
    }, tabTeardownDeleteTimeoutMs);
    timeout.unref?.();
    try {
      return await Promise.race([
        tabTeardownFetch(url, {
          method: "DELETE",
          headers,
          signal: controller.signal,
        }),
        timeoutResult,
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };

  const executeTabTeardown = async (
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
        const actualStableKey = terminalStableKeysBySessionId.get(intent.sessionId);
        if (actualStableKey && !expectedStableKeys.has(actualStableKey)) {
          throw new Error("Terminal session is not owned by the requested environment and tab");
        }
        // An unknown process id is already gone. Only an exact stable-key match
        // is authority to kill a live terminal; renderer-supplied ids are not.
        if (actualStableKey) sessionIds.add(intent.sessionId);
      }
      for (const kind of ["container", "local"] as const) {
        const stableId = terminalSessionIdsByStableKey.get(
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
      for (const sessionId of sessionIds) explicitlyCloseTerminalSession(sessionId);
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
      intent.sessionId &&
      intent.sessionId !== persistedSession.providerSessionId
    ) {
      throw new Error("Native session id does not match the requested environment and tab");
    }
    if (!persistedSession && intent.sessionId) {
      const claimedElsewhere = (await context.storage.listNativeAgentSessions()).find(
        (session) => session.providerSessionId === intent.sessionId,
      );
      if (claimedElsewhere) {
        throw new Error("Native session is owned by a different environment or tab");
      }
    }
    // A provider id supplied by a renderer is not deletion authority on its
    // own. Legacy/unmapped sessions are left to orphan reconciliation rather
    // than risking deletion of another tab's transcript.
    const providerSessionId = persistedSession?.providerSessionId;
    if (!providerSessionId) return;
    const bridge = await peekTabTeardownBridge(environment, agent, context);
    if (!bridge) {
      throw new Error("Tab teardown bridge is unavailable or unhealthy");
    }
    const url = new URL(
      `http://127.0.0.1:${bridge.port}/session/${encodeURIComponent(providerSessionId)}`,
    );
    if (agent === "opencode") {
      url.searchParams.set(
        "directory",
        environment.environmentType === "local" ? (environment.worktreePath ?? "") : "/workspace",
      );
    }
    const response = await deleteProviderTabSession(
      url,
      agent === "opencode"
        ? openCodeHealthHeaders(bridge.authToken)
        : { Authorization: `Bearer ${bridge.authToken}` },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Tab teardown failed with HTTP ${response.status}`);
    }
    // The provider transcript may already be gone, but the durable logical-tab
    // mapping must be retired as part of the same idempotent intent.
    await context.storage.invalidateNativeAgentSession(storageKey, providerSessionId);
  };

  const finishTabTeardown = async (
    environmentId: string,
    intent: TabTeardownIntent,
    context: CommandContext,
  ): Promise<void> => {
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
    const environment = await context.storage.getEnvironment(environmentId);
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    if (!isTabTeardownKind(args.kind)) throw new Error("kind is not a supported tab teardown kind");
    const intent: TabTeardownIntent = {
      tabId,
      kind: args.kind,
      ...(args.sessionId === undefined
        ? {}
        : { sessionId: asNonBlankString(args.sessionId, "sessionId") }),
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
    let nextPendingIndex = 0;
    let completed = 0;
    const reconcileNext = async (): Promise<void> => {
      while (nextPendingIndex < pending.length) {
        const entry = pending[nextPendingIndex];
        nextPendingIndex += 1;
        if (!entry) return;
        const { environment, intent } = entry;
        try {
          await executeTabTeardown(environment, intent, context);
          await finishTabTeardown(environment.id, intent, context);
          completed += 1;
        } catch (error) {
          console.warn(
            `[backend] Tab teardown remains pending for ${environment.id}/${intent.tabId}:`,
            conciseError(error),
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(tabTeardownReconciliationConcurrency, pending.length) }, () =>
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
      return { terminals: 0, nativeSessions: 0, tmuxSessions: 0, skipped: true };
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

    let terminals = 0;
    for (const [sessionId, stableKey] of terminalStableKeysBySessionId) {
      const [, environmentId, tabId] = stableKey.split("\0");
      if (!environmentId || !tabId) continue;
      if (referencedTerminalTabs.get(environmentId)?.has(tabId)) {
        orphanedTerminalMissingSince.delete(sessionId);
        continue;
      }
      const missingSince = orphanedTerminalMissingSince.get(sessionId);
      if (missingSince === undefined) {
        orphanedTerminalMissingSince.set(sessionId, now);
        continue;
      }
      if (now - missingSince < graceMs) continue;
      console.warn(`[backend] Reaping orphaned terminal ${environmentId}/${tabId}`);
      explicitlyCloseTerminalSession(sessionId);
      orphanedTerminalMissingSince.delete(sessionId);
      terminals += 1;
    }

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

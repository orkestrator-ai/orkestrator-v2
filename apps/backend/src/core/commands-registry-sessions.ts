import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { paneLayoutUnsupportedVersionMessage, PANE_LAYOUT_VERSION, runCommand } from "./commands-dependencies.js";
import type { SessionStatus, SessionType } from "./commands-dependencies.js";
import { asString, asRecord, assertOnlyKeys, asBoolean, asNumber, asStringArray, asNonBlankString, resolveBrowserOpenCommand, resolveFileManagerRevealCommands } from "./commands-helpers.js";

export function registerSessionCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { conditionalManifestSnapshot, commands } = dependencies;
  register("open_in_browser", ({ url }) => {
    const { command, args } = resolveBrowserOpenCommand(asString(url, "url"));
    return runCommand(command, args).then(() => undefined);
  });
  register("reveal_in_file_manager", async ({ path: filePath }) => {
    const target = asString(filePath, "path");
    const commands = resolveFileManagerRevealCommands(target);
    try {
      await runCommand(commands[0]!.command, commands[0]!.args, { timeoutMs: 5_000 });
    } catch (error) {
      const fallback = commands[1];
      if (!fallback) throw error;
      await runCommand(fallback.command, fallback.args);
    }
  });
  register("open_in_editor", ({ containerId, editor }) => runCommand(asString(editor, "editor") === "cursor" ? "cursor" : "code", ["--folder-uri", `vscode-remote://attached-container+${Buffer.from(asString(containerId, "containerId")).toString("hex")}/workspace`]).then(() => undefined));
  register("open_local_in_editor", ({ path: filePath, editor }) => runCommand(asString(editor, "editor") === "cursor" ? "cursor" : "code", [asString(filePath, "path")]).then(() => undefined));

  register("test_domain_resolution", ({ domains }) => Promise.all(asStringArray(domains).map(async (domain) => {
    try {
      const dns = await import("node:dns/promises");
      const ips = (await dns.lookup(domain, { all: true })).map(({ address }) => address);
      return { domain, valid: true, resolvable: true, ips, error: null };
    } catch (error) {
      return { domain, valid: true, resolvable: false, ips: [], error: error instanceof Error ? error.message : String(error) };
    }
  })));
  register("validate_domains", ({ domains }, context) => commands.get("test_domain_resolution")?.({ domains }, context));

  register("create_session", ({ environmentId, containerId, tabId, sessionType }, { storage }) =>
    storage.createSession(asString(environmentId, "environmentId"), asString(containerId, "containerId"), asString(tabId, "tabId"), asString(sessionType, "sessionType") as SessionType),
  );
  register("get_session", ({ sessionId }, { storage }) => storage.getSession(asString(sessionId, "sessionId")));
  register("get_sessions_by_environment", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "session", () =>
      storage.getSessionsByEnvironment(asString(args.environmentId, "environmentId"))
    )
  );
  register("update_session_status", ({ sessionId, status }, { storage }) => storage.updateSession(asString(sessionId, "sessionId"), { status: asString(status, "status") as SessionStatus }));
  register("update_session_activity", ({ sessionId }, { storage }) => storage.updateSession(asString(sessionId, "sessionId"), { lastActivityAt: new Date().toISOString() }));
  register("delete_session", ({ sessionId }, { storage }) => storage.removeSession(asString(sessionId, "sessionId")));
  register("delete_sessions_by_environment", ({ environmentId }, { storage }) => storage.removeSessionsByEnvironment(asString(environmentId, "environmentId")));
  register("rename_session", ({ sessionId, name }, { storage }) => storage.updateSession(asString(sessionId, "sessionId"), { name: typeof name === "string" ? name : undefined }));
  register("disconnect_environment_sessions", ({ environmentId }, { storage }) => storage.disconnectEnvironmentSessions(asString(environmentId, "environmentId")));
  register("save_session_buffer", ({ sessionId, buffer }, { storage }) => storage.saveSessionBuffer(asString(sessionId, "sessionId"), asString(buffer, "buffer")));
  register("load_session_buffer", ({ sessionId }, { storage }) => storage.loadSessionBuffer(asString(sessionId, "sessionId")));
  register("sync_sessions_with_container", async ({ environmentId, containerRunning }, { storage }) => {
    const sessions = await storage.getSessionsByEnvironment(asString(environmentId, "environmentId"));
    if (!asBoolean(containerRunning)) {
      return storage.disconnectEnvironmentSessions(asString(environmentId, "environmentId"));
    }
    return sessions;
  });
  register("reorder_sessions", ({ environmentId, sessionIds }, { storage }) => storage.reorderSessions(asString(environmentId, "environmentId"), asStringArray(sessionIds)));
  register("cleanup_orphaned_buffers", (_args, { storage }) => storage.cleanupOrphanedBuffers());

  register("get_pane_layout", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "pane-layout", () =>
      storage.getPaneLayout(asString(args.environmentId, "environmentId"))
    ),
  );
  register("save_pane_layout", async (
    { environmentId, layout, expectedRevision },
    { storage },
  ) => {
    const envId = asString(environmentId, "environmentId");
    const value = asRecord(layout, "layout");
    const version = asNumber(value.version, "layout.version");
    if (version !== PANE_LAYOUT_VERSION) {
      throw new Error(paneLayoutUnsupportedVersionMessage(version));
    }
    const activePaneId = asString(value.activePaneId, "layout.activePaneId").trim();
    if (!activePaneId) throw new Error("Expected layout.activePaneId to be non-empty");
    const containerId = value.containerId === null
      ? null
      : asString(value.containerId, "layout.containerId");
    const root = asRecord(value.root, "layout.root");
    return storage.savePaneLayout(envId, {
      version,
      containerId,
      activePaneId,
      root,
    }, asNumber(expectedRevision, "expectedRevision"));
  });
  register("apply_pane_layout_intent", async (
    { environmentId, baseLayout, desiredLayout, selectionIntent },
    { storage },
  ) => {
    const parseLayout = (raw: unknown, label: string) => {
      const value = asRecord(raw, label);
      assertOnlyKeys(value, ["version", "containerId", "activePaneId", "root"], label);
      const version = asNumber(value.version, `${label}.version`);
      if (version !== PANE_LAYOUT_VERSION) {
        throw new Error(paneLayoutUnsupportedVersionMessage(version));
      }
      const activePaneId = asNonBlankString(value.activePaneId, `${label}.activePaneId`);
      const containerId = value.containerId === null
        ? null
        : asString(value.containerId, `${label}.containerId`);
      return {
        version,
        containerId,
        activePaneId,
        root: asRecord(value.root, `${label}.root`),
      };
    };
    let parsedSelectionIntent;
    if (selectionIntent !== undefined) {
      const value = asRecord(selectionIntent, "selectionIntent");
      assertOnlyKeys(value, ["activePaneId", "activeTabIds"], "selectionIntent");
      const activeTabIds = value.activeTabIds === undefined
        ? undefined
        : Object.fromEntries(Object.entries(asRecord(value.activeTabIds, "selectionIntent.activeTabIds")).map(
            ([paneId, tabId]) => {
              if (!paneId.trim()) {
                throw new Error("Expected selectionIntent.activeTabIds keys to be non-empty");
              }
              if (tabId !== null && (typeof tabId !== "string" || !tabId.trim())) {
                throw new Error("Expected selectionIntent.activeTabIds values to be non-empty strings or null");
              }
              return [paneId, tabId];
            },
          ));
      if (activeTabIds && Object.keys(activeTabIds).length > 1_024) {
        throw new Error("selectionIntent.activeTabIds exceeds the 1024 entry limit");
      }
      parsedSelectionIntent = {
        ...(value.activePaneId === undefined
          ? {}
          : { activePaneId: asNonBlankString(value.activePaneId, "selectionIntent.activePaneId") }),
        ...(activeTabIds === undefined ? {} : { activeTabIds }),
      };
    }
    return storage.applyPaneLayoutIntent(
      asString(environmentId, "environmentId"),
      parseLayout(baseLayout, "baseLayout") as never,
      parseLayout(desiredLayout, "desiredLayout") as never,
      parsedSelectionIntent,
    );
  });
  register("delete_pane_layout", ({ environmentId, expectedRevision }, { storage }) => {
    const envId = asString(environmentId, "environmentId");
    return expectedRevision === undefined
      ? storage.deletePaneLayout(envId)
      : storage.deletePaneLayout(
        envId,
        asNumber(expectedRevision, "expectedRevision"),
      );
  });


}

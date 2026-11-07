import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { withAsyncArgumentFailures } from "./commands-registry-async-args.js";
import {
  applyPaneLayoutIntentCommand,
  cleanupOrphanedBuffersCommand,
  createSessionCommand,
  deletePaneLayoutCommand,
  deleteSessionCommand,
  deleteSessionsByEnvironmentCommand,
  disconnectEnvironmentSessionsCommand,
  getPaneLayoutCommand,
  getSessionCommand,
  getSessionsByEnvironmentCommand,
  loadSessionBufferCommand,
  openInBrowserCommand,
  openInEditorCommand,
  openLocalInEditorCommand,
  renameSessionCommand,
  reorderSessionsCommand,
  revealInFileManagerCommand,
  savePaneLayoutCommand,
  saveSessionBufferCommand,
  syncSessionsWithContainerCommand,
  testDomainResolutionCommand,
  updateSessionActivityCommand,
  updateSessionStatusCommand,
  validateDomainsCommand,
} from "@orkestrator/protocol/contract/domains/native-sessions";
import { allowlistEntryDomain, parseAllowlistEntry } from "@orkestrator/protocol/network-allowlist";
import { paneLayoutUnsupportedVersionMessage } from "@orkestrator/protocol/pane-layout";
import { PANE_LAYOUT_VERSION } from "./models.js";
import { runCommand } from "./shell.js";
import type { SessionStatus, SessionType } from "./models.js";
import {
  asString,
  asRecord,
  assertOnlyKeys,
  asBoolean,
  asNumber,
  asStringArray,
  asNonBlankString,
  resolveBrowserOpenCommand,
  resolveFileManagerRevealCommands,
} from "./commands-helpers.js";

export function registerSessionCommands(
  registerCommand: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  // `async` handlers keep rejecting on bad arguments (`commands-registry-async-args.ts`).
  const register = withAsyncArgumentFailures(registerCommand);
  const { conditionalManifestSnapshot } = dependencies;
  register(openInBrowserCommand, ({ url }) => {
    const target = asString(url, "url");
    const { command, args } = resolveBrowserOpenCommand(target);
    // A sign-in URL carries its OAuth state; a failed launch must not echo it.
    return runCommand(command, args, { redactValues: [target, ...args] }).then(() => undefined);
  });
  register(revealInFileManagerCommand, async ({ path: filePath }) => {
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
  register(openInEditorCommand, ({ containerId, editor }) =>
    runCommand(asString(editor, "editor") === "cursor" ? "cursor" : "code", [
      "--folder-uri",
      `vscode-remote://attached-container+${Buffer.from(asString(containerId, "containerId")).toString("hex")}/workspace`,
    ]).then(() => undefined),
  );
  register(openLocalInEditorCommand, ({ path: filePath, editor }) =>
    runCommand(asString(editor, "editor") === "cursor" ? "cursor" : "code", [
      asString(filePath, "path"),
    ]).then(() => undefined),
  );

  register(testDomainResolutionCommand, ({ domains }) => resolveDomains(domains));
  // The older name of the same check.
  register(validateDomainsCommand, ({ domains }) => resolveDomains(domains));

  register(
    createSessionCommand,
    ({ environmentId, containerId, tabId, sessionType }, { storage }) =>
      storage.createSession(
        asString(environmentId, "environmentId"),
        asString(containerId, "containerId"),
        asString(tabId, "tabId"),
        asString(sessionType, "sessionType") as SessionType,
      ),
  );
  register(getSessionCommand, ({ sessionId }, { storage }) =>
    storage.getSession(asString(sessionId, "sessionId")),
  );
  register(getSessionsByEnvironmentCommand, (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "session", () =>
      storage.getSessionsByEnvironment(asString(args.environmentId, "environmentId")),
    ),
  );
  register(updateSessionStatusCommand, ({ sessionId, status }, { storage }) =>
    storage.updateSession(asString(sessionId, "sessionId"), {
      status: asString(status, "status") as SessionStatus,
    }),
  );
  register(updateSessionActivityCommand, ({ sessionId }, { storage }) =>
    storage.updateSession(asString(sessionId, "sessionId"), {
      lastActivityAt: new Date().toISOString(),
    }),
  );
  register(deleteSessionCommand, ({ sessionId }, { storage }) =>
    storage.removeSession(asString(sessionId, "sessionId")),
  );
  register(deleteSessionsByEnvironmentCommand, ({ environmentId }, { storage }) =>
    storage.removeSessionsByEnvironment(asString(environmentId, "environmentId")),
  );
  register(renameSessionCommand, ({ sessionId, name }, { storage }) =>
    storage.updateSession(asString(sessionId, "sessionId"), {
      name: typeof name === "string" ? name : undefined,
    }),
  );
  register(disconnectEnvironmentSessionsCommand, ({ environmentId }, { storage }) =>
    storage.disconnectEnvironmentSessions(asString(environmentId, "environmentId")),
  );
  register(saveSessionBufferCommand, ({ sessionId, buffer }, { storage }) =>
    storage.saveSessionBuffer(asString(sessionId, "sessionId"), asString(buffer, "buffer")),
  );
  register(loadSessionBufferCommand, ({ sessionId }, { storage }) =>
    storage.loadSessionBuffer(asString(sessionId, "sessionId")),
  );
  register(
    syncSessionsWithContainerCommand,
    async ({ environmentId, containerRunning }, { storage }) => {
      const sessions = await storage.getSessionsByEnvironment(
        asString(environmentId, "environmentId"),
      );
      if (!asBoolean(containerRunning)) {
        return storage.disconnectEnvironmentSessions(asString(environmentId, "environmentId"));
      }
      return sessions;
    },
  );
  register(reorderSessionsCommand, ({ environmentId, sessionIds }, { storage }) =>
    storage.reorderSessions(asString(environmentId, "environmentId"), asStringArray(sessionIds)),
  );
  register(cleanupOrphanedBuffersCommand, (_args, { storage }) => storage.cleanupOrphanedBuffers());

  register(getPaneLayoutCommand, (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "pane-layout", () =>
      storage.getPaneLayout(asString(args.environmentId, "environmentId")),
    ),
  );
  register(
    savePaneLayoutCommand,
    async ({ environmentId, layout, expectedRevision }, { storage }) => {
      const envId = asString(environmentId, "environmentId");
      const value = asRecord(layout, "layout");
      const version = asNumber(value.version, "layout.version");
      if (version !== PANE_LAYOUT_VERSION) {
        throw new Error(paneLayoutUnsupportedVersionMessage(version));
      }
      const activePaneId = asString(value.activePaneId, "layout.activePaneId").trim();
      if (!activePaneId) throw new Error("Expected layout.activePaneId to be non-empty");
      const containerId =
        value.containerId === null ? null : asString(value.containerId, "layout.containerId");
      const root = asRecord(value.root, "layout.root");
      return storage.savePaneLayout(
        envId,
        {
          version,
          containerId,
          activePaneId,
          root,
        },
        asNumber(expectedRevision, "expectedRevision"),
      );
    },
  );
  register(
    applyPaneLayoutIntentCommand,
    async ({ environmentId, baseLayout, desiredLayout, selectionIntent }, { storage }) => {
      const parseLayout = (raw: unknown, label: string) => {
        const value = asRecord(raw, label);
        assertOnlyKeys(value, ["version", "containerId", "activePaneId", "root"], label);
        const version = asNumber(value.version, `${label}.version`);
        if (version !== PANE_LAYOUT_VERSION) {
          throw new Error(paneLayoutUnsupportedVersionMessage(version));
        }
        const activePaneId = asNonBlankString(value.activePaneId, `${label}.activePaneId`);
        const containerId =
          value.containerId === null ? null : asString(value.containerId, `${label}.containerId`);
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
        const activeTabIds =
          value.activeTabIds === undefined
            ? undefined
            : Object.fromEntries(
                Object.entries(asRecord(value.activeTabIds, "selectionIntent.activeTabIds")).map(
                  ([paneId, tabId]) => {
                    if (!paneId.trim()) {
                      throw new Error("Expected selectionIntent.activeTabIds keys to be non-empty");
                    }
                    if (tabId !== null && (typeof tabId !== "string" || !tabId.trim())) {
                      throw new Error(
                        "Expected selectionIntent.activeTabIds values to be non-empty strings or null",
                      );
                    }
                    return [paneId, tabId];
                  },
                ),
              );
        if (activeTabIds && Object.keys(activeTabIds).length > 1_024) {
          throw new Error("selectionIntent.activeTabIds exceeds the 1024 entry limit");
        }
        parsedSelectionIntent = {
          ...(value.activePaneId === undefined
            ? {}
            : {
                activePaneId: asNonBlankString(value.activePaneId, "selectionIntent.activePaneId"),
              }),
          ...(activeTabIds === undefined ? {} : { activeTabIds }),
        };
      }
      return storage.applyPaneLayoutIntent(
        asString(environmentId, "environmentId"),
        parseLayout(baseLayout, "baseLayout") as never,
        parseLayout(desiredLayout, "desiredLayout") as never,
        parsedSelectionIntent,
      );
    },
  );
  register(deletePaneLayoutCommand, ({ environmentId, expectedRevision }, { storage }) => {
    const envId = asString(environmentId, "environmentId");
    return expectedRevision === undefined
      ? storage.deletePaneLayout(envId)
      : storage.deletePaneLayout(envId, asNumber(expectedRevision, "expectedRevision"));
  });
}

/** Resolves allow-list domains on the host (`test_domain_resolution`, `validate_domains`). */
function resolveDomains(domains: unknown) {
  return Promise.all(
    asStringArray(domains).map(async (domain) => {
      // Keep bare-host DNS diagnostics (including localhost), but never
      // strip an invalid port and report the resulting host as valid.
      const entry = parseAllowlistEntry(domain);
      if (domain.includes(":") && !entry) {
        return {
          domain,
          valid: false,
          resolvable: false,
          ips: [],
          error: "Invalid domain or port",
        };
      }
      try {
        const dns = await import("node:dns/promises");
        const ips = (
          await dns.lookup(entry?.domain ?? allowlistEntryDomain(domain), { all: true })
        ).map(({ address }) => address);
        return { domain, valid: true, resolvable: true, ips, error: null };
      } catch (error) {
        return {
          domain,
          valid: true,
          resolvable: false,
          ips: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

import type { McpManagementSnapshot } from "@orkestrator/protocol/mcp-management";

import { applyStateText } from "./McpApplyStatus";
import {
  latestRuntimeApply,
  mcpApplyRuntimeId,
  type McpLiveJoin,
  type McpLiveServerRef,
} from "./mcp-live-join";

/**
 * Says which saved row a live session's server link resolved to, and what the
 * newest apply reported for that same session. Shown only for the target the
 * link came from.
 */
export function McpLiveJoinNotice({
  liveRef,
  join,
  snapshot,
}: {
  liveRef: McpLiveServerRef;
  join: Exclude<McpLiveJoin, { kind: "other-target" }>;
  snapshot: McpManagementSnapshot;
}) {
  const name = liveRef.serverName;
  const text =
    join.kind === "saved"
      ? `The session's ${name} is the highlighted row in ${join.sourceLabel}${
          join.loadedAs ? ` (loaded as ${join.loadedAs})` : ""
        }.${
          join.alsoNamed
            ? ` ${join.alsoNamed === 1 ? "Another row has" : `${join.alsoNamed} other rows have`} the same name; the session does not load ${join.alsoNamed === 1 ? "it" : "them"}.`
            : ""
        }`
      : join.kind === "injected"
        ? `${name} is Orkestrator's own connection, added when the session starts. It is not saved in these files.`
        : join.kind === "plugin"
          ? join.entryId
            ? `The session's ${name} is the highlighted row in ${join.sourceLabel}. Plugin servers are read-only here; they are managed by the provider's plugin settings.${
                join.disabledReason
                  ? ` The files now say the plugin is off (${join.disabledReason.replace(/\.$/, "")}); the session loaded it before that changed, or loads it some other way.`
                  : ""
              }`
            : `${name} comes from a plugin. Plugin servers are managed by the provider's plugin settings, not these files.`
          : `No saved server named ${name} is in this target's files. It may come from a layer this editor does not read, such as a plugin, team settings or a provider profile, or the file changed since the session loaded it.`;
  const runtime =
    liveRef.logicalSessionKey && liveRef.environmentId
      ? latestRuntimeApply(
          snapshot.operations,
          mcpApplyRuntimeId(liveRef.environmentId, liveRef.logicalSessionKey),
        )
      : null;
  return (
    <div
      className="space-y-1 rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-xs"
      role="note"
      aria-label="Server from the live session"
    >
      <p className="text-foreground">{text}</p>
      {runtime ? (
        <p className="text-muted-foreground">
          This session, after the latest change to {runtime.operation.entryName}:{" "}
          {applyStateText(runtime.runtime.state)}
          {runtime.runtime.reason ? ` — ${runtime.runtime.reason}` : ""}
        </p>
      ) : null}
    </div>
  );
}

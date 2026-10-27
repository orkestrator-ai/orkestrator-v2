import { ShieldCheck } from "lucide-react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { describePermissionRule } from "@orkestrator/protocol/permission-rules";
import { Button } from "@/components/ui/button";
import { usePermissionRuleSession } from "@/hooks/usePermissionRuleSession";
import { requestGlobalSettings } from "@/lib/settings-navigation";

/** The latest answers listed; the full record is in Settings → Permissions. */
const MAX_LISTED = 8;

/**
 * Agent information: the Orkestrator permission rules (todo 0723) that
 * answered requests in this session, newest first, and where to manage them.
 * Hidden until a rule has applied here.
 */
export function AgentInfoPermissionRules({
  environmentId,
  agent,
  logicalSessionKey,
}: {
  environmentId: string;
  agent: AgentPlatform;
  logicalSessionKey: string;
}) {
  const { applications, rules } = usePermissionRuleSession(environmentId, agent, logicalSessionKey);
  if (applications.length === 0) return null;
  const ruleIds = new Set(rules.map((rule) => rule.id));
  const latest = [...applications].reverse().slice(0, MAX_LISTED);
  return (
    <div
      className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-xs"
      data-testid="agent-info-permission-rules"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
          Approved by your rules
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => requestGlobalSettings("permissions")}
        >
          Manage
        </Button>
      </div>
      <p className="mt-0.5 text-muted-foreground">
        {applications.length} {applications.length === 1 ? "request" : "requests"} in this session
        answered once each by an Orkestrator rule.
      </p>
      <ul className="mt-2 space-y-1">
        {latest.map((application) => (
          <li key={application.interactionId} className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate" title={describePermissionRule(application)}>
              <code className="font-mono">{application.pattern}</code>
              {ruleIds.has(application.ruleId) ? "" : " (removed)"}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {new Date(application.appliedAt).toLocaleTimeString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

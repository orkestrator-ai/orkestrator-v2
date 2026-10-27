import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { PermissionRuleApplication } from "@orkestrator/protocol/permission-rules";
import { Button } from "@/components/ui/button";
import { deletePermissionRule } from "@/lib/backend";

/**
 * "Approved by rule …": a request an Orkestrator permission rule answered
 * with a one-time approval (todo 0723), with a quick way to remove the rule.
 * Removing it makes the next matching request ask again.
 */
export function PermissionRuleNote({
  application,
  ruleExists,
}: {
  application: PermissionRuleApplication;
  ruleExists: boolean;
}) {
  const [removing, setRemoving] = useState(false);
  const [removed, setRemoved] = useState(false);
  const remove = async () => {
    setRemoving(true);
    try {
      await deletePermissionRule(application.ruleId);
      setRemoved(true);
      toast.success("Rule removed", {
        description: "Matching requests will ask again.",
      });
    } catch (cause) {
      toast.error("Could not remove the rule", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setRemoving(false);
    }
  };
  const live = ruleExists && !removed;
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      data-testid="permission-rule-note"
    >
      <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
      <span>
        Approved once by your rule <code className="font-mono">{application.pattern}</code> (
        {application.scope === "environment" ? "this environment" : "this project"})
        {live ? "" : " · rule since removed"}
      </span>
      {live ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          disabled={removing}
          onClick={() => void remove()}
        >
          Remove rule
        </Button>
      ) : null}
    </div>
  );
}

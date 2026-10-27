import { useId, useState } from "react";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import type { AgentInteractionProvider } from "@orkestrator/protocol/agent-interactions";
import {
  PERMISSION_RULE_EXPIRY_CHOICES_MS,
  describePermissionRule,
  type PermissionRuleOffer,
  type PermissionRuleScope,
} from "@orkestrator/protocol/permission-rules";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SegmentedSelector } from "@/components/ui/segmented-selector";
import type { PermissionRuleChoiceInput } from "@/lib/backend/permission-rules";
import { cn } from "@/lib/utils";

const DAY_MS = 24 * 60 * 60 * 1_000;

function expiryLabel(ms: number): string {
  const days = Math.round(ms / DAY_MS);
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * The card's "Approve and remember" panel (todo 0723): the exact pattern and
 * scope are shown before anything is saved, narrowest first, and the rule is
 * Orkestrator's own — never written into the provider's settings.
 */
export function RememberRulePanel({
  offer,
  provider,
  disabled,
  onConfirm,
  onCancel,
}: {
  offer: PermissionRuleOffer;
  provider: AgentInteractionProvider;
  disabled: boolean;
  onConfirm: (choice: PermissionRuleChoiceInput) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [patternIndex, setPatternIndex] = useState(offer.suggested);
  const [scope, setScope] = useState<PermissionRuleScope>("project");
  const [anyProvider, setAnyProvider] = useState(false);
  const [expiry, setExpiry] = useState<string>("never");
  const pattern = offer.patterns[patternIndex] ?? offer.patterns[0];
  const providerLabel =
    (AGENT_PLATFORM_LABELS as Record<string, string | undefined>)[provider] ?? provider;

  if (offer.unavailableReason || !pattern) {
    return (
      <div
        className="mt-3 rounded-md border border-border/60 bg-muted/20 p-3 text-xs"
        data-testid="remember-rule-panel"
      >
        <p className="text-muted-foreground">{offer.unavailableReason}</p>
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mt-3 space-y-3 rounded-md border border-border/60 bg-muted/20 p-3 text-xs"
      data-testid="remember-rule-panel"
      role="group"
      aria-labelledby={`${id}-title`}
    >
      <div>
        <p id={`${id}-title`} className="font-medium text-foreground">
          Remember as an Orkestrator rule
        </p>
        <p className="mt-1 text-muted-foreground">
          Orkestrator answers matching requests itself, one approval at a time. Nothing is saved in{" "}
          {providerLabel}'s own settings, and you can remove the rule in Settings → Permissions.
        </p>
      </div>

      <fieldset className="space-y-1">
        <legend className="mb-1 font-medium">Pattern</legend>
        {offer.patterns.map((candidate, index) => (
          <label
            key={candidate}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded px-2 py-1",
              index === patternIndex ? "bg-background/80" : "hover:bg-background/40",
            )}
          >
            <input
              type="radio"
              name={`${id}-pattern`}
              className="mt-0.5"
              checked={index === patternIndex}
              onChange={() => setPatternIndex(index)}
            />
            <span className="min-w-0">
              <code className="break-all font-mono text-[11px]">{candidate}</code>
              {index === 0 ? <span className="ml-2 text-muted-foreground">(narrowest)</span> : null}
            </span>
          </label>
        ))}
        <p className="pt-1 text-muted-foreground">
          {describePermissionRule({ kind: offer.kind, pattern })}
          {offer.kind === "command-prefix"
            ? ", with any further arguments. Commands with shell operators always ask."
            : "."}
        </p>
      </fieldset>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SegmentedSelector
          ariaLabel="Rule scope"
          value={scope}
          onValueChange={setScope}
          options={[
            { value: "project", label: "This project" },
            { value: "environment", label: "This environment" },
          ]}
        />
        <SegmentedSelector
          ariaLabel="Rule expiry"
          value={expiry}
          onValueChange={setExpiry}
          options={[
            { value: "never", label: "Until removed" },
            ...PERMISSION_RULE_EXPIRY_CHOICES_MS.map((ms) => ({
              value: String(ms),
              label: expiryLabel(ms),
            })),
          ]}
        />
        <label className="flex items-center gap-2">
          <Checkbox
            checked={anyProvider}
            onCheckedChange={(checked) => setAnyProvider(checked === true)}
            aria-label="Also answer for other agents"
          />
          <span>Also for other agents</span>
        </label>
      </div>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() =>
            onConfirm({
              pattern,
              scope,
              anyProvider,
              ...(expiry === "never" ? {} : { expiresInMs: Number(expiry) }),
            })
          }
        >
          Approve and remember
        </Button>
      </div>
    </div>
  );
}

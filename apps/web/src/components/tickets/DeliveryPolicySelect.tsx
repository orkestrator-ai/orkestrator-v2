import { useId } from "react";
import {
  DELIVERY_POLICY_LABELS,
  deliveryPolicyChoices,
  effectiveDeliveryPolicy,
  isDeliveryPolicy,
  type DeliveryPolicy,
} from "@orkestrator/protocol/ticket-sections";
import { cn } from "@/lib/utils";

/**
 * The "When verified" dropdown: what a build does once Verify passes.
 *
 * `offeredFor` is the policy the ticket holds, which decides the choices: the
 * rarely wanted `commit-only` stays listed only for a ticket that already has
 * it, including after the user picks something else in the launch dialog.
 */
export function DeliveryPolicySelect({
  value,
  offeredFor = value,
  onChange,
  disabled,
  className,
}: {
  value: DeliveryPolicy | undefined;
  offeredFor?: DeliveryPolicy;
  onChange: (policy: DeliveryPolicy) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <label htmlFor={id} className="shrink-0 text-xs font-medium text-muted-foreground">
        When verified
      </label>
      <select
        id={id}
        data-testid="delivery-policy-select"
        value={effectiveDeliveryPolicy(value)}
        disabled={disabled}
        onChange={(event) => {
          if (isDeliveryPolicy(event.target.value)) onChange(event.target.value);
        }}
        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground disabled:opacity-50"
      >
        {deliveryPolicyChoices(offeredFor).map((policy) => (
          <option key={policy} value={policy}>
            {DELIVERY_POLICY_LABELS[policy]}
          </option>
        ))}
      </select>
    </div>
  );
}

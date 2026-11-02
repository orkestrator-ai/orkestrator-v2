import type { DeliveryPolicy } from "@orkestrator/protocol/ticket-sections";

/** Shared Ship card copy for launchers. */
export const DELIVERY_STEP_DESCRIPTIONS: Record<DeliveryPolicy, string> = {
  "open-pr": "Pushes the branch and opens the pull request.",
  "push-no-pr": "Pushes the branch. No pull request is opened.",
  "commit-only": "This step does not run: the commits stay in the environment.",
};

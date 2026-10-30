import { toast } from "sonner";
import type { Environment, EnvironmentUnreadReason } from "@/types";
import { UnreadBellIcon } from "./UnreadBellIcon";

interface UnreadReasonCopy {
  title: string;
  description: string;
}

const UNREAD_REASON_COPY: Record<EnvironmentUnreadReason, UnreadReasonCopy> = {
  agent_finished: {
    title: "Agent finished",
    description: "The agent completed its work.",
  },
  agent_failed: {
    title: "Agent stopped with an error",
    description: "The agent's turn failed before it finished. Open the tab to see the error.",
  },
  agent_ready: {
    title: "Agent ready for input",
    description: "You can send another message while background work continues.",
  },
  agent_waiting: {
    title: "Agent needs your input",
    description: "The agent stopped and is waiting for you to respond.",
  },
  agent_question: {
    title: "Agent asked a question",
    description: "The agent asked a question for you to answer.",
  },
  terminal_finished: {
    title: "Terminal agent finished",
    description: "An agent running in a terminal finished.",
  },
  marked_unread: {
    title: "Marked unread",
    description: "This environment was marked unread.",
  },
};

const UNKNOWN_REASON_COPY: UnreadReasonCopy = {
  title: "New activity",
  description: "There is activity here you have not seen yet.",
};

export function describeUnreadReason(
  reason: EnvironmentUnreadReason | undefined,
): UnreadReasonCopy {
  return (reason && UNREAD_REASON_COPY[reason]) || UNKNOWN_REASON_COPY;
}

function environmentLabel(environment: Environment): string {
  return environment.projectHome && environment.name === "project-home"
    ? "Project home"
    : environment.name;
}

/**
 * Tells the user what lit an environment's bell as they open it. Keyed by
 * environment so a repeated activation replaces rather than stacks the toast;
 * the shared Toaster dismisses it on click or after the default duration.
 */
export function showEnvironmentUnreadToast(environment: Environment): void {
  const copy = describeUnreadReason(environment.unreadReason);
  toast(copy.title, {
    id: `environment-unread:${environment.id}`,
    description: `${environmentLabel(environment)}: ${copy.description}`,
    icon: <UnreadBellIcon aria-hidden="true" className="size-4" />,
    position: "top-right",
  });
}

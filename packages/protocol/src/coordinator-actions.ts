/** Small, replayable marks carried by successful coordinator tool results. */
export interface CoordinatorActionMark {
  version: 1;
  kind: "topic" | "question";
  title: string;
}

export function coordinatorActionMark(
  kind: CoordinatorActionMark["kind"],
  title: string,
): CoordinatorActionMark {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 120) throw new Error("Use a title of 1–120 characters");
  return { version: 1, kind, title: normalized };
}

export const COORDINATOR_ACTION_GUIDANCE =
  "mark_topic(title): once per new user subject, not follow-ups. mark_question(title): question to user.";

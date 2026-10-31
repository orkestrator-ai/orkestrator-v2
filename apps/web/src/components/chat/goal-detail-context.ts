import { createContext } from "react";
import type { NativeAgentGoalDetail } from "@/lib/backend";

/**
 * Reads this tab's goal with its check output. Output is left out of the session
 * snapshot, so a transcript row asks for it when the reader expands the row.
 */
export const GoalDetailLoaderContext = createContext<
  (() => Promise<NativeAgentGoalDetail>) | undefined
>(undefined);

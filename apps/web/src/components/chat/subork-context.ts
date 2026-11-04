import { createContext } from "react";

/** What a transcript's subork group can ask of its tab. */
export interface SuborkGroupActions {
  /** Opens one subork's transcript. */
  openTranscript(batchId: string, suborkId: string): void;
  /** Stops a running call. */
  stop(batchId: string): Promise<void>;
}

export const SuborkGroupActionsContext = createContext<SuborkGroupActions | undefined>(undefined);

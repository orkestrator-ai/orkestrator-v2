import { create } from "zustand";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";

interface NativeAgentProjectionState {
  projections: ReadonlyMap<string, NativeAgentSessionProjection>;
  turnStopMarkers: ReadonlyMap<string, { sessionId: string; createdAt: string }>;
  setProjection: (sessionKey: string, projection: NativeAgentSessionProjection | null) => void;
  markTurnStopped: (sessionKey: string, sessionId: string) => void;
  clearTurnStopped: (sessionKey: string) => void;
  reset: () => void;
}

/** Renderer cache only; the backend projection remains authoritative. */
export const useNativeAgentProjectionStore = create<NativeAgentProjectionState>((set) => ({
  projections: new Map(),
  turnStopMarkers: new Map(),
  setProjection: (sessionKey, projection) => set((state) => {
    const next = new Map(state.projections);
    if (projection) next.set(sessionKey, projection);
    else next.delete(sessionKey);
    return { projections: next };
  }),
  markTurnStopped: (sessionKey, sessionId) => set((state) => {
    const next = new Map(state.turnStopMarkers);
    next.set(sessionKey, { sessionId, createdAt: new Date().toISOString() });
    return { turnStopMarkers: next };
  }),
  clearTurnStopped: (sessionKey) => set((state) => {
    if (!state.turnStopMarkers.has(sessionKey)) return state;
    const next = new Map(state.turnStopMarkers);
    next.delete(sessionKey);
    return { turnStopMarkers: next };
  }),
  reset: () => set({ projections: new Map(), turnStopMarkers: new Map() }),
}));

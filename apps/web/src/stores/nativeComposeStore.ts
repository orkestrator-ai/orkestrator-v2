import { create } from "zustand";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentConversationMode } from "@orkestrator/protocol/native-agent";
import type { FileMention } from "@/types";
import type { WorkspaceAttachment } from "@/components/chat/NativeAttachmentMenu";

export interface NativeComposeDraft {
  text: string;
  mentions: FileMention[];
  attachments: WorkspaceAttachment[];
  platform?: AgentPlatform;
  modelId?: string;
  reasoningId?: string;
  fastMode: boolean;
  mode: AgentConversationMode;
}

const EMPTY_DRAFT: NativeComposeDraft = {
  text: "",
  mentions: [],
  attachments: [],
  fastMode: false,
  mode: "build",
};

interface NativeComposeState {
  drafts: Map<string, NativeComposeDraft>;
  updateDraft: (sessionKey: string, update: Partial<NativeComposeDraft>) => void;
  clearDraft: (sessionKey: string) => void;
}

export function nativeComposeDraft(
  state: NativeComposeState,
  sessionKey: string,
): NativeComposeDraft {
  return state.drafts.get(sessionKey) ?? EMPTY_DRAFT;
}

export const useNativeComposeStore = create<NativeComposeState>()((set) => ({
  drafts: new Map(),
  updateDraft: (sessionKey, update) => set((state) => {
    const drafts = new Map(state.drafts);
    drafts.set(sessionKey, { ...EMPTY_DRAFT, ...drafts.get(sessionKey), ...update });
    return { drafts };
  }),
  clearDraft: (sessionKey) => set((state) => {
    if (!state.drafts.has(sessionKey)) return state;
    const drafts = new Map(state.drafts);
    drafts.delete(sessionKey);
    return { drafts };
  }),
}));

import { useRef, useState } from "react";
import { nativeAgentApprovalModes } from "@orkestrator/protocol/native-agent";
import {
  approvalModeIconOption,
  ComposerIconPicker,
  conversationModeIconOption,
} from "../../apps/web/src/components/chat/ComposerIconPicker";
import type { MentionableInputRef } from "../../apps/web/src/components/chat/MentionableInput";
import { NativeComposeBar } from "../../apps/web/src/components/chat/NativeComposeBar";

/** The compose bar's mode and approval pickers, docked at the bottom like the real tab. */
export function ComposerIconPickersFixture() {
  const [mode, setMode] = useState("build");
  const [approvalMode, setApprovalMode] = useState("bypassPermissions");
  const inputRef = useRef<MentionableInputRef | null>(null);
  const inputContainerRef = useRef<HTMLDivElement | null>(null);

  return (
    <main className="flex h-screen flex-col justify-end bg-background text-foreground">
      <NativeComposeBar
        attachments={[]}
        onRemoveAttachment={() => {}}
        inputRef={inputRef}
        inputContainerRef={inputContainerRef}
        text=""
        mentions={[]}
        onTextAndMentionsChange={() => {}}
        onCursorPositionChange={() => {}}
        onKeyDown={() => {}}
        placeholder="Send a message"
        onSend={async () => {}}
        onStop={async () => {}}
        primaryControls={
          <>
            <ComposerIconPicker
              label="Mode"
              testId="fixture-mode-picker"
              options={[
                conversationModeIconOption("build", "Build"),
                conversationModeIconOption("plan", "Plan"),
              ]}
              value={mode}
              onValueChange={setMode}
            />
            <ComposerIconPicker
              label="Approvals"
              testId="fixture-approval-picker"
              options={nativeAgentApprovalModes("claude", undefined).map(approvalModeIconOption)}
              value={approvalMode}
              onValueChange={setApprovalMode}
            />
          </>
        }
      />
    </main>
  );
}

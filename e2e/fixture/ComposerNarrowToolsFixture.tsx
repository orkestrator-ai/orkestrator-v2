import { useRef } from "react";
import { SessionInteractionTools } from "../../apps/web/src/components/chat/interactions/composer/SessionInteractionTools";
import type { MentionableInputRef } from "../../apps/web/src/components/chat/MentionableInput";
import { NativeAttachmentMenu } from "../../apps/web/src/components/chat/NativeAttachmentMenu";
import { NativeComposeBar } from "../../apps/web/src/components/chat/NativeComposeBar";
import { buildDesignAgentContextAnnotation } from "../../apps/web/src/components/design/design-launch";

const fileSearch = {
  searchFiles: () => [],
  isLoading: false,
  error: null,
  refresh: () => {},
  isAvailable: true,
};

/**
 * The agent tab's composer in a chat column of `?width=` pixels (the chat
 * shell is the nearest `@container`, as in the real tab). The primary controls
 * lead with the session tools, then attachments (+), like the real tab.
 * `?design-context` shows a new design tab's composer: no prompt was sent, and
 * the canvas guidance waits as design context for the user's first message.
 */
export function ComposerNarrowToolsFixture() {
  const params = new URLSearchParams(window.location.search);
  const width = Number(params.get("width") ?? 900);
  const designContext = params.has("design-context");
  const inputRef = useRef<MentionableInputRef | null>(null);
  const inputContainerRef = useRef<HTMLDivElement | null>(null);
  return (
    <main className="flex h-screen bg-background text-foreground">
      <div
        data-testid="chat-column"
        className="@container flex h-full flex-col justify-end border-r border-border"
        style={{ width }}
      >
        <NativeComposeBar
          attachments={[]}
          onRemoveAttachment={() => {}}
          inputRef={inputRef}
          inputContainerRef={inputContainerRef}
          text={designContext ? "" : "Please use the code that we have"}
          annotations={
            designContext
              ? [
                  buildDesignAgentContextAnnotation({
                    id: "design-context",
                    canvasId: "canvas-1",
                    canvasName: "Founder - add info",
                  }),
                ]
              : []
          }
          onClearAnnotations={() => {}}
          mentions={[]}
          onTextAndMentionsChange={() => {}}
          onCursorPositionChange={() => {}}
          onKeyDown={() => {}}
          placeholder="Send a message"
          onSend={async () => {}}
          onStop={async () => {}}
          primaryControls={
            <>
              <SessionInteractionTools environmentId="env-1" logicalSessionKey="env-1:tab-1" />
              <NativeAttachmentMenu fileSearch={fileSearch} onSelectFile={() => {}} />
            </>
          }
        />
      </div>
    </main>
  );
}

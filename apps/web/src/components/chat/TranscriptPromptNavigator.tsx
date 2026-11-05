import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { TranscriptScrollController } from "@/lib/transcript-scroll/transcript-scroll-controller";
import {
  collectTranscriptPrompts,
  promptLineEmphasis,
  replyPreviewFor,
  type TranscriptPrompt,
} from "./transcript-prompts";

/** Where a prompt lands: clear of the viewport's top edge, its reply below it. */
const LANDING_OFFSET_PX = 16;
const LINE_WIDTH_PX = 10;
const LINE_GROWTH_PX = 14;
const LINE_OPACITY = 0.22;

const NO_PROMPTS: readonly TranscriptPrompt[] = [];

interface TranscriptPromptNavigatorProps {
  messages: readonly NativeMessage[];
  controller: TranscriptScrollController;
  /** The dock floating over the transcript's end; the rail centres in what is left. */
  bottomInsetPx: number | null;
}

/** The prompts in `messages`, reusing what the previous update already parsed. */
function useTranscriptPrompts(messages: readonly NativeMessage[]): readonly TranscriptPrompt[] {
  const [tracked, setTracked] = useState(() => ({
    messages,
    prompts: collectTranscriptPrompts(messages, NO_PROMPTS),
  }));
  if (tracked.messages === messages) return tracked.prompts;
  const prompts = collectTranscriptPrompts(messages, tracked.prompts);
  // Derived from the previous render's prompts; React re-renders before commit.
  setTracked({ messages, prompts });
  return prompts;
}

/**
 * A rail of the user's prompts on the transcript's left edge, so a prompt can
 * be found among the agent's much longer output. A line swells and brightens
 * under the pointer, previews its prompt, and glides the transcript there.
 */
export function TranscriptPromptNavigator({
  messages,
  controller,
  bottomInsetPx,
}: TranscriptPromptNavigatorProps) {
  const prompts = useTranscriptPrompts(messages);
  const regionRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<{ id: string; centerPx: number } | null>(null);
  const activeIndex = active ? prompts.findIndex((prompt) => prompt.id === active.id) : -1;
  const activePrompt = prompts[activeIndex];
  const activeId = activePrompt?.id;
  const reply = useMemo(
    () => (activeId ? replyPreviewFor(messages, activeId) : ""),
    [activeId, messages],
  );

  if (prompts.length === 0) return null;

  const activate = (id: string, element: HTMLElement) => {
    const region = regionRef.current?.getBoundingClientRect();
    const line = element.getBoundingClientRect();
    setActive({ id, centerPx: line.top + line.height / 2 - (region?.top ?? 0) });
  };

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const buttons = event.currentTarget.parentElement?.children;
    (buttons?.[index + step] as HTMLElement | undefined)?.focus();
  };

  // One tab stop for the rail; the arrow keys move along it.
  const tabStopId = activeId ?? prompts.at(-1)!.id;

  return (
    <div
      ref={regionRef}
      data-testid="transcript-prompt-navigator"
      className="pointer-events-none absolute inset-x-0 top-0 z-20 hidden items-center py-4 @lg:flex"
      style={{ bottom: bottomInsetPx ?? 0 }}
    >
      <nav
        aria-label="Your prompts in this conversation"
        className="pointer-events-auto flex max-h-full w-8 flex-col"
        onPointerLeave={() => setActive(null)}
      >
        {prompts.map((prompt, index) => {
          const emphasis = activeIndex < 0 ? 0 : promptLineEmphasis(Math.abs(index - activeIndex));
          return (
            <button
              key={prompt.id}
              type="button"
              tabIndex={prompt.id === tabStopId ? 0 : -1}
              aria-label={`Go to prompt ${index + 1} of ${prompts.length}: ${prompt.text}`}
              aria-current={index === activeIndex ? "true" : undefined}
              className="relative h-2 min-h-0 w-full shrink cursor-pointer outline-none"
              // Jumping through the transcript leaves focus in the composer.
              onMouseDown={(event) => event.preventDefault()}
              onPointerEnter={(event) => activate(prompt.id, event.currentTarget)}
              onFocus={(event) => {
                if (event.currentTarget.matches(":focus-visible")) {
                  activate(prompt.id, event.currentTarget);
                }
              }}
              onBlur={() => setActive(null)}
              onKeyDown={(event) => moveFocus(event, index)}
              onClick={() =>
                controller.glideTo(
                  {
                    kind: "row",
                    index: messages.findIndex((message) => message.id === prompt.id),
                    key: prompt.id,
                    offsetPx: LANDING_OFFSET_PX,
                  },
                  "row",
                )
              }
            >
              <span
                aria-hidden="true"
                className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-foreground transition-[width,height,opacity] duration-150 ease-out motion-reduce:transition-none"
                style={{
                  width: LINE_WIDTH_PX + LINE_GROWTH_PX * emphasis,
                  height: emphasis === 1 ? 3 : 2,
                  opacity: LINE_OPACITY + (1 - LINE_OPACITY) * emphasis,
                }}
              />
            </button>
          );
        })}
      </nav>
      {activePrompt && active ? (
        <div
          aria-hidden="true"
          data-testid="transcript-prompt-preview"
          // Centred on its line, and held inside the region at either end.
          className="absolute left-9 w-80 max-w-[calc(100%-3rem)] -translate-y-1/2 rounded-xl border border-border bg-popover px-3.5 py-2.5 shadow-lg transition-[top] duration-150 ease-out motion-reduce:transition-none"
          style={{ top: `clamp(3.75rem, ${active.centerPx}px, calc(100% - 3.75rem))` }}
        >
          <p className="truncate text-sm font-medium text-popover-foreground">
            {activePrompt.text}
          </p>
          {reply ? (
            <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{reply}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

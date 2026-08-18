import {
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
  type KeyboardEvent,
  type ClipboardEvent,
} from "react";
import { cn } from "@/lib/utils";
import type { FileMention } from "@/types";

interface MentionableInputProps {
  value: string;
  mentions: FileMention[];
  onChange: (text: string, mentions: FileMention[]) => void;
  onCursorChange?: (position: number, text: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  minHeight?: number;
  maxHeight?: number;
}

export interface MentionableInputRef {
  focus: () => void;
  blur: () => void;
  getCursorPosition: () => number;
  insertMention: (mention: FileMention) => void;
  insertMentionAtCursor: (mention: FileMention) => void;
}

function isBlockElement(el: HTMLElement): boolean {
  const tag = el.tagName;
  return tag === "DIV" || tag === "P" || tag === "BLOCKQUOTE";
}

function extractText(element: HTMLElement): string {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || "";
    } else if (node instanceof HTMLElement) {
      if (node.dataset.mention === "true") {
        text += node.textContent || "";
      } else if (node.tagName === "BR") {
        text += "\n";
      } else if (isBlockElement(node)) {
        // Block elements created by contenteditable (e.g. <div> on Enter)
        // need a newline separator unless we're at the start
        if (text.length > 0 && !text.endsWith("\n")) {
          text += "\n";
        }
        text += extractText(node);
      } else {
        text += extractText(node);
      }
    }
  }
  return text;
}

function getCursorOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return 0;
  }

  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) {
    return extractText(element).length;
  }

  const preCaretRange = range.cloneRange();
  preCaretRange.selectNodeContents(element);
  preCaretRange.setEnd(range.startContainer, range.startOffset);

  const fragment = preCaretRange.cloneContents();
  const div = document.createElement("div");
  div.appendChild(fragment);
  return extractText(div).length;
}

function setCursorOffset(element: HTMLElement, offset: number): void {
  const selection = window.getSelection();
  if (!selection) return;

  let currentOffset = 0;
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    null,
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      const nodeText = textNode.textContent || "";
      if (currentOffset + nodeText.length >= offset) {
        const range = document.createRange();
        range.setStart(textNode, Math.max(0, offset - currentOffset));
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      currentOffset += nodeText.length;
      continue;
    }

    if (!(node instanceof HTMLElement) || node.tagName !== "BR") continue;

    const newlineEnd = currentOffset + 1;
    if (newlineEnd >= offset) {
      const parent = node.parentNode;
      if (!parent) continue;
      const childIndex = Array.prototype.indexOf.call(parent.childNodes, node);
      const range = document.createRange();
      range.setStart(parent, childIndex + Math.max(0, Math.min(1, offset - currentOffset)));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    currentOffset = newlineEnd;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function renderMentionHtml(pattern: string, mention: FileMention): string {
  return `<span class="text-blue-500 font-medium" data-mention="true" data-id="${escapeAttr(mention.id)}" data-filename="${escapeAttr(mention.filename)}" data-path="${escapeAttr(mention.relativePath)}" contenteditable="false">${escapeHtml(pattern)}</span>`;
}

function renderContent(text: string, mentions: FileMention[]): string {
  if (mentions.length === 0) {
    return escapeHtml(text).replace(/\n/g, "<br>");
  }

  const mentionMap = new Map<string, FileMention>();
  for (const mention of mentions) {
    mentionMap.set(`@${mention.filename}`, mention);
  }

  const sortedPatterns = Array.from(mentionMap.keys()).sort((a, b) => b.length - a.length);
  const matcher = new RegExp(sortedPatterns.map(escapeRegExp).join("|"), "g");
  let result = "";
  let previousEnd = 0;

  for (const match of text.matchAll(matcher)) {
    const matchStart = match.index;
    const pattern = match[0];
    const mention = mentionMap.get(pattern)!;

    result += escapeHtml(text.slice(previousEnd, matchStart));
    result += renderMentionHtml(pattern, mention);
    previousEnd = matchStart + pattern.length;
  }

  result += escapeHtml(text.slice(previousEnd));
  return result.replace(/\n/g, "<br>");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMentionTokenRange(
  text: string,
  cursorPosition: number,
): { start: number; end: number } | null {
  const cursor = Math.max(0, Math.min(cursorPosition, text.length));
  if (cursor === 0) return null;

  const atStart = text.lastIndexOf("@", cursor - 1);
  if (atStart === -1) return null;

  const tokenBeforeCursor = text.slice(atStart + 1, cursor);
  if (/\s|@/.test(tokenBeforeCursor)) return null;

  const tokenAfterCursor = text.slice(cursor).match(/^[^\s@]*/)?.[0] ?? "";
  return {
    start: atStart,
    end: cursor + tokenAfterCursor.length,
  };
}

function areMentionsEqual(a: FileMention[], b: FileMention[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((mention, index) => {
    const other = b[index];
    return (
      mention.id === other?.id &&
      mention.filename === other.filename &&
      mention.relativePath === other.relativePath
    );
  });
}

function focusEditableElement(element: HTMLElement): void {
  element.focus({ preventScroll: true });
}

export const MentionableInput = forwardRef<MentionableInputRef, MentionableInputProps>(
  function MentionableInput(
    {
      value,
      mentions,
      onChange,
      onCursorChange,
      onKeyDown,
      placeholder = "Type a message...",
      disabled = false,
      className,
      minHeight = 28,
      maxHeight = 216,
    },
    ref,
  ) {
    const inputRef = useRef<HTMLDivElement>(null);
    const lastValueRef = useRef(value);
    const lastMentionsRef = useRef(mentions);
    const isComposingRef = useRef(false);
    const pendingCursorRef = useRef<number | null>(null);
    const pendingFocusRef = useRef(false);
    const initializedRef = useRef(false);
    const lastCursorPositionRef = useRef(value.length);

    useImperativeHandle(ref, () => ({
      focus: () => {
        if (inputRef.current) {
          focusEditableElement(inputRef.current);
        }
      },
      blur: () => inputRef.current?.blur(),
      getCursorPosition: () => (inputRef.current ? getCursorOffset(inputRef.current) : 0),
      insertMention: (mention: FileMention) => {
        if (!inputRef.current) return;

        const activeSelection = window.getSelection();
        const cursorPos =
          activeSelection &&
          activeSelection.rangeCount > 0 &&
          inputRef.current.contains(activeSelection.getRangeAt(0).startContainer)
            ? getCursorOffset(inputRef.current)
            : lastCursorPositionRef.current;
        const currentText = extractText(inputRef.current);
        const tokenRange = findMentionTokenRange(currentText, cursorPos);

        if (tokenRange) {
          const trailingText = currentText.slice(tokenRange.end);
          const separator = trailingText.length > 0 && /^\s/.test(trailingText) ? "" : " ";
          const newText =
            currentText.slice(0, tokenRange.start) +
            `@${mention.filename}${separator}` +
            trailingText;
          const newMentions = [...mentions, mention];

          // Place the caret immediately after the inserted "@filename" plus any
          // separator we added. When `separator` is "" we reused the existing
          // trailing whitespace, so the caret must stop before it.
          pendingCursorRef.current =
            tokenRange.start + 1 + mention.filename.length + separator.length;
          lastCursorPositionRef.current = pendingCursorRef.current;
          pendingFocusRef.current = true;
          focusEditableElement(inputRef.current);
          onChange(newText, newMentions);
        }
      },
      insertMentionAtCursor: (mention: FileMention) => {
        if (!inputRef.current) return;

        // Preserve the last compose-bar caret position while the attachment
        // picker dialog has focus, then add whitespace only where needed.
        const activeSelection = window.getSelection();
        const cursorPos =
          activeSelection &&
          activeSelection.rangeCount > 0 &&
          inputRef.current.contains(activeSelection.getRangeAt(0).startContainer)
            ? getCursorOffset(inputRef.current)
            : lastCursorPositionRef.current;
        const currentText = extractText(inputRef.current);
        const leadingText = currentText.slice(0, cursorPos);
        const trailingText = currentText.slice(cursorPos);
        const leadingSeparator = leadingText.length > 0 && !/\s$/.test(leadingText) ? " " : "";
        const trailingSeparator = trailingText.length > 0 && /^\s/.test(trailingText) ? "" : " ";
        const insertedText = `${leadingSeparator}@${mention.filename}${trailingSeparator}`;
        const newText = leadingText + insertedText + trailingText;
        const newMentions = [...mentions, mention];

        pendingCursorRef.current = cursorPos + insertedText.length;
        lastCursorPositionRef.current = pendingCursorRef.current;
        pendingFocusRef.current = true;
        focusEditableElement(inputRef.current);
        onChange(newText, newMentions);
      },
    }));

    useLayoutEffect(() => {
      const input = inputRef.current;
      if (!input) return;

      // On first render, always sync the DOM with the store value (restores draft text)
      const isFirstRender = !initializedRef.current;
      if (isFirstRender) {
        initializedRef.current = true;
      }

      const hasContentChange =
        isFirstRender ||
        value !== lastValueRef.current ||
        !areMentionsEqual(mentions, lastMentionsRef.current);
      const pendingCursor = pendingCursorRef.current;
      const shouldRestoreFocus = pendingFocusRef.current;

      if (!hasContentChange && pendingCursor === null && !shouldRestoreFocus) {
        return;
      }

      lastValueRef.current = value;
      lastMentionsRef.current = mentions;

      const cursorPos = pendingCursor ?? (isFirstRender ? value.length : getCursorOffset(input));
      lastCursorPositionRef.current = cursorPos;

      // Only rewrite the DOM when the content actually changed; rewriting on a
      // pure focus/cursor restore would needlessly clobber the live selection.
      if (hasContentChange) {
        input.innerHTML = renderContent(value, mentions);
      }
      if (shouldRestoreFocus) {
        focusEditableElement(input);
      }
      setCursorOffset(input, cursorPos);

      pendingCursorRef.current = null;
      pendingFocusRef.current = false;
    }, [value, mentions]);

    const handleInput = useCallback(() => {
      if (!inputRef.current || isComposingRef.current) return;

      const newText = extractText(inputRef.current);
      const remainingMentions = mentions.filter((mention) =>
        newText.includes(`@${mention.filename}`),
      );

      lastValueRef.current = newText;
      lastMentionsRef.current = remainingMentions;
      onChange(newText, remainingMentions);

      if (onCursorChange) {
        const cursorPosition = getCursorOffset(inputRef.current);
        lastCursorPositionRef.current = cursorPosition;
        onCursorChange(cursorPosition, newText);
      }
    }, [mentions, onChange, onCursorChange]);

    const handleCompositionStart = useCallback(() => {
      isComposingRef.current = true;
    }, []);

    const handleCompositionEnd = useCallback(() => {
      isComposingRef.current = false;
      handleInput();
    }, [handleInput]);

    useEffect(() => {
      const handleSelectionChange = () => {
        if (!inputRef.current || !onCursorChange) return;

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        if (!inputRef.current.contains(range.commonAncestorContainer)) return;

        const cursorPosition = getCursorOffset(inputRef.current);
        lastCursorPositionRef.current = cursorPosition;
        onCursorChange(cursorPosition, extractText(inputRef.current));
      };

      document.addEventListener("selectionchange", handleSelectionChange);
      return () => document.removeEventListener("selectionchange", handleSelectionChange);
    }, [onCursorChange]);

    const handlePaste = useCallback(
      (event: ClipboardEvent<HTMLDivElement>) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        range.deleteContents();

        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);

        handleInput();
      },
      [handleInput],
    );

    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Enter" && !event.shiftKey) {
          // Enter confirms an active IME composition. It must remain available
          // to the browser and must not reach provider submit handlers.
          //
          // `isComposing` alone is not enough. WebKit — Safari and the
          // WKWebView the iOS app loads the UI in — fires `compositionend`
          // *before* this keydown, so both `isComposing` and our own
          // `isComposingRef` are already false on the keystroke that is still
          // only confirming the candidate. `keyCode` 229 is the one signal
          // every engine still sets there.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          event.preventDefault();
          onKeyDown?.(event);
          return;
        }

        onKeyDown?.(event);
      },
      [onKeyDown],
    );

    const showPlaceholder = !value;

    return (
      <div className="relative">
        <div
          ref={inputRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={handleInput}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          role="textbox"
          aria-label={placeholder}
          aria-multiline="true"
          aria-placeholder={placeholder}
          aria-disabled={disabled}
          className={cn(
            "native-compose-input w-full resize-none overflow-y-auto border-none bg-transparent px-1 py-1 text-sm text-foreground outline-none transition-colors",
            disabled && "cursor-not-allowed opacity-50",
            className,
          )}
          style={{
            minHeight,
            maxHeight,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
          data-placeholder={placeholder}
        />
        {showPlaceholder && (
          <div
            className="native-compose-placeholder pointer-events-none absolute top-1 left-1 text-sm text-muted-foreground"
            data-native-compose-placeholder
            aria-hidden="true"
          >
            {placeholder}
          </div>
        )}
      </div>
    );
  },
);

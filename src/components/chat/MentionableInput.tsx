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
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const nodeLength = node.textContent?.length || 0;
    if (currentOffset + nodeLength >= offset) {
      const range = document.createRange();
      range.setStart(node, offset - currentOffset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    currentOffset += nodeLength;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
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
  let result = escapeHtml(text);

  for (const pattern of sortedPatterns) {
    const mention = mentionMap.get(pattern);
    if (!mention) continue;
    const escapedPattern = escapeHtml(pattern);
    const mentionHtml = `<span class="text-blue-500 font-medium" data-mention="true" data-id="${mention.id}" data-filename="${escapeAttr(mention.filename)}" data-path="${escapeAttr(mention.relativePath)}" contenteditable="false">${escapedPattern}</span>`;
    result = result.replace(new RegExp(escapeRegExp(escapedPattern), "g"), mentionHtml);
  }

  return result.replace(/\n/g, "<br>");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return text.replace(/"/g, "&quot;");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMentionTokenRange(text: string, cursorPosition: number): { start: number; end: number } | null {
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
  return a.every((mention, index) => mention.id === b[index]?.id);
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
    ref
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
          activeSelection
          && activeSelection.rangeCount > 0
          && inputRef.current.contains(activeSelection.getRangeAt(0).startContainer)
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

          pendingCursorRef.current = tokenRange.start + mention.filename.length + 2;
          lastCursorPositionRef.current = pendingCursorRef.current;
          pendingFocusRef.current = true;
          focusEditableElement(inputRef.current);
          onChange(newText, newMentions);
        }
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

      if (hasContentChange) {
        lastValueRef.current = value;
        lastMentionsRef.current = mentions;

        const cursorPos = pendingCursor ?? (isFirstRender ? value.length : getCursorOffset(input));
        lastCursorPositionRef.current = cursorPos;
        input.innerHTML = renderContent(value, mentions);
        if (shouldRestoreFocus) {
          focusEditableElement(input);
        }
        setCursorOffset(input, cursorPos);
      } else {
        if (shouldRestoreFocus) {
          focusEditableElement(input);
        }
        if (pendingCursor !== null) {
          setCursorOffset(input, pendingCursor);
          lastCursorPositionRef.current = pendingCursor;
        }
      }

      if (pendingCursor !== null) {
        pendingCursorRef.current = null;
      }
      pendingFocusRef.current = false;
    }, [value, mentions]);

    const handleInput = useCallback(() => {
      if (!inputRef.current || isComposingRef.current) return;

      const newText = extractText(inputRef.current);
      const remainingMentions = mentions.filter((mention) =>
        newText.includes(`@${mention.filename}`)
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
      [handleInput]
    );

    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onKeyDown?.(event);
          return;
        }

        onKeyDown?.(event);
      },
      [onKeyDown]
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
          className={cn(
            "w-full resize-none overflow-y-auto border-none bg-transparent px-1 py-1 text-sm text-foreground outline-none transition-colors",
            "[&:empty]:before:pointer-events-none",
            "[&:empty]:before:content-[attr(data-placeholder)]",
            "[&:empty]:before:text-muted-foreground",
            disabled && "cursor-not-allowed opacity-50",
            className
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
            className="pointer-events-none absolute top-1 left-1 text-sm text-muted-foreground"
            aria-hidden="true"
          >
            {placeholder}
          </div>
        )}
      </div>
    );
  }
);

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { keyInformationBlocks } from "./key-information-blocks";

/**
 * A Key information prose section laid out as paragraphs and lists
 * ({@link keyInformationBlocks}). `renderText` draws each run of text, so the
 * panel can highlight code and paths while the tab keeps plain text.
 */
export function KeyInformationProse({
  text,
  className,
  renderText = (value) => value,
}: {
  text: string;
  /** Classes for the wrapper: text size, colour, width. */
  className?: string;
  renderText?: (value: string) => ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {keyInformationBlocks(text).map((block, index) => {
        if (block.kind === "paragraph") {
          return (
            <p key={index} className="break-words whitespace-pre-wrap">
              {renderText(block.text)}
            </p>
          );
        }
        const List = block.ordered ? "ol" : "ul";
        return (
          <List
            key={index}
            className={cn("flex flex-col gap-1 pl-5", block.ordered ? "list-decimal" : "list-disc")}
          >
            {block.items.map((item, itemIndex) => (
              <li
                key={itemIndex}
                value={block.ordered ? block.values[itemIndex] : undefined}
                className="break-words pl-0.5"
              >
                {renderText(item)}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { mailMarkdownComponents } from "./mail-markdown-components";

/** A mail body as Markdown; `AgentMailBody` loads this the first time a thread is read. */
export function AgentMailMarkdown({ body }: { body: string }) {
  return (
    <MessageMarkdown
      content={body}
      components={mailMarkdownComponents}
      className="break-words text-xs prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-pre:my-1 prose-pre:p-2 [&>:first-child]:mt-0 [&>:last-child]:mb-0"
    />
  );
}

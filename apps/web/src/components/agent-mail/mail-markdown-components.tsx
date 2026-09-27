import type { Components } from "react-markdown";
import { MarkdownLink } from "@/components/chat/MessageMarkdown";
import { parseLocalFileLinkTarget } from "@/lib/chat/file-url";

// Mail can come from another environment or an external client. A file path
// cannot use the active environment's file-tab callback, and an image must
// not contact a sender-selected host merely because the reader opens mail.
export const mailMarkdownComponents: Components = {
  a: ({ href, children }) => {
    if (!href) return <span>{children}</span>;
    if (parseLocalFileLinkTarget(href)) {
      return (
        <span title="File path from the sender's workspace; copy it to open in that environment">
          {children} <code>{href}</code>
        </span>
      );
    }
    // react-markdown strips unsafe schemes, and mail only opens absolute web URLs.
    if (!/^https?:\/\//i.test(href)) return <span>{children}</span>;
    try {
      if (!new URL(href).hostname) return <span>{children}</span>;
    } catch {
      return <span>{children}</span>;
    }
    return <MarkdownLink href={href}>{children}</MarkdownLink>;
  },
  img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image omitted]"}</span>,
};

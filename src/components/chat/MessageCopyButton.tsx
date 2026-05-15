import { useCallback, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface MessageCopyButtonProps {
  content: string;
}

export function MessageCopyButton({ content }: MessageCopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timeoutId = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  const handleCopy = useCallback(async () => {
    try {
      await writeText(content);
      setCopied(true);
    } catch (error) {
      console.error("[MessageCopyButton] Failed to copy message text:", error);
      toast.error("Failed to copy message text");
    }
  }, [content]);

  return (
    <div className="mt-1 flex justify-end pr-3">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="h-6 w-6 p-0 text-muted-foreground/70 hover:text-foreground"
        onClick={handleCopy}
        aria-label={copied ? "Copied text" : "Copy text"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

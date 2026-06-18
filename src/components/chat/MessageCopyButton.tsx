import { useCallback, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { writeText } from "@/lib/native/clipboard";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MessageCopyButtonProps {
  content: string;
  wrapperClassName?: string;
  buttonClassName?: string;
}

export function MessageCopyButton({
  content,
  wrapperClassName,
  buttonClassName,
}: MessageCopyButtonProps) {
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
    <div className={cn("mt-1 flex justify-end pr-3", wrapperClassName)}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn("h-6 w-6 p-0 text-muted-foreground/70 hover:text-foreground", buttonClassName)}
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

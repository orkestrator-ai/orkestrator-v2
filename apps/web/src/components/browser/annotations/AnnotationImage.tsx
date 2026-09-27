import { useEffect } from "react";
import { ImageOff, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWebAnnotationCache } from "@/hooks/useWebAnnotations";
import { loadWebAnnotationAsset, retryWebAnnotationAsset } from "@/lib/web-annotations/assets";
import { cn } from "@/lib/utils";

/**
 * A stored capture image, fetched only when shown. Missing and failed images
 * are distinct states: a missing image is gone; a failed one can be retried.
 */
export function AnnotationImage({
  environmentId,
  assetId,
  alt,
  className,
}: {
  environmentId: string;
  assetId: string | null | undefined;
  alt: string;
  className?: string;
}) {
  const cache = useWebAnnotationCache(environmentId);
  const asset = assetId ? cache.assets.get(assetId) : undefined;
  useEffect(() => {
    if (!assetId) return;
    void loadWebAnnotationAsset(environmentId, assetId);
  }, [assetId, environmentId]);

  if (!assetId) {
    return (
      <div
        data-image-state="none"
        className={cn(
          "flex items-center gap-1.5 rounded border border-dashed border-border/70 px-2 py-3 text-[11px] text-muted-foreground",
          className,
        )}
      >
        <ImageOff className="h-3.5 w-3.5" aria-hidden />
        No image was saved with this capture.
      </div>
    );
  }
  if (!asset || asset.status === "loading") {
    return (
      <div
        data-image-state="loading"
        className={cn(
          "flex items-center gap-1.5 px-2 py-3 text-[11px] text-muted-foreground",
          className,
        )}
      >
        <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
        Loading image…
      </div>
    );
  }
  if (asset.status === "missing") {
    return (
      <div
        data-image-state="missing"
        className={cn(
          "flex items-center gap-1.5 rounded border border-dashed border-amber-500/40 px-2 py-3 text-[11px] text-amber-200",
          className,
        )}
      >
        <ImageOff className="h-3.5 w-3.5" aria-hidden />
        Image missing — it is no longer stored. Reselect the target to capture a new one.
      </div>
    );
  }
  if (asset.status === "error" || !asset.url) {
    return (
      <div
        data-image-state="error"
        className={cn(
          "flex items-center gap-2 rounded border border-dashed border-border/70 px-2 py-3 text-[11px] text-muted-foreground",
          className,
        )}
      >
        <span>Image unavailable while disconnected.</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-[11px]"
          onClick={() => void retryWebAnnotationAsset(environmentId, assetId)}
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          Retry image
        </Button>
      </div>
    );
  }
  return (
    <img
      src={asset.url}
      alt={alt}
      data-image-state="ready"
      className={cn("max-h-56 w-full rounded border border-border/60 object-contain", className)}
    />
  );
}

import { RefreshCw } from "lucide-react";
import { Banner, Button } from "@astryxdesign/core";

export function ErrorState({ title = "Something went wrong", message, onRetry, retryLabel = "Try again" }: { title?: string; message: string; onRetry?: () => void; retryLabel?: string }) {
  return <Banner
    status="error"
    container="section"
    title={<h2 className="type-title text-foreground">{title}</h2>}
    description={<p className="text-sm text-secondary">{message}</p>}
    endContent={onRetry ? <Button label={retryLabel} variant="secondary" icon={<RefreshCw className="size-4" />} onClick={onRetry} /> : undefined}
  />;
}

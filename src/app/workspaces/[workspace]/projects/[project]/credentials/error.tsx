"use client";
import { PageState } from "../../../../../../components/layout/PageState";
import { ErrorState } from "../../../../../../components/ui/error-state";
export default function Error({ reset }: { error: Error; reset: () => void }) { return <PageState state="error"><ErrorState title="Credentials unavailable" message="The credentials page could not be loaded." onRetry={reset} /></PageState>; }

"use client";

import { PageState } from "../../../components/layout/PageState";
import { Button } from "@astryxdesign/core";

export default function WorkspaceError({ reset }: { error: Error; reset: () => void }) { return <PageState><div className="space-y-3"><h1 className="type-title">Workspace unavailable</h1><p className="text-sm text-secondary">The workspace could not be opened.</p><Button label="Try again" variant="secondary" onClick={reset} /></div></PageState>; }

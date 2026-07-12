"use client";

import { Button } from "../../../../../../components/ui/button";

export default function FilesError({ reset }: { reset: () => void }) {
  return <div className="grid min-h-64 place-items-center px-6 text-center"><div><h1 className="type-section-heading">Files unavailable</h1><p className="mt-2 text-sm text-secondary">The project file browser could not be opened.</p><Button className="mt-4" onClick={reset}>Try again</Button></div></div>;
}

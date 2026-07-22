"use client";

import { Button } from "@astryxdesign/core";

export default function FilesError({ reset }: { reset: () => void }) {
  return <div className="grid min-h-64 place-items-center px-6 text-center"><div><h1 className="type-section-heading">Files unavailable</h1><p className="mt-2 text-sm text-secondary">File Libraries could not be opened.</p><Button className="mt-4" label="Try again" variant="secondary" onClick={reset} /></div></div>;
}

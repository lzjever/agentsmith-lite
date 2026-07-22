"use client";
import { PageState } from "../../../../../../components/layout/PageState";
import { Button } from "@astryxdesign/core";
export default function MembersError({ reset }: { reset: () => void }) { return <PageState><div className="space-y-3"><h2 className="type-title">Members unavailable</h2><Button label="Try again" variant="secondary" onClick={reset} /></div></PageState>; }

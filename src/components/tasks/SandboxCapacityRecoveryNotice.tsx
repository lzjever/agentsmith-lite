"use client";

import Link from "next/link";
import { Banner, Text } from "@astryxdesign/core";
import {
  sandboxCapacityRecoveryActions,
  type SandboxCapacityRecovery
} from "./sandbox-capacity-recovery";

export function SandboxCapacityRecoveryNotice({
  recovery,
  activeSandboxesHref,
  canManagePolicy,
  policyHref,
  title = recovery.title,
  className
}: {
  recovery: SandboxCapacityRecovery;
  activeSandboxesHref: string;
  canManagePolicy: boolean;
  policyHref: string;
  title?: string;
  className?: string;
}) {
  const actions = sandboxCapacityRecoveryActions(recovery, canManagePolicy);
  return <Banner
    {...(className ? { className } : {})}
    status="error"
    title={title}
    description={<>
      {recovery.guidance}{" "}
      {actions.showActiveSandboxes ? <><Link className="text-primary hover:underline" href={activeSandboxesHref}><Text weight="medium">View active sandboxes</Text></Link>.</> : null}
      {actions.showPolicy ? <> <Link className="text-primary hover:underline" href={policyHref}><Text weight="medium">Open Policy</Text></Link>.</> : null}
    </>}
  />;
}

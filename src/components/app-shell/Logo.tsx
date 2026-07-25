import Link from "next/link";
import { Text } from "@astryxdesign/core";

const appBasePath = (process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api/v1").replace(/\/api\/v1\/?$/, "");
const agentSmithMark = `${appBasePath}/brand/agentsmith-mark.svg`;

export function Logo({ compactOnMobile = false, linked = true, className = "" }: { compactOnMobile?: boolean; linked?: boolean; className?: string }) {
  const content = <><img src={agentSmithMark} alt="" width={32} height={32} className="size-8 shrink-0" /><span className={compactOnMobile ? "hidden sm:inline" : undefined}><Text type="large" weight="semibold">AgentSmith</Text></span></>;
  const classes = `flex items-center gap-2.5 text-primary no-underline ${className}`;
  return linked ? <Link href="/" className={classes}>{content}</Link> : <div className={classes}>{content}</div>;
}

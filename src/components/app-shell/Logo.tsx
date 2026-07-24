import { Sparkles } from "lucide-react";
import Link from "next/link";
import { Text } from "@astryxdesign/core";

export function Logo({ compactOnMobile = false }: { compactOnMobile?: boolean }) {
  return <Link href="/" className="flex items-center gap-2.5 text-primary no-underline"><span className="grid size-8 place-items-center rounded-md shadow-sm" style={{ backgroundColor: "var(--color-data-categorical-orange)", color: "var(--color-on-light)" }}><Sparkles size={16} /></span><span className={compactOnMobile ? "hidden sm:inline" : undefined}><Text type="large" weight="semibold">AgentSmith</Text></span></Link>;
}

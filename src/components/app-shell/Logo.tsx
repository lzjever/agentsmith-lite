import { Sparkles } from "lucide-react";
import Link from "next/link";

export function Logo() {
  return <Link href="/" className="flex items-center gap-2 text-foreground no-underline"><span className="grid size-8 place-items-center rounded-md border border-border bg-surface text-accent"><Sparkles size={16} /></span><span className="font-display text-lg">AgentSmith</span></Link>;
}

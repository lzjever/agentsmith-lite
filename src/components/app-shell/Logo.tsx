import { Sparkles } from "lucide-react";
import Link from "next/link";

export function Logo() {
  return <Link href="/" className="flex items-center gap-2.5 text-foreground no-underline"><span className="grid size-8 place-items-center rounded-md bg-foreground text-background shadow-ambient"><Sparkles size={16} className="text-accent" /></span><span className="font-display text-[17px]">AgentSmith</span></Link>;
}

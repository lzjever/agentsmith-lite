import type { ReactNode } from "react";
import { Heading, Text } from "@astryxdesign/core";
import { DocumentTitle } from "./DocumentTitle";

type PageHeaderProps = {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
  variant?: "default" | "compact";
};

export function PageHeader({ title, subtitle, actions, className, variant = "default" }: PageHeaderProps) {
  const compact = variant === "compact";
  return <><DocumentTitle title={title} /><div className={["flex flex-col border-b border-border", compact ? "gap-2.5 pb-4" : "gap-4 pb-6", "md:flex-row md:items-start md:justify-between", className].filter(Boolean).join(" ")}>
    <div className={compact ? "space-y-1" : "space-y-2"}>
      <Heading level={1} {...(compact ? { style: { fontSize: "var(--text-heading-2-size)", lineHeight: "var(--text-heading-2-leading)" } } : { type: "display-3" as const })}>{title}</Heading>
      {subtitle ? <Text as="p" display="block" color="secondary" className="max-w-3xl">{subtitle}</Text> : null}
    </div>
    {actions ? <div className="flex flex-wrap items-center gap-2 md:justify-end">{actions}</div> : null}
  </div></>;
}

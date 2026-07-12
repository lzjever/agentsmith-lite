import type { ReactNode } from "react";

export type PageLayoutProps = {
  header?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  density?: "default" | "immersive";
  contentWidth?: "full" | "wide" | "narrow";
};

export function PageLayout({ header, toolbar, children, footer, density = "default", contentWidth = "wide" }: PageLayoutProps) {
  const immersive = density === "immersive";
  const chrome = immersive
    ? "gap-[var(--layout-gap-immersive)] px-[var(--layout-padding-immersive)] py-[var(--layout-padding-immersive)]"
    : "gap-[var(--layout-gap)] px-[var(--layout-padding)] py-5 md:px-6 md:py-6";
  const width = contentWidth === "full" ? "w-full" : contentWidth === "narrow" ? "mx-auto w-full max-w-5xl" : "mx-auto w-full max-w-[1680px]";

  return <div data-testid="page-layout" className="flex h-full min-h-0 flex-col">
    <div className={`flex min-h-0 flex-1 flex-col ${chrome}`}>
      {header ? <div data-testid="page-layout__header"><div className={width}>{header}</div></div> : null}
      {toolbar ? <div data-testid="page-layout__toolbar"><div className={width}>{toolbar}</div></div> : null}
      <div data-testid="page-layout__body" className={`flex min-h-0 flex-1 flex-col ${immersive ? "gap-[var(--layout-gap-immersive)]" : "gap-[var(--layout-gap)]"}`}>
        <div className={`${width} flex min-h-0 flex-1 flex-col`}>{children}</div>
      </div>
    </div>
    {footer ? <div data-testid="page-layout__footer" className={immersive ? "px-[var(--layout-padding-immersive)] pb-[var(--layout-padding-immersive)]" : "px-[var(--layout-padding)] pb-[var(--layout-padding)]"}>{footer}</div> : null}
  </div>;
}

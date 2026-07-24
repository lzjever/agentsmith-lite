import { Layout, LayoutContent, LayoutFooter, LayoutHeader } from "@astryxdesign/core";
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
  const contentWidthProps = contentWidth === "full"
    ? {}
    : { contentWidth: contentWidth === "narrow" ? "64rem" : "1480px" };
  const gutters = immersive
    ? "px-2"
    : "px-5 md:px-8";
  const topPadding = immersive
    ? "pt-2"
    : "pt-5 md:pt-7";
  const bottomPadding = immersive
    ? "pb-2"
    : "pb-5 md:pb-7";
  const gap = immersive ? "gap-2" : "gap-5";
  const bodyTopPadding = header || toolbar
    ? immersive ? "pt-2" : "pt-5"
    : topPadding;

  return (
    <Layout
      data-testid="page-layout"
      height="auto"
      padding={0}
      {...contentWidthProps}
      header={header || toolbar ? (
        <LayoutHeader padding={0}>
          <div className={`flex flex-col ${gutters} ${topPadding} ${gap}`}>
            {header ? <div data-testid="page-layout__header">{header}</div> : null}
            {toolbar ? <div data-testid="page-layout__toolbar">{toolbar}</div> : null}
          </div>
        </LayoutHeader>
      ) : null}
      content={
        <LayoutContent
          data-testid="page-layout__body"
          padding={0}
          isScrollable={false}
          className={`${gutters} ${bodyTopPadding} ${bottomPadding}`}
        >
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </LayoutContent>
      }
      footer={footer ? (
        <LayoutFooter data-testid="page-layout__footer" padding={0}>
          <div className={`${gutters} ${bottomPadding}`}>{footer}</div>
        </LayoutFooter>
      ) : null}
    />
  );
}

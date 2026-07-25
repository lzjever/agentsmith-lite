import { Layout, LayoutContent, LayoutFooter, LayoutHeader } from "@astryxdesign/core";
import type { ReactNode } from "react";

export type PageLayoutProps = {
  header?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  density?: "default" | "immersive";
  contentWidth?: "full" | "wide" | "narrow";
  height?: "auto" | "fill";
};

export function PageLayout({ header, toolbar, children, footer, density = "default", contentWidth = "wide", height = "auto" }: PageLayoutProps) {
  const immersive = density === "immersive";
  const fill = height === "fill";
  const contentWidthProps = contentWidth === "full"
    ? {}
    : { contentWidth: contentWidth === "narrow" ? "64rem" : "1480px" };
  const gutters = "px-3 sm:px-5 lg:px-6";
  const topPadding = immersive
    ? "pt-2"
    : "pt-4 sm:pt-5 lg:pt-6";
  const bottomPadding = immersive
    ? "pb-2"
    : "pb-4 sm:pb-5 lg:pb-6";
  const gap = immersive ? "gap-2" : "gap-4";
  const bodyTopPadding = header || toolbar
    ? immersive ? "pt-2" : "pt-4 sm:pt-5"
    : topPadding;

  return (
    <Layout
      data-testid="page-layout"
      height={height}
      padding={0}
      className={fill ? "min-h-0" : undefined}
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
          className={`${gutters} ${bodyTopPadding} ${bottomPadding} ${fill ? "min-h-0 overflow-hidden" : ""}`}
        >
          <div className={`flex min-h-0 flex-1 flex-col ${fill ? "h-full overflow-hidden" : ""}`}>{children}</div>
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

import type { ReactNode } from "react";

export type PageStateKind = "loading" | "empty" | "error" | "success";

export function PageState({ state, children, loading, empty, error }: { state?: PageStateKind; children?: ReactNode; loading?: ReactNode; empty?: ReactNode; error?: ReactNode }) {
  const resolved = state ?? "success";
  if (resolved === "success") return <div data-testid="page-state__success" className="h-full">{children}</div>;
  const content = resolved === "loading" ? (loading ?? children) : resolved === "empty" ? (empty ?? children) : (error ?? children);
  return <div data-testid={`page-state__${resolved}`} className="flex min-h-48 items-center justify-center px-4 py-6 text-center">{content}</div>;
}

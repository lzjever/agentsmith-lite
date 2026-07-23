"use client";

import { useEffect } from "react";

export function DocumentTitle({ title }: { title?: string }) {
  useEffect(() => {
    const resolvedTitle = title?.trim();
    document.title = resolvedTitle ? `${resolvedTitle} | AgentSmith` : "AgentSmith";
  }, [title]);

  return null;
}

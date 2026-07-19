import type { Project } from "./api/client";

export function orderProjectsForDisplay(projects: readonly Project[]): Project[] {
  return [...projects].sort(
    (left, right) =>
      Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt))
      || left.name.localeCompare(right.name),
  );
}

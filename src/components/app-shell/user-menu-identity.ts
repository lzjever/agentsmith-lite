import type { CurrentUser } from "../../lib/api/client.js";

export function userMenuIdentity(user: CurrentUser): { primary: string; secondary: string; initials: string } {
  const displayName = user.displayName?.trim();
  const primary = displayName || user.email;
  return {
    primary,
    secondary: displayName ? user.email : "Signed in",
    initials: primary.split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("")
  };
}

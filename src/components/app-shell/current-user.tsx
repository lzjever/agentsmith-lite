"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { CurrentUser } from "../../lib/api/client";

const CurrentUserContext = createContext<CurrentUser | undefined>(undefined);

export function CurrentUserProvider({
  user,
  children
}: {
  user: CurrentUser;
  children: ReactNode;
}) {
  return <CurrentUserContext value={user}>{children}</CurrentUserContext>;
}

export function useCurrentUser(): CurrentUser {
  const user = useContext(CurrentUserContext);
  if (!user) throw new Error("Current user is unavailable");
  return user;
}

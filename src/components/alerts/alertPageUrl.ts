import type { AlertPageView } from "./alertPageState.js";

export interface AlertPageRoute {
  view: AlertPageView;
  linkedAlertId: string | null;
}

export interface AlertPageNavigation {
  kind: "push" | "replace";
  href: string;
}

export function parseAlertPageRoute(
  input: string | URLSearchParams
): AlertPageRoute {
  const params =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;
  return {
    view: parseAlertPageView(params.get("view")),
    linkedAlertId: params.get("alertId") || null
  };
}

export function tabAlertPageNavigation(
  currentHref: string,
  view: AlertPageView
): AlertPageNavigation {
  return navigation(currentHref, { view, linkedAlertId: null }, "push");
}

export function canonicalAlertPageNavigation(
  currentHref: string,
  route: AlertPageRoute
): AlertPageNavigation {
  return navigation(currentHref, route, "replace");
}

function navigation(
  currentHref: string,
  route: AlertPageRoute,
  kind: AlertPageNavigation["kind"]
): AlertPageNavigation {
  const url = new URL(currentHref);
  url.searchParams.set("view", route.view);
  if (route.linkedAlertId) {
    url.searchParams.set("alertId", route.linkedAlertId);
  } else {
    url.searchParams.delete("alertId");
  }
  return {
    kind,
    href: `${url.pathname}${url.search}${url.hash}`
  };
}

function parseAlertPageView(value: string | null): AlertPageView {
  return value === "history" || value === "rules" ? value : "active";
}

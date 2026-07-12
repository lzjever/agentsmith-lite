"use client";
import { SettingsRouteError } from "../../../../components/settings/SettingsRouteState";
export default function Error({ reset }: { error: Error; reset: () => void }) { return <SettingsRouteError reset={reset} />; }

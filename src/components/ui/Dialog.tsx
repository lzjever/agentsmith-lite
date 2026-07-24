"use client";

import {
  AlertDialog as AstryxAlertDialog,
  Dialog as AstryxDialog,
  type AlertDialogProps,
  type DialogProps,
} from "@astryxdesign/core";
import type { KeyboardEvent } from "react";

export type {
  AlertDialogProps,
  DialogPosition,
  DialogProps,
  DialogPurpose,
  DialogVariant,
  DialogVariantMap,
} from "@astryxdesign/core";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled]), [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls], iframe, details > summary:first-child';

function handleDialogTabBoundary(
  event: KeyboardEvent<HTMLDialogElement>,
): void {
  if (event.key !== "Tab") {
    return;
  }

  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      !element.closest("[hidden], [inert]") &&
      !element.matches(":disabled") &&
      element.getClientRects().length > 0 &&
      window.getComputedStyle(element).visibility !== "hidden",
  );
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

export function Dialog({
  ref,
  isOpen,
  isInline = false,
  onKeyDown,
  ...props
}: DialogProps) {
  return (
    <AstryxDialog
      {...props}
      {...(ref !== undefined ? { ref } : {})}
      isOpen={isOpen}
      isInline={isInline}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!isInline && !event.defaultPrevented) {
          handleDialogTabBoundary(event);
        }
      }}
    />
  );
}

export function AlertDialog({
  ref,
  isOpen,
  isInline = false,
  onKeyDown,
  ...props
}: AlertDialogProps) {
  return (
    <AstryxAlertDialog
      {...props}
      {...(ref !== undefined ? { ref } : {})}
      isOpen={isOpen}
      isInline={isInline}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!isInline && !event.defaultPrevented) {
          handleDialogTabBoundary(event);
        }
      }}
    />
  );
}

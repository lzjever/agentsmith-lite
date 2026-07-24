"use client";

import {
  Button,
  Dialog as AstryxDialog,
  Heading,
  Layout,
  LayoutContent,
  LayoutFooter,
  Text,
  useTranslator,
  type AlertDialogProps,
  type DialogProps,
} from "@astryxdesign/core";
import {
  useId,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react";

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

export interface DialogFooterProps
  extends Omit<ComponentProps<typeof LayoutFooter>, "children"> {
  secondaryAction?: ReactNode;
  primaryAction: ReactNode;
}

export function DialogFooter({
  secondaryAction,
  primaryAction,
  ...props
}: DialogFooterProps) {
  return (
    <LayoutFooter {...props}>
      <div className="flex flex-col items-end gap-2 sm:flex-row sm:flex-nowrap sm:items-center sm:justify-end">
        {secondaryAction}
        {primaryAction}
      </div>
    </LayoutFooter>
  );
}

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
  onOpenChange,
  title,
  description,
  cancelLabel: cancelLabelFromProps,
  actionLabel,
  actionVariant = "destructive",
  isActionLoading,
  onAction,
  width = 400,
  ...props
}: AlertDialogProps) {
  const translate = useTranslator();
  const cancelLabel =
    cancelLabelFromProps ?? translate("@astryx.alertDialog.cancel");
  const titleId = useId();
  const descriptionId = useId();

  return (
    <Dialog
      {...props}
      {...(ref !== undefined ? { ref } : {})}
      isOpen={isOpen}
      isInline={isInline}
      onOpenChange={onOpenChange}
      width={width}
      purpose="form"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <Layout
        content={
          <LayoutContent>
            <Heading level={2} id={titleId}>
              {title}
            </Heading>
            <Text type="body" color="secondary" id={descriptionId}>
              {description}
            </Text>
          </LayoutContent>
        }
        footer={
          <DialogFooter
            secondaryAction={
              <Button
                data-autofocus
                variant="ghost"
                label={cancelLabel}
                onClick={() => onOpenChange(false)}
              />
            }
            primaryAction={
              <Button
                variant={actionVariant}
                label={actionLabel}
                onClick={onAction}
                {...(isActionLoading !== undefined
                  ? { isLoading: isActionLoading }
                  : {})}
              />
            }
          />
        }
      />
    </Dialog>
  );
}

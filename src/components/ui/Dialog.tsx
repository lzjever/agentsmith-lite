"use client";

import {
  Button,
  Dialog as AstryxDialog,
  Heading,
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  Text,
  useTranslator,
  type ButtonVariant,
} from "@astryxdesign/core";
import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";

type DialogSize = "sm" | "md" | "lg";
type DialogMode = "form" | "info";

const dialogWidths: Record<DialogSize, string> = {
  sm: "min(32rem, calc(100dvw - 1rem))",
  md: "min(34rem, calc(100dvw - 1rem))",
  lg: "min(42rem, calc(100dvw - 1rem))",
};

interface DialogShellProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => unknown;
  title: string;
  subtitle?: string;
  children?: ReactNode;
  size?: DialogSize;
  mode: DialogMode | "confirmation";
  busy?: boolean;
  headerStart?: ReactNode;
  primaryAction?: ReactNode;
  cancelLabel?: string;
  contentPadding?: 0;
  confirmationDescription?: ReactNode;
  confirmationAction?: {
    label: string;
    variant: ButtonVariant;
    disabled: boolean;
    form?: string;
    onAction?: () => unknown;
  };
}

function DialogShell({
  isOpen,
  onOpenChange,
  title,
  subtitle,
  children,
  size = "md",
  mode,
  busy = false,
  headerStart,
  primaryAction,
  cancelLabel,
  contentPadding,
  confirmationDescription,
  confirmationAction,
}: DialogShellProps) {
  const translate = useTranslator();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const subtitleId = useId();
  const contentId = useId();
  const isConfirmation = mode === "confirmation";
  const hasFooter = isConfirmation || primaryAction !== undefined;

  const requestOpenChange = useCallback(
    (next: boolean) => {
      if (next || !busy) {
        onOpenChange(next);
      }
    },
    [busy, onOpenChange],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog?.open) {
        return;
      }

      const target = isConfirmation
        ? dialog.querySelector<HTMLElement>("[data-dialog-cancel]")
        : mode === "form"
          ? dialog.querySelector<HTMLElement>("[data-autofocus]")
          : null;
      (target ?? titleRef.current)?.focus({ preventScroll: true });
    });

    return () => cancelAnimationFrame(frame);
  }, [isConfirmation, isOpen, mode]);

  return (
    <AstryxDialog
      ref={dialogRef}
      isOpen={isOpen}
      onOpenChange={requestOpenChange}
      purpose={mode === "info" ? "info" : "form"}
      role={isConfirmation ? "alertdialog" : "dialog"}
      aria-labelledby={titleId}
      aria-describedby={
        isConfirmation ? contentId : subtitle ? subtitleId : undefined
      }
      width={dialogWidths[size]}
      maxHeight="calc(100dvh - 1rem)"
    >
      <Layout
        height="fill"
        defaultHasDividers
        header={
          <LayoutHeader hasDivider>
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                {headerStart}
                <div className="min-w-0 flex-1">
                  <Heading
                    ref={titleRef}
                    id={titleId}
                    level={2}
                    tabIndex={-1}
                    className="outline-none"
                  >
                    {title}
                  </Heading>
                  {subtitle ? (
                    <Text
                      id={subtitleId}
                      as="p"
                      type="body"
                      size="sm"
                      color="secondary"
                    >
                      {subtitle}
                    </Text>
                  ) : null}
                </div>
              </div>
              {!hasFooter && !busy ? (
                <Button
                  label={translate("@astryx.dialog.close")}
                  tooltip={translate("@astryx.dialog.close")}
                  icon={<X size={18} />}
                  variant="ghost"
                  isIconOnly
                  onClick={() => requestOpenChange(false)}
                />
              ) : null}
            </div>
          </LayoutHeader>
        }
        content={
          <LayoutContent {...(contentPadding === 0 ? { padding: 0 } : {})}>
            {isConfirmation ? (
              <div className="grid gap-4">
                <div id={contentId}>{confirmationDescription}</div>
                {children}
              </div>
            ) : (
              children
            )}
          </LayoutContent>
        }
        footer={
          hasFooter ? (
            <LayoutFooter hasDivider>
              <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:justify-end [&>*]:w-full sm:[&>*]:w-auto">
                <Button
                  data-dialog-cancel=""
                  {...(isConfirmation ? { "data-autofocus": "" } : {})}
                  label={
                    cancelLabel ?? translate("@astryx.alertDialog.cancel")
                  }
                  type="button"
                  variant="ghost"
                  size="lg"
                  isDisabled={busy}
                  onClick={() => requestOpenChange(false)}
                />
                {isConfirmation && confirmationAction ? (
                  <Button
                    label={confirmationAction.label}
                    type={confirmationAction.form ? "submit" : "button"}
                    {...(confirmationAction.form
                      ? { form: confirmationAction.form }
                      : {})}
                    variant={confirmationAction.variant}
                    size="lg"
                    isDisabled={confirmationAction.disabled || busy}
                    isLoading={busy}
                    {...(confirmationAction.onAction
                      ? { onClick: confirmationAction.onAction }
                      : {})}
                  />
                ) : (
                  primaryAction
                )}
              </div>
            </LayoutFooter>
          ) : undefined
        }
      />
    </AstryxDialog>
  );
}

export interface DialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => unknown;
  title: string;
  subtitle?: string;
  children: ReactNode;
  mode?: DialogMode;
  size?: DialogSize;
  busy?: boolean;
  headerStart?: ReactNode;
  primaryAction?: ReactNode;
  cancelLabel?: string;
  contentPadding?: 0;
}

export function Dialog({
  mode = "form",
  ...props
}: DialogProps) {
  return <DialogShell {...props} mode={mode} />;
}

export interface ConfirmationDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => unknown;
  title: string;
  description: ReactNode;
  children?: ReactNode;
  actionLabel: string;
  onAction?: () => unknown;
  actionVariant?: ButtonVariant;
  actionForm?: string;
  isActionDisabled?: boolean;
  busy?: boolean;
  cancelLabel?: string;
}

export function ConfirmationDialog({
  actionLabel,
  description,
  onAction,
  actionVariant = "destructive",
  actionForm,
  isActionDisabled = false,
  busy = false,
  ...props
}: ConfirmationDialogProps) {
  return (
    <DialogShell
      {...props}
      mode="confirmation"
      size="sm"
      busy={busy}
      confirmationDescription={description}
      confirmationAction={{
        label: actionLabel,
        variant: actionVariant,
        disabled: isActionDisabled,
        ...(actionForm ? { form: actionForm } : {}),
        ...(onAction ? { onAction } : {}),
      }}
    />
  );
}

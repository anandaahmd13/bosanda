"use client";

/**
 * The confirmation step for every destructive or money-affecting action.
 *
 * Requirements it exists to satisfy:
 *  - names the exact target, so an operator cannot disable the wrong account;
 *  - captures a REQUIRED reason, written to the audit log (§12);
 *  - submits as a POST with a CSRF token — never a GET (§12/§16);
 *  - states the blast radius in plain language for kill switches (§3).
 *
 * Accessibility: built on native <dialog> + showModal(), which provides the
 * focus trap, Esc-to-close, and background inertness. Focus is restored to the
 * invoking button explicitly because Safari does not do it reliably. The reason
 * field receives initial focus, since that is the field the operator must fill.
 *
 * No inline event handlers are emitted into HTML — all handlers are attached by
 * React, so the strict CSP in the nginx vhost needs no 'unsafe-inline'.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { CSRF_FIELD } from "../lib/csrf-field";

function SubmitButton({ label, tone }: { label: string; tone: "danger" | "primary" }) {
  // useFormStatus must be read from a child of the <form>, hence the split.
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={`btn ${tone === "danger" ? "btn-danger" : "btn-primary"}`}
      disabled={pending}
    >
      {pending ? "Working…" : label}
    </button>
  );
}

export function ConfirmDialog({
  triggerLabel,
  triggerClassName = "btn btn-sm btn-danger",
  triggerDisabled = false,
  title,
  /** What will happen, in plain language. Shown above the target. */
  description,
  /** The exact thing being acted on, rendered verbatim and monospaced. */
  targetLabel,
  /** Extra warning, e.g. a kill switch's blast radius. */
  blastRadius,
  confirmLabel,
  confirmTone = "danger",
  action,
  csrfToken,
  /** Hidden inputs identifying the target, e.g. accountId. */
  hiddenFields,
  /** Optional extra controls, e.g. an amount input for a quota adjustment. */
  children,
  reasonLabel = "Reason (recorded in the audit log)",
  reasonPlaceholder = "Why is this change being made?",
}: {
  triggerLabel: string;
  triggerClassName?: string;
  triggerDisabled?: boolean;
  title: string;
  description: string;
  targetLabel: string;
  blastRadius?: string;
  confirmLabel: string;
  confirmTone?: "danger" | "primary";
  action: (formData: FormData) => void | Promise<void>;
  csrfToken: string;
  hiddenFields?: Record<string, string>;
  children?: ReactNode;
  reasonLabel?: string;
  reasonPlaceholder?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Focus the field the operator must complete, not the confirm button —
      // that also prevents an accidental Enter from confirming immediately.
      reasonRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Esc and backdrop dismissal fire `close` without going through setOpen.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const handleClose = (): void => {
      setOpen(false);
      triggerRef.current?.focus();
    };
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, []);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={triggerClassName}
        disabled={triggerDisabled}
        onClick={() => setOpen(true)}
      >
        {triggerLabel}
      </button>

      <dialog ref={dialogRef} className="modal" aria-labelledby={titleId} aria-describedby={descId}>
        <div className="modal-inner">
          <h2 className="modal-title" id={titleId}>
            {title}
          </h2>
          <p className="banner-body" id={descId}>
            {description}
          </p>

          <div className="modal-target">{targetLabel}</div>

          {blastRadius !== undefined && (
            <div className="banner banner-danger banner-strong" role="note">
              <span className="banner-icon" aria-hidden="true">
                !
              </span>
              <div>
                <div className="banner-title">Blast radius</div>
                <p className="banner-body">{blastRadius}</p>
              </div>
            </div>
          )}

          {/*
            A Server Action posts with a framework-generated endpoint; method is
            implicitly POST. The CSRF token is submitted as a form field and
            compared against the HttpOnly cookie server-side.
          */}
          <form action={action}>
            <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
            {Object.entries(hiddenFields ?? {}).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}

            {children}

            <div className="field" style={{ marginTop: 14 }}>
              <label className="field-label" htmlFor={`${titleId}-reason`}>
                {reasonLabel}
              </label>
              <textarea
                ref={reasonRef}
                id={`${titleId}-reason`}
                name="reason"
                className="textarea"
                required
                minLength={4}
                maxLength={500}
                placeholder={reasonPlaceholder}
              />
              <span className="field-hint">
                Required. Stored with your username and a UTC timestamp.
              </span>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <SubmitButton label={confirmLabel} tone={confirmTone} />
            </div>
          </form>
        </div>
      </dialog>
    </>
  );
}

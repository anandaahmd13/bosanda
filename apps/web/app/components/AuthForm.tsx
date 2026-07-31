"use client";

/**
 * Sign-in and sign-up form.
 *
 * A client component because it needs `useActionState` for pending state and
 * inline error display. It holds no secret: the password lives in the form for
 * exactly as long as the submit takes, and the session that comes back is set as
 * an HttpOnly cookie by the action — never returned into this tree.
 *
 * The error is rendered in a `role="alert"` region so a screen reader announces
 * a failed attempt without the user having to go looking for it.
 */

import Link from "next/link";
import { useActionState } from "react";
import { CSRF_FIELD } from "../lib/csrf-field";
import type { FormState } from "../lib/actions";

const INITIAL: FormState = { error: null };

export function AuthForm({
  mode,
  action,
  csrfToken,
  next,
}: {
  mode: "login" | "register";
  action: (previous: FormState, form: FormData) => Promise<FormState>;
  /** Null when middleware did not run; the form renders disabled rather than
      posting something the server will reject. */
  csrfToken: string | null;
  next?: string;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const isRegister = mode === "register";

  return (
    <form action={formAction} noValidate>
      {csrfToken !== null ? <input type="hidden" name={CSRF_FIELD} value={csrfToken} /> : null}
      {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}

      {/* aria-live so the message is announced on a failed submit, and the
          region exists in the DOM beforehand so the announcement fires. */}
      <div aria-live="polite">
        {state.error !== null ? (
          <div className="alert alert--danger" role="alert">
            <div className="alert__body">{state.error}</div>
          </div>
        ) : null}
      </div>

      {csrfToken === null ? (
        <div className="alert alert--warning" role="alert">
          <div className="alert__body">
            This form could not be initialised securely. Reload the page to continue.
          </div>
        </div>
      ) : null}

      <label className="field">
        <span className="field__label">Username</span>
        <input
          className="input"
          name="username"
          type="text"
          autoComplete="username"
          required
          minLength={3}
          maxLength={32}
          // No autofocus: it steals the caret from a screen-reader user reading
          // the page heading.
          spellCheck={false}
          autoCapitalize="none"
        />
        {isRegister ? (
          <span className="field__hint">
            3–32 characters. Letters, numbers, dot, dash, and underscore.
          </span>
        ) : null}
      </label>

      <label className="field">
        <span className="field__label">Password</span>
        <input
          className="input"
          name="password"
          type="password"
          autoComplete={isRegister ? "new-password" : "current-password"}
          required
          minLength={isRegister ? 12 : 1}
          maxLength={200}
        />
        {isRegister ? (
          <span className="field__hint">
            At least 12 characters. Length matters more than symbols — a passphrase is fine.
          </span>
        ) : null}
      </label>

      {isRegister ? (
        <label className="field">
          <span className="field__label">Confirm password</span>
          <input
            className="input"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={200}
          />
        </label>
      ) : null}

      <button className="btn btn--primary" type="submit" disabled={pending || csrfToken === null}>
        {pending ? "Working…" : isRegister ? "Create account" : "Sign in"}
      </button>

      <p className="muted" style={{ marginBottom: 0 }}>
        {isRegister ? (
          <>
            Already have an account? <Link href="/login">Sign in</Link>.
          </>
        ) : (
          <>
            No account yet? <Link href="/register">Create one</Link>.
          </>
        )}
      </p>
    </form>
  );
}

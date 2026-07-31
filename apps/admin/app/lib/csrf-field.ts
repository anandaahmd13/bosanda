/**
 * The CSRF form-field name, isolated in its own module.
 *
 * WHY THIS FILE EXISTS: `session.ts` imports `next/headers`, which makes it
 * server-only. Client components (ConfirmDialog, the flag toggles) need the
 * field NAME but must never pull in session code. Sharing a bare string
 * constant here keeps the server/client boundary clean and keeps the name
 * defined exactly once.
 *
 * This is the field name only — never a token value.
 */

export const CSRF_FIELD = "csrf_token";

/**
 * The CSRF form-field name, isolated in its own module.
 *
 * WHY THIS FILE EXISTS: `session.ts` imports `next/headers` and `env.ts` reads
 * server-only `process.env` values. Client components need the field NAME but
 * must pull in neither. Sharing a bare string constant here keeps the
 * server/client boundary clean and keeps the name defined exactly once.
 *
 * This is the field name only — never a token value. (`env.ts` re-exports the
 * same constant from here so server code has one import site.)
 */

export const CSRF_FIELD = "csrf_token";

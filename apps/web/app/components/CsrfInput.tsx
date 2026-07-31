import { CSRF_FIELD } from "../lib/csrf-field";

/**
 * The hidden CSRF field every mutating form must include (§12).
 *
 * A server component, so the token is read from the cookie jar and rendered
 * into HTML — it is never fetched by client JS.
 *
 * `token` is passed in rather than read here so a page that needs to know
 * whether middleware ran (and therefore whether to disable its submit button)
 * reads it once and makes that decision itself.
 */
export function CsrfInput({ token }: { token: string }) {
  return <input type="hidden" name={CSRF_FIELD} value={token} />;
}

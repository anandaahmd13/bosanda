/**
 * aria-live region for the result of an async mutation.
 *
 * Server Actions redirect back to the page with `?status=` / `?error=`, and this
 * announces the outcome. `role="status"` (polite) for success, `role="alert"`
 * (assertive) for failure — a failed refund must interrupt, a successful stock
 * change should not.
 *
 * The container is always rendered, even when empty: a live region injected into
 * the DOM at the same moment as its text is frequently missed by screen
 * readers, because there was no region to observe beforehand.
 */

export function StatusRegion({
  status,
  error,
}: {
  status?: string | undefined;
  error?: string | undefined;
}) {
  const hasError = error !== undefined && error.length > 0;
  const hasStatus = status !== undefined && status.length > 0;

  return (
    <div className="status-live">
      <div role="status" aria-live="polite">
        {hasStatus && !hasError && (
          <div className="banner banner-success">
            <span className="banner-icon" aria-hidden="true">
              ✓
            </span>
            <div>
              <div className="banner-title">Done</div>
              <p className="banner-body">{status}</p>
            </div>
          </div>
        )}
      </div>
      <div role="alert" aria-live="assertive">
        {hasError && (
          <div className="banner banner-danger">
            <span className="banner-icon" aria-hidden="true">
              !
            </span>
            <div>
              <div className="banner-title">Not applied</div>
              <p className="banner-body">{error}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Normalizes a searchParams value. Next gives `string | string[] | undefined`,
 * and an array (`?status=a&status=b`) must not be rendered as "a,b".
 */
export function firstParam(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

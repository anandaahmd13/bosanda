/**
 * Live region for async status text.
 *
 * The element must exist in the DOM *before* the message appears, otherwise many
 * screen readers never announce it — which is why this renders an empty <p>
 * rather than returning null when there is no message.
 *
 * `polite` for ordinary progress, `assertive` only for errors that block the
 * user, since assertive interrupts whatever is being read.
 */

export function StatusRegion({
  message,
  tone = "info",
  assertive = false,
}: {
  message: string | null;
  tone?: "info" | "danger" | "success" | "warning";
  assertive?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live={assertive ? "assertive" : "polite"}
      // Announce the whole message when any part changes, not just the diff.
      aria-atomic="true"
      className={message === null ? undefined : `alert alert--${tone}`}
    >
      {message === null ? null : <p className="alert__body">{message}</p>}
    </div>
  );
}

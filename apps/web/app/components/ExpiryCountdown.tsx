/**
 * Live countdown to key expiry (§11: 24h validity window from confirmed payment).
 *
 * A client component because a server-rendered duration is stale the moment it
 * reaches the browser. The server sends the absolute UTC instant and the
 * countdown is computed here, which also means no clock skew correction is
 * needed: both sides agree on the instant, not on the remaining time.
 *
 * Accessibility: the ticking text is aria-hidden and a coarse, politely-announced
 * summary sits beside it. A live region updating every second would make the
 * page unusable with a screen reader.
 */

"use client";

import { useEffect, useState } from "react";
import { formatDuration, splitDuration } from "../lib/format";

export function ExpiryCountdown({ expiresAt }: { expiresAt: string }) {
  const target = new Date(expiresAt).getTime();

  // Starts null so the server-rendered HTML and the first client render agree;
  // computing a duration during render would produce a hydration mismatch.
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    if (Number.isNaN(target)) return;
    const tick = () => setRemainingMs(target - Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [target]);

  if (Number.isNaN(target)) return <span className="muted">unknown</span>;

  if (remainingMs === null) {
    // Pre-hydration placeholder. Same on server and client.
    return <span className="muted">&hellip;</span>;
  }

  if (remainingMs <= 0) {
    return (
      <span className="chip chip--danger" role="status">
        Expired
      </span>
    );
  }

  const { hours, minutes } = splitDuration(remainingMs);
  const urgent = remainingMs < 60 * 60 * 1000;

  return (
    <>
      <span className={urgent ? "kpi__value" : undefined} aria-hidden="true">
        {formatDuration(remainingMs)}
      </span>
      {/* Coarse text for assistive tech: minutes, not seconds, so it is not
          re-announced on every tick. */}
      <span className="visually-hidden">
        {hours > 0 ? `${hours} hours ${minutes} minutes remaining` : `${minutes} minutes remaining`}
      </span>
    </>
  );
}

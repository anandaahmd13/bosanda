/**
 * Public footer.
 *
 * §16 privacy: "User-facing policy discloses that requests are routed to Kiro
 * upstream." That disclosure lives here so it is on every public page, not
 * buried in the docs.
 */

import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell">
        <p>
          Bosanda is a paid API gateway. Requests you send are routed to an upstream provider (Kiro)
          for inference. Prompt and response bodies are not retained by default.
        </p>
        <p>
          <Link href="/docs">Integration guide</Link> · <Link href="/docs#limits">Limits</Link> ·{" "}
          <Link href="/login">Sign in</Link>
        </p>
      </div>
    </footer>
  );
}

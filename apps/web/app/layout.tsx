import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { FixtureBanner } from "./components/FixtureBanner";
import { SiteHeader } from "./components/SiteHeader";
import { PUBLIC_API_URL } from "./lib/env";

/**
 * Root layout for the storefront + user dashboard (PLAN.md §4 "Web").
 *
 * The font is loaded through `next/font` rather than a <link> to Google's CDN:
 * the CSP in middleware.ts sets `font-src 'self'`, and next/font self-hosts the
 * file at build time, so there is no third-party request at runtime to allow.
 */

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
  variable: "--font-jakarta",
});

export const metadata: Metadata = {
  title: {
    default: "Bosanda — paid AI gateway",
    template: "%s · Bosanda",
  },
  description: `OpenAI- and Anthropic-compatible AI gateway. Prepaid weighted-token packages, no subscription. API at ${PUBLIC_API_URL}.`,
  // §16 favours withholding fingerprints; there is nothing here worth indexing
  // beyond the storefront itself, and the dashboard must never be indexed.
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body>
        {/* First focusable element on every page: keyboard users must be able to
            skip the nav. Targets #main, which every page provides. */}
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <FixtureBanner />
        <SiteHeader />
        {children}
        <footer className="site-footer">
          <div className="shell">
            <p className="muted">
              Bosanda is an independent service. It is not affiliated with, endorsed by, or a
              reseller for any model provider.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}

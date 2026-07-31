import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

/**
 * Plus Jakarta SANS — the open-source family (DESIGN.md §1.1, §5).
 *
 * NOT Plus Jakarta Display, which is the licensed font in the original kit and
 * must never be shipped. `next/font/google` self-hosts the files at build time,
 * so there is no runtime request to fonts.gstatic.com and `font-src 'self'`
 * holds.
 */
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "700", "800"],
  display: "swap",
  variable: "--font-jakarta",
});

export const metadata: Metadata = {
  title: "Bosanda operator console",
  // An operator console must never be indexed.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#030c1d",
};

/**
 * The root layout renders the document shell only.
 *
 * It deliberately does NOT check the session or render the sidebar: /login must
 * not show operator navigation, and an unauthorized visitor must not be able to
 * enumerate section names from the nav. The authenticated chrome lives in the
 * `(dashboard)` route group instead.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body>{children}</body>
    </html>
  );
}

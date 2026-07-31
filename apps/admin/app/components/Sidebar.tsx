"use client";

/**
 * 250px sidebar (DESIGN.md §2.4), collapsing to a disclosure below 960px.
 *
 * Client component only because it reads the current pathname to set
 * `aria-current="page"`. The collapse itself is a native <details>, so it works
 * without JS and stays keyboard-operable.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavEntry = { href: string; label: string; glyph: string };
type NavGroup = { label: string; entries: NavEntry[] };

/** Glyphs are text, not an icon font: no extra network request, no CSP change. */
const GROUPS: NavGroup[] = [
  {
    label: "Operations",
    entries: [
      { href: "/", label: "Overview", glyph: "◉" },
      { href: "/health", label: "Health", glyph: "♥" },
      { href: "/flags", label: "Kill switches", glyph: "⏻" },
      { href: "/audit", label: "Audit log", glyph: "☰" },
    ],
  },
  {
    label: "Provider",
    entries: [
      { href: "/accounts", label: "Kiro pool", glyph: "⛁" },
      { href: "/models", label: "Models", glyph: "✦" },
    ],
  },
  {
    label: "Commerce",
    entries: [
      { href: "/packages", label: "Packages & stock", glyph: "▤" },
      { href: "/orders", label: "Orders", glyph: "⇄" },
    ],
  },
  {
    label: "Customers",
    entries: [
      { href: "/users", label: "Users", glyph: "◍" },
      { href: "/keys", label: "API keys", glyph: "⚿" },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="sidebar" aria-label="Admin sections">
      <Link href="/" className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span>
          Bosanda
          <span className="brand-sub">Operator console</span>
        </span>
      </Link>

      <hr className="hr" />

      {/*
        `open` by default so the nav is expanded on desktop, where CSS hides the
        summary entirely. Below 960px the summary appears and this becomes a real
        collapsible menu.
      */}
      <details className="nav-collapse" open>
        <summary>
          <span aria-hidden="true">☰</span> Menu
        </summary>

        {GROUPS.map((group) => (
          <div key={group.label}>
            <div className="nav-group-label" id={`navgroup-${group.label}`}>
              {group.label}
            </div>
            <ul className="nav-list" aria-labelledby={`navgroup-${group.label}`}>
              {group.entries.map((entry) => {
                const active = isActive(pathname, entry.href);
                return (
                  <li key={entry.href}>
                    <Link
                      href={entry.href}
                      className="nav-item"
                      {...(active ? { "aria-current": "page" as const } : {})}
                    >
                      <span className="nav-chip" aria-hidden="true">
                        {entry.glyph}
                      </span>
                      {entry.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </details>
    </nav>
  );
}

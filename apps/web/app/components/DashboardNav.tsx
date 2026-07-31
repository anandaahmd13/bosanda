/**
 * Dashboard sidebar navigation (DESIGN.md §2.3).
 *
 * A client component only because the active item is derived from the pathname.
 * It holds no data and makes no request — the pages above it do the reads.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: ReadonlyArray<{ href: string; label: string; icon: string }> = [
  { href: "/dashboard", label: "Overview", icon: "◧" },
  { href: "/dashboard/keys", label: "API keys", icon: "⚿" },
  { href: "/dashboard/orders", label: "Orders", icon: "▤" },
];

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="sidebar" aria-label="Dashboard">
      <p className="sidebar__group">Account</p>
      <ul>
        {LINKS.map((link) => {
          // Exact match for the index so /dashboard does not stay highlighted
          // while a child route is open.
          const active =
            link.href === "/dashboard"
              ? pathname === "/dashboard"
              : (pathname?.startsWith(link.href) ?? false);
          return (
            <li key={link.href}>
              <Link href={link.href} aria-current={active ? "page" : undefined}>
                <span className="sidebar__icon" aria-hidden="true">
                  {link.icon}
                </span>
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>

      <p className="sidebar__group">Buy</p>
      <ul>
        <li>
          <Link
            href="/checkout"
            aria-current={pathname?.startsWith("/checkout") ? "page" : undefined}
          >
            <span className="sidebar__icon" aria-hidden="true">
              ✛
            </span>
            Buy quota
          </Link>
        </li>
      </ul>
    </nav>
  );
}

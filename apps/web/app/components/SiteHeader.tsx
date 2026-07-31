/**
 * Public site header.
 *
 * `aria-current="page"` is set from the pathname so assistive tech announces the
 * active item, which is also what the gradient pill styling keys off.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/", label: "Packages" },
  { href: "/docs", label: "API docs" },
  { href: "/dashboard", label: "Dashboard" },
];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="site-header">
      <div className="shell site-header__inner">
        <Link href="/" className="brand">
          <span className="brand__mark" aria-hidden="true">
            B
          </span>
          Bosanda
        </Link>

        <nav className="site-nav" aria-label="Main">
          <ul>
            {LINKS.map((link) => {
              const active =
                link.href === "/" ? pathname === "/" : (pathname?.startsWith(link.href) ?? false);
              return (
                <li key={link.href}>
                  <Link href={link.href} aria-current={active ? "page" : undefined}>
                    {link.label}
                  </Link>
                </li>
              );
            })}
            <li>
              <Link href="/login" className="btn btn--primary btn--sm">
                Sign in
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}

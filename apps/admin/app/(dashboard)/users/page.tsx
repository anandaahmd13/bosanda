/**
 * /users — customer list (§15).
 *
 * Search is by username only. There is no field for an email address, a phone
 * number, or an API key: the first two are not stored, and searching by a key's
 * plaintext would require a plaintext key to reach this process (§12). Key lookup
 * lives on /keys and works on prefix or lookup digest.
 *
 * Read-only. Disabling an account and resetting a password are on the detail
 * page, where the operator can see how many live keys the account holds before
 * cutting it off.
 */

import Link from "next/link";
import type { Metadata } from "next";
import { Card, EmptyState, Kpi, PageHeader, TableScroll } from "../../components/Card";
import { Chip } from "../../components/Chip";
import { FilterForm, PAGE_SIZE, Pagination, readOffset } from "../../components/Pagination";
import { StatusRegion, firstParam } from "../../components/StatusRegion";
import { listUsers } from "../../lib/api";
import { formatCount, formatRelative, formatTokensCompact, formatUtc } from "../../lib/format";
import type { AdminUser } from "../../lib/schemas";

export const metadata: Metadata = { title: "Customers — Bosanda operator console" };

/** Truncated rather than rejected: a long query is a paste, not an attack. */
function readQuery(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined ? "" : raw.slice(0, 200);
}

function StatusChip({ status }: { status: AdminUser["status"] }) {
  if (status === "active") return <Chip tone="success">active</Chip>;
  if (status === "disabled") return <Chip tone="danger">disabled</Chip>;
  return <Chip tone="neutral">{status}</Chip>;
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = readQuery(params["q"]);
  const offset = readOffset(params["offset"]);

  const { users, total } = await listUsers({ query, page: { limit: PAGE_SIZE, offset } });

  // Page-scoped, like the other lists. Labelled as such below so the number is
  // not mistaken for a total across the table.
  const disabledOnPage = users.filter((user) => user.status === "disabled").length;
  const keysOnPage = users.reduce((sum, user) => sum + user.activeKeyCount, 0);
  const remainingOnPage = users.reduce((sum, user) => sum + user.totalWeightedRemaining, 0);

  return (
    <>
      <PageHeader eyebrow="Accounts" title="Customers" />

      <StatusRegion status={firstParam(params["status"])} error={firstParam(params["error"])} />

      <div className="grid grid-kpi">
        <Kpi label="Customers (total)" value={formatCount(total)} />
        <Kpi label="Active keys (this page)" value={formatCount(keysOnPage)} />
        <Kpi label="Quota held (this page)" value={formatTokensCompact(remainingOnPage)} />
        <Kpi label="Disabled (this page)" value={formatCount(disabledOnPage)} />
      </div>

      <Card title="Customers" hint={`${formatCount(total)} matching accounts`}>
        <FilterForm action="/users" label="Search customers">
          <div className="field">
            <label className="field-label" htmlFor="q">
              Username contains
            </label>
            <input
              id="q"
              name="q"
              className="input"
              type="search"
              defaultValue={query}
              placeholder="username"
              autoComplete="off"
              maxLength={200}
            />
          </div>
        </FilterForm>

        {users.length === 0 ? (
          <EmptyState>
            {query === ""
              ? "No customers yet."
              : `No customer matches “${query}”. Usernames are matched as a substring.`}
          </EmptyState>
        ) : (
          <TableScroll label="Customers">
            <table className="table">
              <caption className="visually-hidden">
                Customers with their role, status, active key count, remaining quota, sign-up date,
                and last sign-in.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Username</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Active keys
                  </th>
                  <th scope="col" className="num">
                    Quota remaining
                  </th>
                  <th scope="col">Joined (UTC)</th>
                  <th scope="col">Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <th scope="row">
                      <Link href={`/users/${encodeURIComponent(user.id)}`}>{user.username}</Link>
                      {user.role === "admin" && (
                        <>
                          {" "}
                          {/* Flagged in the list: an operator account among
                              customer rows is worth noticing before acting on it. */}
                          <Chip tone="info">admin</Chip>
                        </>
                      )}
                      <div className="field-hint mono">{user.id}</div>
                    </th>
                    <td>
                      <StatusChip status={user.status} />
                    </td>
                    <td className="num mono">{formatCount(user.activeKeyCount)}</td>
                    <td
                      className="num mono"
                      title={`${formatCount(user.totalWeightedRemaining)} weighted tokens`}
                    >
                      {formatTokensCompact(user.totalWeightedRemaining)}
                    </td>
                    <td className="mono">{formatUtc(user.createdAt)}</td>
                    <td className="mono">
                      {user.lastLoginAt === null ? (
                        <span className="field-hint">never signed in</span>
                      ) : (
                        formatRelative(user.lastLoginAt)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        <Pagination
          base="/users"
          params={query === "" ? {} : { q: query }}
          offset={offset}
          total={total}
          count={users.length}
        />
      </Card>
    </>
  );
}

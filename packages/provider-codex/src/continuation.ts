export type PendingToolCall = {
  accountId: string;
  callId: string;
  expiresAt: number;
};

export class ContinuationMap {
  private readonly entries = new Map<string, PendingToolCall>();

  constructor(private readonly ttlMs = 10 * 60_000) {}

  remember(publicToolUseId: string, accountId: string, callId: string, now = Date.now()): void {
    this.entries.set(publicToolUseId, { accountId, callId, expiresAt: now + this.ttlMs });
  }

  take(publicToolUseId: string, accountId: string, now = Date.now()): PendingToolCall | null {
    const entry = this.entries.get(publicToolUseId);
    if (!entry || entry.expiresAt <= now) {
      this.entries.delete(publicToolUseId);
      return null;
    }
    if (entry.accountId !== accountId) return null;
    this.entries.delete(publicToolUseId);
    return entry;
  }

  clear(accountId?: string): void {
    if (accountId === undefined) {
      this.entries.clear();
      return;
    }
    for (const [id, entry] of this.entries)
      if (entry.accountId === accountId) this.entries.delete(id);
  }
}

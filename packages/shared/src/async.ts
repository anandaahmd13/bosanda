/**
 * Async primitives used by the provider layer.
 *
 * `singleFlight` backs the per-account token-refresh collapse required by
 * PLAN.md §3 G0.4 and §19 ("Concurrent refresh single-flight").
 */

/**
 * Collapses concurrent calls that share a key onto one in-flight promise.
 * The entry is removed once settled, so a later call re-runs the work — this is
 * a de-duplicator, not a cache.
 */
export function singleFlight<K, V>(): (key: K, fn: () => Promise<V>) => Promise<V> {
  const inflight = new Map<K, Promise<V>>();
  return (key, fn) => {
    const existing = inflight.get(key);
    if (existing) return existing;
    // Start the work, then always clear the slot — including on rejection, so a
    // transient failure does not poison later attempts.
    const promise = (async () => fn())().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  };
}

export class TimeoutError extends Error {
  constructor(
    readonly kind: "idle" | "hard",
    ms: number,
  ) {
    super(`${kind} timeout after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** Rejects with TimeoutError if `promise` has not settled within `ms`. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  kind: "idle" | "hard" = "hard",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(kind, ms)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wraps an async iterable so that going longer than `idleMs` between yields
 * aborts the stream. Guards against an upstream that accepts the request and
 * then stalls forever (PLAN.md §3 G2).
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let timedOut = false;
  try {
    for (;;) {
      let next: IteratorResult<T>;
      try {
        next = await withTimeout(iterator.next(), idleMs, "idle");
      } catch (error) {
        if (error instanceof TimeoutError && error.kind === "idle") {
          timedOut = true;
          // A pending next() can make return() wait forever. Start cancellation,
          // but do not let uncooperative cleanup suppress the timeout itself.
          const cleanup = iterator.return?.(undefined);
          if (cleanup !== undefined) void cleanup.catch(() => undefined);
        }
        throw error;
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // On ordinary consumer cancellation, wait for cleanup. The timeout path has
    // already started best-effort cleanup above and must reject promptly.
    if (!timedOut) await iterator.return?.(undefined);
  }
}

/** Links an AbortSignal to a rejection, for racing against non-abortable work. */
export function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
      once: true,
    });
  });
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

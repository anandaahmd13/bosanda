import { describe, expect, it, vi } from "vitest";
import {
  singleFlight,
  withTimeout,
  withIdleTimeout,
  abortPromise,
  sleep,
  TimeoutError,
} from "@bosanda/shared";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("singleFlight", () => {
  it("collapses concurrent calls sharing a key onto one execution", async () => {
    const run = singleFlight<string, number>();
    const gate = deferred<number>();
    const work = vi.fn(() => gate.promise);

    const a = run("account-1", work);
    const b = run("account-1", work);
    const c = run("account-1", work);
    expect(work).toHaveBeenCalledTimes(1);

    gate.resolve(7);
    await expect(Promise.all([a, b, c])).resolves.toEqual([7, 7, 7]);
  });

  it("keeps distinct keys independent so accounts never share a token refresh", async () => {
    const run = singleFlight<string, string>();
    const work = vi.fn(async (id: string) => id);

    const [one, two] = await Promise.all([
      run("account-1", () => work("account-1")),
      run("account-2", () => work("account-2")),
    ]);

    expect([one, two]).toEqual(["account-1", "account-2"]);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("re-runs after settling instead of caching the result", async () => {
    const run = singleFlight<string, number>();
    const work = vi.fn(async () => 1);

    await run("k", work);
    await run("k", work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("does not poison the slot when the work rejects", async () => {
    const run = singleFlight<string, string>();
    const failing = vi.fn(async () => {
      throw new Error("refresh failed");
    });

    const first = run("k", failing);
    const second = run("k", failing);
    await expect(first).rejects.toThrow("refresh failed");
    await expect(second).rejects.toThrow("refresh failed");
    expect(failing).toHaveBeenCalledTimes(1);

    // A later attempt runs fresh.
    await expect(run("k", async () => "recovered")).resolves.toBe("recovered");
  });

  it("propagates a synchronous throw as a rejection", async () => {
    const run = singleFlight<string, number>();
    await expect(
      run("k", () => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
  });
});

describe("withTimeout", () => {
  it("resolves when the work finishes in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });

  it("rejects with a labelled TimeoutError when it does not", async () => {
    const never = new Promise<never>(() => {});
    const error = await withTimeout(never, 20, "idle").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).kind).toBe("idle");
  });
});

describe("withIdleTimeout", () => {
  const source = async function* (delays: number[]) {
    for (const [index, delay] of delays.entries()) {
      await sleep(delay);
      yield index;
    }
  };

  it("passes values through while the producer keeps up", async () => {
    const seen: number[] = [];
    for await (const value of withIdleTimeout(source([1, 1, 1]), 200)) seen.push(value);
    expect(seen).toEqual([0, 1, 2]);
  });

  it("aborts a stalled stream mid-flight", async () => {
    const seen: number[] = [];
    const consume = async () => {
      for await (const value of withIdleTimeout(source([1, 5000]), 40)) seen.push(value);
    };
    await expect(consume()).rejects.toBeInstanceOf(TimeoutError);
    expect(seen).toEqual([0]);
  });

  it("rejects promptly even when a stalled next() also blocks return()", async () => {
    let returnCalled = false;
    const stalled: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<number>>(() => undefined),
          return: () => {
            returnCalled = true;
            return new Promise<IteratorResult<number>>(() => undefined);
          },
        };
      },
    };

    const startedAt = Date.now();
    await expect(withIdleTimeout(stalled, 20).next()).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(returnCalled).toBe(true);
  });

  it("calls return() on the source when the consumer breaks early", async () => {
    let closed = false;
    const instrumented = (async function* () {
      try {
        yield 1;
        yield 2;
      } finally {
        closed = true;
      }
    })();

    for await (const _value of withIdleTimeout(instrumented, 500)) break;
    expect(closed).toBe(true);
  });
});

describe("abortPromise", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client gone"));
    await expect(abortPromise(controller.signal)).rejects.toThrow("client gone");
  });

  it("rejects when the signal aborts later", async () => {
    const controller = new AbortController();
    const pending = abortPromise(controller.signal);
    controller.abort(new Error("disconnected"));
    await expect(pending).rejects.toThrow("disconnected");
  });
});

describe("sleep", () => {
  it("rejects and clears the timer when aborted", async () => {
    const controller = new AbortController();
    const pending = sleep(5000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});

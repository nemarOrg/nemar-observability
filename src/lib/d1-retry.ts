// Retry for reads of nemar-cli's shared D1 (`nemar-db`).
//
// nemar-cli backs that database up hourly (nemar-db-backup, ADR 0004). While
// an export runs, D1 rejects other queries with "Currently processing a
// long-running export", so a snapshot computed in that window loses every
// D1-backed tile until the next hourly run. The export lasts seconds to a
// couple of minutes, so waiting it out inside the run is enough.

export interface RetryPolicy {
  /** Wait before retry n (1-based); its length is the number of retries. */
  delaysMs: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/** No retries: the right policy for a request a browser is waiting on. */
export const NO_RETRY: RetryPolicy = { delaysMs: [] };

/** The cron has minutes to spare: about 2.5 minutes of waiting in total. */
export const CRON_RETRY: RetryPolicy = { delaysMs: [5_000, 15_000, 45_000, 90_000] };

const TRANSIENT = /long-running export|database is locked|\bD1_ERROR\b.*\b(busy|overloaded)\b/i;

/** Only errors that clear on their own; a bad query or missing table must fail at once. */
export function isTransientD1Error(err: unknown): boolean {
  return TRANSIENT.test(err instanceof Error ? err.message : String(err));
}

export async function withD1Retry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = NO_RETRY,
): Promise<T> {
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const wait = policy.delaysMs[attempt];
      if (wait === undefined || !isTransientD1Error(err)) throw err;
      console.warn(`[d1] transient error, retry ${attempt + 1} in ${wait}ms: ${String(err)}`);
      await sleep(wait);
    }
  }
}

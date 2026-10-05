// An HTTP stand-in for the Analytics Engine SQL API that answers each embed
// query with the REAL answer captured for it (test/fixtures/embed-ae-*.json),
// chosen by the shape of the SQL. Only the transport is stood in for: the
// answers are live captures from nemar_website_embeds_dev, and everything the
// Worker does with them is the real code.

import datasets from "../fixtures/embed-ae-datasets-2026-10-05.json";
import days from "../fixtures/embed-ae-days-2026-10-05.json";
import daysRetention from "../fixtures/embed-ae-days-retention-window-2026-10-05.json";
import sites from "../fixtures/embed-ae-sites-2026-10-05.json";
import total from "../fixtures/embed-ae-total-2026-10-05.json";

export type QueryShape = "days" | "sites" | "datasets" | "total" | "other";

/** Which embed query this SQL is. */
export function shapeOf(sql: string): QueryShape {
  if (sql.includes("GROUP BY day, kind")) return "days";
  if (sql.includes("GROUP BY host")) return "sites";
  if (sql.includes("GROUP BY dataset_id")) return "datasets";
  if (sql.includes("SUM(_sample_interval) AS loads") && !sql.includes("GROUP BY")) return "total";
  return "other";
}

export const CAPTURED = {
  days: daysRetention.response,
  sites: sites.response,
  datasets: datasets.response,
  total: total.response,
};
export const CAPTURED_DAY_WINDOW = days.response;

export interface AeStub {
  /** Every SQL statement asked, in order. */
  asked: string[];
  restore(): void;
}

/**
 * Install a fetch that answers the AE SQL API. `answers` overrides the captured
 * answer per query shape; a function can fail or reshape it. Anything that is
 * not the AE SQL URL goes to the real fetch.
 */
export function stubAe(
  answers: Partial<Record<QueryShape, (sql: string) => Response | unknown>> = {},
): AeStub {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (!String(input).includes("/analytics_engine/sql")) return realFetch(input as never, init);
    const sql = String(init?.body ?? "");
    asked.push(sql);
    const shape = shapeOf(sql);
    const custom = answers[shape];
    const value = custom ? custom(sql) : (CAPTURED as Record<string, unknown>)[shape];
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value ?? { data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    asked,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

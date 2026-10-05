// queryAe must tell an empty answer from a broken one: a 200 with `data: []` is
// real (nothing written yet), a 200 with no data array is not, and neither may
// be read as "zero activity" by accident. These run the real client against HTTP
// answers of the shapes the edge sends; the empty one is captured live.

import { afterEach, describe, expect, test } from "bun:test";
import { queryAe } from "../src/lib/access";
import { EMBED_QUERY_TIMEOUT_MS } from "../src/lib/embeds";
import type { Bindings } from "../src/types";
import unwritten from "./fixtures/embed-ae-unwritten-dataset-days-2026-10-05.json";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const env = { CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "t" } as unknown as Bindings;
const answer = (body: unknown, status = 200) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
};

describe("queryAe", () => {
  test("a captured empty answer (HTTP 200, data: []) is a real empty result", async () => {
    answer(unwritten.response);
    expect(await queryAe(env, "SELECT 1")).toEqual([]);
  });

  test("a 200 with an errors body and no data array is a failure, not an empty result", async () => {
    answer({ errors: [{ message: "denied" }] });
    await expect(queryAe(env, "SELECT 1")).rejects.toThrow("no data array");
  });

  test("a 200 with an empty object, a null or a non-array data is a failure", async () => {
    for (const body of [{}, { data: null }, { data: "x" }, { data: {} }]) {
      answer(body);
      await expect(queryAe(env, "SELECT 1")).rejects.toThrow("no data array");
    }
  });

  test("a non-ok status is a failure", async () => {
    answer({ error: "nope" }, 403);
    await expect(queryAe(env, "SELECT 1")).rejects.toThrow("AE SQL 403");
  });

  test("a call carries a time limit only when one is given", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      signals.push(init.signal);
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;
    await queryAe(env, "SELECT 1");
    await queryAe(env, "SELECT 1", EMBED_QUERY_TIMEOUT_MS);
    // The access section's long queries stay unbounded; the embed callers are bounded.
    expect(signals[0]).toBeUndefined();
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    expect(EMBED_QUERY_TIMEOUT_MS).toBe(10_000);
  });
});

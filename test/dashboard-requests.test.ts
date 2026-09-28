import { describe, expect, test } from "bun:test";
import audience from "./fixtures/audience-2026-09-21-to-2026-09-27.json";
import { clientLogic } from "./helpers/client-logic";

const { createRequestCache, createLatestGuard, validAudience } = clientLogic([
  "createRequestCache",
  "createLatestGuard",
  "validAudience",
]);

// The loader is the page's own shape check over a real /audience answer (see
// the fixture's source line), so a request either resolves with that answer or
// rejects exactly as the page's getJson does.
function audienceLoader(outcomes: ("ok" | "malformed" | "fail")[]) {
  const calls: string[] = [];
  return {
    calls,
    load(key: string) {
      calls.push(key);
      const outcome = outcomes[calls.length - 1] ?? "ok";
      if (outcome === "fail") return Promise.reject(new Error("Could not load audience metrics."));
      const body = outcome === "malformed" ? { cloudflare: null } : audience.response;
      return validAudience(body) ? Promise.resolve(body) : Promise.reject(new Error("unexpected"));
    },
  };
}

describe("shared audience requests", () => {
  test("the same dates share one request while it is fresh", async () => {
    let now = 0;
    const loader = audienceLoader(["ok"]);
    const cache = createRequestCache(loader.load, 1000, () => now);
    const [a, b] = await Promise.all([
      cache.get("2026-09-21|2026-09-27"),
      cache.get("2026-09-21|2026-09-27"),
    ]);
    expect(a).toBe(b);
    expect(loader.calls).toEqual(["2026-09-21|2026-09-27"]);
    now = 1000;
    await cache.get("2026-09-21|2026-09-27");
    expect(loader.calls.length).toBe(2);
  });

  test("a failed or malformed answer is forgotten, so asking again retries", async () => {
    const loader = audienceLoader(["fail", "malformed", "ok"]);
    const cache = createRequestCache(loader.load, 60_000, () => 0);
    const key = "2026-09-21|2026-09-27";
    await expect(cache.get(key)).rejects.toThrow("Could not load audience metrics.");
    expect(cache.size()).toBe(0);
    await expect(cache.get(key)).rejects.toThrow("unexpected");
    expect(cache.size()).toBe(0);
    await expect(cache.get(key)).resolves.toBe(audience.response);
    expect(loader.calls.length).toBe(3);
    expect(cache.size()).toBe(1);
  });

  test("forget drops one answer so a redraw failure can ask again", async () => {
    const loader = audienceLoader(["ok", "ok"]);
    const cache = createRequestCache(loader.load, 60_000, () => 0);
    await cache.get("k");
    cache.forget("k");
    await cache.get("k");
    expect(loader.calls).toEqual(["k", "k"]);
  });
});

describe("stale answers", () => {
  test("an older answer that arrives late cannot change the page", async () => {
    const guard = createLatestGuard();
    const shown: string[] = [];
    let releaseFirst: () => void = () => {};
    const first = guard.begin();
    const slow = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }).then(() => {
      if (guard.isCurrent(first)) shown.push("first range");
    });
    const second = guard.begin();
    await Promise.resolve().then(() => {
      if (guard.isCurrent(second)) shown.push("second range");
    });
    releaseFirst();
    await slow;
    expect(shown).toEqual(["second range"]);
  });
});

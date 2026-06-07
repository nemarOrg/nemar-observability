// Integration test for the GENERIC publish-approve loop (runPublishApprove),
// the maintenance-decoupled continuation contract. We evaluate the EXACT client
// script shipped in the dashboard page (extracted from renderDashboardPage()),
// providing the browser-environment seam (fetch/localStorage/document/window/
// setTimeout) as stubs — NOT a reimplementation of the loop. The loop itself is
// the real production code under test.

import { describe, expect, test } from "bun:test";
import { renderDashboardPage } from "../src/routes/ui";

// Pull the inline client script out of the rendered HTML, then expose the
// internal functions we want to drive by appending a return.
function loadClient(fetchImpl: typeof fetch) {
  const html = renderDashboardPage();
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("client script not found in rendered page");
  const src = m[1];

  // The bootstrap (`setupAdmin(); fetchMe(); load();`) issues /me + /snapshot
  // fetches at eval time. Route ONLY /approve to the test's fetchImpl so its
  // call counter measures the loop, not the bootstrap; bootstrap calls get a
  // benign empty 200.
  const routedFetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    if (typeof url === "string" && url.includes("/approve")) return fetchImpl(url, init);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  // Minimal DOM/browser stubs. Only the surface the bootstrap + loop touch.
  const noopEl = () => {
    const e: Record<string, unknown> = {};
    e.textContent = "";
    e.className = "";
    e.style = {};
    e.classList = { add() {}, remove() {}, toggle() {} };
    e.appendChild = () => e;
    e.addEventListener = () => {};
    e.getElementsByTagName = () => [];
    e.disabled = false;
    return e;
  };
  const documentStub = {
    createElement: noopEl,
    getElementById: noopEl,
    addEventListener: () => {},
  };
  const localStorageStub = (() => {
    const store: Record<string, string> = { nemar_obs_key: "owner-key" };
    return {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    };
  })();
  const windowStub = { confirm: () => true, prompt: () => "" };

  // setTimeout: run callbacks immediately (zero backoff) so retries don't stall
  // the test, while still exercising the real retry path.
  const fastSetTimeout = ((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout;

  const factory = new Function(
    "fetch",
    "localStorage",
    "document",
    "window",
    "setTimeout",
    "URL",
    `${src}\nreturn { runPublishApprove: runPublishApprove };`,
  );
  return factory(routedFetch, localStorageStub, documentStub, windowStub, fastSetTimeout, URL) as {
    runPublishApprove: (id: string, fb: unknown, bar: unknown) => Promise<void>;
  };
}

// A feedback recorder matching the rowFeedback() shape.
function recorder() {
  const log: { kind: string; msg: string }[] = [];
  return {
    fb: {
      info: (m: string) => log.push({ kind: "info", msg: m }),
      ok: (m: string) => log.push({ kind: "ok", msg: m }),
      err: (m: string) => log.push({ kind: "err", msg: m }),
    },
    bar: { textContent: "", appendChild: () => {} },
    log,
    last: () => log[log.length - 1],
  };
}

describe("runPublishApprove (generic continuation loop)", () => {
  test("terminates on absence of hasMore, blind-echoing the s3_lock token across pages", async () => {
    const seen: { body: Record<string, unknown> }[] = [];
    // 3-page s3_lock: page 1 -> token A, page 2 -> token B, page 3 -> published.
    const pages = [
      {
        step: "s3_lock",
        steps_completed: ["repo"],
        s3_lock_continuation_token: "A",
        s3_lock_total: 9,
        hasMore: true,
      },
      {
        step: "s3_lock",
        steps_completed: ["repo", "lock1"],
        s3_lock_continuation_token: "B",
        s3_lock_total: 9,
        hasMore: true,
      },
      {
        status: "published",
        message: "Dataset published successfully",
        steps_completed: ["repo", "lock1", "lock2", "doi"],
      },
    ];
    let i = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push({ body: JSON.parse(init.body as string) });
      const page = pages[Math.min(i, pages.length - 1)];
      i++;
      return new Response(JSON.stringify(page), { status: 200 });
    }) as unknown as typeof fetch;

    const client = loadClient(fetchImpl);
    const r = recorder();
    await client.runPublishApprove("nm000132", r.fb, r.bar);

    // 3 calls; first resume:false, the rest resume:true echoing the prior token.
    expect(seen).toHaveLength(3);
    expect(seen[0].body).toMatchObject({ resume: false, skip_ci_check: false });
    expect(seen[1].body).toMatchObject({
      resume: true,
      s3_lock_continuation_token: "A",
      s3_lock_total: 9,
    });
    expect(seen[2].body).toMatchObject({
      resume: true,
      s3_lock_continuation_token: "B",
      s3_lock_total: 9,
    });
    expect(r.last()).toMatchObject({ kind: "ok" });
  });

  test("stops immediately (no retry) on a 426 with the server message", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "Client upgrade required", step: "preflight" }), {
        status: 426,
      });
    }) as unknown as typeof fetch;
    const client = loadClient(fetchImpl);
    const r = recorder();
    await client.runPublishApprove("nm000132", r.fb, r.bar);
    expect(calls).toBe(1); // no retry on 426
    expect(r.last().kind).toBe("err");
    expect(r.last().msg).toContain("Client upgrade required");
  });

  test("retries a 5xx (non-ci_check) up to MAX_TRANSIENT then errors", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "boom", step: "s3_lock" }), { status: 503 });
    }) as unknown as typeof fetch;
    const client = loadClient(fetchImpl);
    const r = recorder();
    await client.runPublishApprove("nm000132", r.fb, r.bar);
    // 1 initial + 4 transient retries = 5 attempts, then give up.
    expect(calls).toBe(5);
    expect(r.last().kind).toBe("err");
  });

  test("does NOT retry a 5xx whose step is ci_check (GitHub rate limit)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "CI check failed", step: "ci_check" }), {
        status: 500,
      });
    }) as unknown as typeof fetch;
    const client = loadClient(fetchImpl);
    const r = recorder();
    await client.runPublishApprove("nm000132", r.fb, r.bar);
    expect(calls).toBe(1); // surfaced, not retried
    expect(r.last().kind).toBe("err");
    expect(r.last().msg).toContain("CI check failed");
  });

  test("hits the absolute iteration cap if hasMore never clears", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      // Always more, never a terminal response: the cap must stop it.
      return new Response(
        JSON.stringify({
          step: "s3_lock",
          steps_completed: [],
          s3_lock_continuation_token: "x",
          s3_lock_total: 1,
          hasMore: true,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = loadClient(fetchImpl);
    const r = recorder();
    await client.runPublishApprove("nm000132", r.fb, r.bar);
    // Bounded by MAX_ITERATIONS (200): exactly 200 fetches, then the cap errors
    // on the 201st entry (before fetch). Far from infinite.
    expect(calls).toBe(200);
    expect(r.last().kind).toBe("err");
    expect(r.last().msg).toContain("Stopped after 200 steps");
  });
});

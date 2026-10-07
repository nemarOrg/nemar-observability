// The streaming root-object scanner, checked against JSON.parse on the real
// committed indexes at every awkward chunking, and on a hand-built document that
// puts structural characters inside strings. Nothing here is a stand-in: the
// scanner and JSON.parse read the same bytes and must agree.

import { describe, expect, test } from "bun:test";
import {
  JsonShapeError,
  RootObjectScanner,
  type RootScanHandlers,
  scanRootObject,
} from "../scripts/lib/json-stream";
import { FIXTURES, fixtureBytes } from "./helpers/zarr-fixtures";

type Collected = {
  values: Record<string, unknown>;
  elements: Record<string, unknown[]>;
  counts: Record<string, number>;
};

/** Scan `bytes` in chunks of `size` and parse everything the scanner hands back. */
function collect(bytes: Uint8Array, size: number, wanted: (key: string) => boolean): Collected {
  const values: Record<string, unknown> = {};
  const elements: Record<string, unknown[]> = {};
  const decoder = new TextDecoder();
  const scanner = new RootObjectScanner({
    wantValue: wanted,
    onValue: (key, raw) => {
      values[key] = JSON.parse(raw);
    },
    wantElements: wanted,
    onElement: (key, raw) => {
      if (raw === null) return;
      elements[key] = [...(elements[key] ?? []), JSON.parse(decoder.decode(raw))];
    },
  });
  for (let i = 0; i < bytes.length; i += size) scanner.write(bytes.subarray(i, i + size));
  const { elementCounts } = scanner.finish();
  return { values, elements, counts: Object.fromEntries(elementCounts) };
}

describe("RootObjectScanner on real indexes", () => {
  for (const name of FIXTURES) {
    test(`${name}: scalars, stores, failures and pending match JSON.parse at every chunk size`, () => {
      const bytes = fixtureBytes(name);
      const whole = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      const wanted = (key: string) => key === "stores" || key === "failures" || key === "pending";
      const scalars = (key: string) =>
        key === "format" || key === "dataset_id" || key === "failure_count";
      const sizes =
        bytes.length > 20_000 ? [4096, 13, bytes.length] : [1, 2, 7, 4096, bytes.length];
      for (const size of sizes) {
        const scanned = collect(bytes, size, (key) => wanted(key) || scalars(key));
        expect(scanned.elements.stores ?? []).toEqual(whole.stores as unknown[]);
        expect(scanned.elements.failures ?? []).toEqual(whole.failures as unknown[]);
        expect(scanned.elements.pending ?? []).toEqual(whole.pending as unknown[]);
        expect(scanned.counts.stores).toBe((whole.stores as unknown[]).length);
        expect(scanned.values.format).toBe(whole.format);
        expect(scanned.values.dataset_id).toBe(whole.dataset_id);
        expect(scanned.values.failure_count).toBe(whole.failure_count);
      }
    });
  }

  test("counts the elements of an unwanted array without keeping them", () => {
    const bytes = fixtureBytes("on000117");
    const whole = JSON.parse(new TextDecoder().decode(bytes)) as { failures: unknown[] };
    const seen: (Uint8Array | null)[] = [];
    const scanner = new RootObjectScanner({
      wantElements: () => false,
      onElement: (key, raw) => {
        if (key === "failures") seen.push(raw);
      },
    });
    scanner.write(bytes);
    const { elementCounts } = scanner.finish();
    expect(elementCounts.get("failures")).toBe(whole.failures.length);
    expect(seen).toHaveLength(whole.failures.length);
    expect(seen.every((raw) => raw === null)).toBe(true);
  });
});

describe("RootObjectScanner on awkward documents", () => {
  // Braces, brackets, quotes, colons, commas and backslashes inside strings, a
  // multi-byte character, nested containers, every literal, and loose whitespace.
  const tricky = [
    "\n  {\n",
    '  "a{": "x}[,]:\\"y\\\\",\n',
    '  "n" : -12.5e3 ,\n',
    '  "t":true,"f":false,"z":null,\n',
    '  "list" : [ 1 , "two", {"k": [ "}" , {"deep": "\\"{"} ]}, [ ], [[]], true, null ] ,\n',
    '  "empty": [],\n',
    '  "obj": {"in": ["a", {"b": "c"}], "s": "café 中文 😀"},\n',
    '  "stores": [ {"p": "a\\"b"} , {"p": "é"} ]\n',
    "}\n  ",
  ].join("");
  const bytes = new TextEncoder().encode(tricky);
  const whole = JSON.parse(tricky) as Record<string, unknown>;

  test("agrees with JSON.parse at every chunk size, including one byte at a time", () => {
    for (const size of [1, 2, 3, 5, 8, 64, bytes.length]) {
      const scanned = collect(bytes, size, () => true);
      expect(scanned.values.n).toBe(-12.5e3);
      expect(scanned.values.t).toBe(true);
      expect(scanned.values.f).toBe(false);
      expect(scanned.values.z).toBeNull();
      expect(scanned.values["a{"]).toBe(whole["a{"]);
      expect(scanned.values.obj).toEqual(whole.obj);
      expect(scanned.elements.list).toEqual(whole.list as unknown[]);
      expect(scanned.elements.stores).toEqual(whole.stores as unknown[]);
      expect(scanned.counts.empty).toBe(0);
      expect(scanned.counts.list).toBe((whole.list as unknown[]).length);
    }
  });

  test("hands back only the values it was asked for", () => {
    const keys: string[] = [];
    const scanner = new RootObjectScanner({
      wantValue: (key) => key === "n",
      onValue: (key) => keys.push(key),
    });
    scanner.write(bytes);
    scanner.finish();
    expect(keys).toEqual(["n"]);
  });

  test("every proper prefix of the document is rejected, never silently accepted", () => {
    const trimmedEnd = tricky.trimEnd();
    const encoded = new TextEncoder().encode(trimmedEnd);
    for (let length = 0; length < encoded.length; length += 1) {
      const scanner = new RootObjectScanner();
      const attempt = () => {
        scanner.write(encoded.subarray(0, length));
        scanner.finish();
      };
      expect(attempt).toThrow(JsonShapeError);
    }
  });

  test("a cut-off document is flagged as truncated; a malformed one is not", () => {
    const cut = new RootObjectScanner();
    cut.write(new TextEncoder().encode('{"a": [1, 2'));
    let error: unknown;
    try {
      cut.finish();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(JsonShapeError);
    expect((error as JsonShapeError).truncated).toBe(true);

    const malformed = new RootObjectScanner();
    let malformedError: unknown;
    try {
      malformed.write(new TextEncoder().encode('{"a" 1}'));
    } catch (caught) {
      malformedError = caught;
    }
    expect(malformedError).toBeInstanceOf(JsonShapeError);
    expect((malformedError as JsonShapeError).truncated).toBe(false);
  });

  test("rejects a root that is not an object, trailing data, and a missing colon or comma", () => {
    const scan = (text: string) => {
      const scanner = new RootObjectScanner();
      scanner.write(new TextEncoder().encode(text));
      return scanner.finish();
    };
    expect(() => scan("[1, 2]")).toThrow(JsonShapeError);
    expect(() => scan('"text"')).toThrow(JsonShapeError);
    expect(() => scan("<html>not json</html>")).toThrow(JsonShapeError);
    expect(() => scan("{}x")).toThrow(JsonShapeError);
    expect(() => scan('{"a": 1} {"b": 2}')).toThrow(JsonShapeError);
    expect(() => scan('{"a" 1}')).toThrow(JsonShapeError);
    expect(() => scan('{"a": 1 "b": 2}')).toThrow(JsonShapeError);
    expect(() => scan('{"a": [1 2]}')).toThrow(JsonShapeError);
    expect(() => scan('{"a": [1,]}')).toThrow(JsonShapeError);
    expect(() => scan("{1: 2}")).toThrow(JsonShapeError);
    expect(scan("{}").elementCounts.size).toBe(0);
  });

  test("refuses a single value larger than the capture limit", () => {
    const handlers: RootScanHandlers = {
      wantElements: () => true,
      onElement: () => undefined,
      maxCaptureBytes: 64,
    };
    const big = new TextEncoder().encode(`{"stores": [{"x": "${"y".repeat(200)}"}]}`);
    const scanner = new RootObjectScanner(handlers);
    expect(() => scanner.write(big)).toThrow("larger than 64 bytes");
  });
});

describe("scanRootObject over a web stream", () => {
  test("reads a stream, reports each chunk, and rejects when the stream ends early", async () => {
    const bytes = fixtureBytes("nm000118");
    const chunksOf = (data: Uint8Array) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < data.length; i += 1000)
            controller.enqueue(data.subarray(i, i + 1000));
          controller.close();
        },
      });
    let chunks = 0;
    const result = await scanRootObject(chunksOf(bytes), {}, () => {
      chunks += 1;
    });
    expect(chunks).toBe(Math.ceil(bytes.length / 1000));
    expect(result.elementCounts.get("stores")).toBe(9);

    await expect(scanRootObject(chunksOf(bytes.subarray(0, 4000)))).rejects.toThrow(JsonShapeError);
  });

  test("propagates an error raised by the stream itself", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a": ['));
        controller.error(new Error("connection reset"));
      },
    });
    await expect(scanRootObject(broken)).rejects.toThrow("connection reset");
  });
});

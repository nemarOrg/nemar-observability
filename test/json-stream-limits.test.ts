// The scanner's limits and its error policy, checked at every chunking: a limit
// that only holds when a value happens to arrive in one piece is no limit.

import { describe, expect, test } from "bun:test";
import {
  JsonShapeError,
  RootObjectScanner,
  type RootScanHandlers,
  StreamReadError,
  scanRootObject,
} from "../scripts/lib/json-stream";

const encode = (text: string) => new TextEncoder().encode(text);

/** Feed `text` to a fresh scanner in chunks of `size` bytes and finish it. */
function scan(text: string, size: number, handlers: RootScanHandlers = {}) {
  const bytes = encode(text);
  const scanner = new RootObjectScanner(handlers);
  for (let i = 0; i < bytes.length; i += size) scanner.write(bytes.subarray(i, i + size));
  return scanner.finish();
}

const CHUNK_SIZES = [1, 2, 3, 7, 100, 10_000];

describe("repeated root keys", () => {
  test("are refused wherever the repeat falls, at every chunk size", () => {
    const documents = [
      '{"a":1,"a":2}',
      '{"stores":[],"x":{"y":1},"stores":[1]}',
      '{"a":[1,2],"b":"text","a":[3]}',
      '{ "k" : 1 , "k" : 1 }',
    ];
    for (const text of documents) {
      for (const size of CHUNK_SIZES) {
        expect(() => scan(text, size)).toThrow("repeats the key");
      }
    }
  });

  test("a key repeated inside a nested object is not a root repeat", () => {
    expect(() => scan('{"a":{"x":1,"x":2},"b":[{"x":1},{"x":2}]}', 3)).not.toThrow();
  });

  test("an escaped spelling of the same key is the same key", () => {
    expect(() => scan('{"a":1,"\\u0061":2}', 5)).toThrow("repeats the key");
  });

  test("more distinct root keys than allowed are refused", () => {
    const keys = Array.from({ length: 11 }, (_, i) => `"k${i}":1`).join(",");
    expect(() => scan(`{${keys}}`, 4, { maxRootKeys: 10 })).toThrow("more than 10 keys");
    expect(() => scan(`{${keys}}`, 4, { maxRootKeys: 11 })).not.toThrow();
  });

  test("a key that is absurdly long is refused", () => {
    expect(() => scan(`{"${"k".repeat(2000)}":1}`, 64)).toThrow("too long");
  });
});

describe("maxCaptureBytes", () => {
  // The element is the string "xxx...x"; its raw text includes the two quotes.
  const element = (length: number) => `"${"x".repeat(length - 2)}"`;
  const document = (length: number) => `{"stores":[${element(length)}]}`;
  const wanted = (cap: number): RootScanHandlers => ({
    wantElements: () => true,
    onElement: () => {},
    maxCaptureBytes: cap,
  });

  test("an element exactly at the cap is read and one byte over is refused, at every chunk size", () => {
    for (const size of [...CHUNK_SIZES, 49, 50, 51]) {
      expect(() => scan(document(50), size, wanted(50))).not.toThrow();
      expect(() => scan(document(51), size, wanted(50))).toThrow("larger than 50 bytes");
    }
  });

  test("an element that is not wanted is never buffered, so no cap applies to it", () => {
    for (const size of CHUNK_SIZES) {
      expect(() =>
        scan(document(5_000), size, { wantElements: () => false, maxCaptureBytes: 50 }),
      ).not.toThrow();
    }
  });

  test("a wanted scalar root value is capped the same way", () => {
    const text = `{"v":"${"y".repeat(100)}"}`;
    for (const size of CHUNK_SIZES) {
      expect(() =>
        scan(text, size, { wantValue: () => true, onValue: () => {}, maxCaptureBytes: 50 }),
      ).toThrow("larger than 50 bytes");
    }
  });
});

describe("maxDepth", () => {
  // `{"a":[[[[1]]]]}`: the root is depth 1, the array a is depth 2, then three more levels.
  const nested = (levels: number) => `{"a":${"[".repeat(levels)}1${"]".repeat(levels)}}`;

  test("accepts exactly the depth allowed and refuses one more, at every chunk size", () => {
    for (const size of CHUNK_SIZES) {
      expect(() => scan(nested(4), size, { maxDepth: 5 })).not.toThrow();
      expect(() => scan(nested(5), size, { maxDepth: 5 })).toThrow("nests deeper than 5 levels");
    }
  });

  test("applies to objects as well as arrays, and to values nobody asked for", () => {
    const objects = `{"a":${'{"b":'.repeat(6)}1${"}".repeat(6)}}`;
    for (const size of CHUNK_SIZES) {
      expect(() => scan(objects, size, { maxDepth: 5 })).toThrow("nests deeper");
    }
    expect(() => scan(nested(4), 3, { maxDepth: 5, wantElements: () => false })).not.toThrow();
  });

  test("brackets inside strings do not count", () => {
    expect(() => scan(`{"a":"${"[".repeat(100)}"}`, 7, { maxDepth: 2 })).not.toThrow();
  });
});

describe("scanRootObject error policy", () => {
  const streamOf = (text: string, fail?: Error) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode(text));
        if (fail) controller.error(fail);
        else controller.close();
      },
    });

  test("a failing stream is a StreamReadError carrying the original error", async () => {
    const failure = new Error("connection reset");
    const error = await scanRootObject(streamOf('{"a":[', failure)).catch((e) => e);
    expect(error).toBeInstanceOf(StreamReadError);
    expect(error.original).toBe(failure);
    expect(error.message).toBe("connection reset");
  });

  test("a handler that throws, or content that is wrong, is not a StreamReadError", async () => {
    const bug = new TypeError("handler bug");
    const fromHandler = await scanRootObject(streamOf('{"a":[1]}'), {
      wantElements: () => true,
      onElement: () => {
        throw bug;
      },
    }).catch((e) => e);
    expect(fromHandler).toBe(bug);
    expect(fromHandler).not.toBeInstanceOf(StreamReadError);

    const shape = await scanRootObject(streamOf("[1]")).catch((e) => e);
    expect(shape).toBeInstanceOf(JsonShapeError);
    expect(shape).not.toBeInstanceOf(StreamReadError);
  });

  test("the chunk callback sees each chunk's size, and what it throws stops the scan", async () => {
    const text = '{"a":[1,2,3]}';
    const sizes: number[] = [];
    await scanRootObject(streamOf(text), {}, (bytes) => sizes.push(bytes));
    expect(sizes).toEqual([text.length]);

    const stopped = await scanRootObject(streamOf(text), {}, () => {
      throw new RangeError("byte cap");
    }).catch((e) => e);
    expect(stopped).toBeInstanceOf(RangeError);
  });
});

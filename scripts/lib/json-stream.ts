// A streaming structural scanner for one very large JSON object, used by the
// Zarr recordings collector (push-zarr-recordings.ts). Dependency-free, so it
// runs from a bare checkout without `bun install`.
//
// Why it exists: a Zarr `index.json` can be over 300 MB (nm000229, whose 163
// recordings carry about 2 MB of event metadata each). `JSON.parse` needs the
// whole text plus the whole object graph in memory, which is a gigabyte-scale
// peak on a shared 8 GB host. The scanner instead walks the bytes as they
// arrive and hands the caller one array element at a time, so memory stays at
// one element (a few MB) plus the stream's chunk buffer, whatever the file size.
//
// It is not a validator. It tracks only strings, escapes and bracket depth to
// find where each root-level value and each element of a root-level array begin
// and end; the text of the values the caller asks for is returned for the
// caller to `JSON.parse`, which does the real validation of everything that is
// used. Structural damage (truncation, trailing data, a non-object root) is
// reported as a JsonShapeError.

/**
 * The document is not the single JSON object this scanner reads, or it is cut
 * short. `truncated` marks the cut-short case, which a caller may treat as a
 * transient transfer fault and retry; every other shape error is permanent.
 */
export class JsonShapeError extends Error {
  constructor(
    message: string,
    readonly truncated = false,
  ) {
    super(message);
  }
}

export type RootScanHandlers = {
  /** Root-level keys whose raw JSON text is wanted through `onValue`. */
  wantValue?: (key: string) => boolean;
  /** Raw JSON text of a wanted root-level value that is not an array. */
  onValue?: (key: string, rawJson: string) => void;
  /** Whether the elements of the root-level array `key` are wanted as raw bytes. */
  wantElements?: (key: string) => boolean;
  /** One completed element of root-level array `key`; `raw` is null when not wanted. */
  onElement?: (key: string, raw: Uint8Array | null) => void;
  /** Largest raw value or element, in bytes, the scanner will buffer. Default 64 MiB. */
  maxCaptureBytes?: number;
};

export type RootScanResult = {
  /** Number of elements seen in each root-level array, wanted or not. */
  elementCounts: Map<string, number>;
};

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;
const MINUS = 0x2d;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const LOWER_T = 0x74;
const LOWER_F = 0x66;
const LOWER_N = 0x6e;

const BEFORE_ROOT = 0;
const KEY_OR_END = 1;
const KEY = 2;
const IN_KEY = 3;
const AFTER_KEY = 4;
const VALUE = 5;
const ROOT_STRING = 6;
const ROOT_LITERAL = 7;
const ROOT_CONTAINER = 8;
const AFTER_VALUE = 9;
const ARRAY_FIRST = 10;
const ARRAY_NEXT = 11;
const ARRAY_AFTER = 12;
const ELEMENT_CONTAINER = 13;
const ELEMENT_STRING = 14;
const ELEMENT_LITERAL = 15;
const DONE = 16;

const DEFAULT_MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function startsLiteral(byte: number): boolean {
  return (
    byte === MINUS ||
    (byte >= DIGIT_0 && byte <= DIGIT_9) ||
    byte === LOWER_T ||
    byte === LOWER_F ||
    byte === LOWER_N
  );
}

/**
 * Feed bytes with `write` in any chunking, then call `finish`. Every chunk
 * boundary is legal, including one in the middle of a string, an escape, or a
 * multi-byte character: the scanner keeps its state between calls.
 */
export class RootObjectScanner {
  private state = BEFORE_ROOT;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private key = "";
  private arrayKey = "";
  private wantArrayElements = false;
  private capturing = false;
  private captureStart = 0;
  private captureParts: Uint8Array[] = [];
  private captureSize = 0;
  private readonly maxCapture: number;
  private readonly counts = new Map<string, number>();

  constructor(private readonly handlers: RootScanHandlers = {}) {
    this.maxCapture = handlers.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  }

  write(chunk: Uint8Array): void {
    const length = chunk.length;
    if (this.capturing) this.captureStart = 0;
    let i = 0;
    while (i < length) {
      const byte = chunk[i];
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
        } else if (byte === BACKSLASH) {
          this.escaped = true;
        } else if (byte === QUOTE) {
          this.inString = false;
          this.stringEnded(chunk, i + 1);
        }
        i += 1;
        continue;
      }
      switch (this.state) {
        case BEFORE_ROOT:
          if (isWhitespace(byte)) break;
          if (byte !== OPEN_BRACE) throw new JsonShapeError("the document is not a JSON object");
          this.depth = 1;
          this.state = KEY_OR_END;
          break;
        case KEY_OR_END:
          if (isWhitespace(byte)) break;
          if (byte === CLOSE_BRACE) {
            this.depth = 0;
            this.state = DONE;
            break;
          }
          this.startKey(chunk, i, byte);
          break;
        case KEY:
          if (isWhitespace(byte)) break;
          this.startKey(chunk, i, byte);
          break;
        case AFTER_KEY:
          if (isWhitespace(byte)) break;
          if (byte !== COLON) throw new JsonShapeError("expected ':' after an object key");
          this.state = VALUE;
          break;
        case VALUE:
          if (isWhitespace(byte)) break;
          this.startRootValue(chunk, i, byte);
          break;
        case ROOT_LITERAL:
          if (isWhitespace(byte) || byte === COMMA || byte === CLOSE_BRACE) {
            this.endRootValue(chunk, i);
            continue; // reprocess the delimiter in AFTER_VALUE
          }
          break;
        case ROOT_CONTAINER:
          if (byte === QUOTE) {
            this.inString = true;
          } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
            this.depth += 1;
          } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
            this.depth -= 1;
            if (this.depth === 1) this.endRootValue(chunk, i + 1);
          }
          break;
        case AFTER_VALUE:
          if (isWhitespace(byte)) break;
          if (byte === COMMA) this.state = KEY;
          else if (byte === CLOSE_BRACE) {
            this.depth = 0;
            this.state = DONE;
          } else throw new JsonShapeError("expected ',' or '}' after an object value");
          break;
        case ARRAY_FIRST:
          if (isWhitespace(byte)) break;
          if (byte === CLOSE_BRACKET) {
            this.endArray();
            break;
          }
          this.startElement(chunk, i, byte);
          break;
        case ARRAY_NEXT:
          if (isWhitespace(byte)) break;
          this.startElement(chunk, i, byte);
          break;
        case ARRAY_AFTER:
          if (isWhitespace(byte)) break;
          if (byte === COMMA) this.state = ARRAY_NEXT;
          else if (byte === CLOSE_BRACKET) this.endArray();
          else throw new JsonShapeError("expected ',' or ']' after an array element");
          break;
        case ELEMENT_LITERAL:
          if (isWhitespace(byte) || byte === COMMA || byte === CLOSE_BRACKET) {
            this.endElement(chunk, i);
            continue; // reprocess the delimiter in ARRAY_AFTER
          }
          break;
        case ELEMENT_CONTAINER:
          if (byte === QUOTE) {
            this.inString = true;
          } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
            this.depth += 1;
          } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
            this.depth -= 1;
            if (this.depth === 2) this.endElement(chunk, i + 1);
          }
          break;
        case DONE:
          if (!isWhitespace(byte))
            throw new JsonShapeError("unexpected data after the root object");
          break;
        default:
          throw new JsonShapeError("scanner reached an invalid state");
      }
      i += 1;
    }
    if (this.capturing) this.keepCaptured(chunk, this.captureStart, length);
  }

  /** Call once after the last chunk; throws if the document did not end cleanly. */
  finish(): RootScanResult {
    if (this.state !== DONE) {
      throw new JsonShapeError("the JSON document ends early (truncated)", true);
    }
    return { elementCounts: this.counts };
  }

  private startKey(chunk: Uint8Array, i: number, byte: number): void {
    if (byte !== QUOTE) throw new JsonShapeError("expected a string object key");
    this.beginCapture(i);
    this.inString = true;
    this.state = IN_KEY;
    void chunk;
  }

  private startRootValue(chunk: Uint8Array, i: number, byte: number): void {
    const wanted = this.handlers.wantValue?.(this.key) ?? false;
    if (byte === OPEN_BRACKET) {
      this.arrayKey = this.key;
      this.wantArrayElements = this.handlers.wantElements?.(this.key) ?? false;
      if (!this.counts.has(this.key)) this.counts.set(this.key, 0);
      this.depth = 2;
      this.state = ARRAY_FIRST;
      return;
    }
    if (byte === OPEN_BRACE) {
      this.depth = 2;
      this.state = ROOT_CONTAINER;
    } else if (byte === QUOTE) {
      this.inString = true;
      this.state = ROOT_STRING;
    } else if (startsLiteral(byte)) {
      this.state = ROOT_LITERAL;
    } else {
      throw new JsonShapeError("expected a JSON value after ':'");
    }
    if (wanted) this.beginCapture(i);
    void chunk;
  }

  private startElement(chunk: Uint8Array, i: number, byte: number): void {
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      this.depth = 3;
      this.state = ELEMENT_CONTAINER;
    } else if (byte === QUOTE) {
      this.inString = true;
      this.state = ELEMENT_STRING;
    } else if (startsLiteral(byte)) {
      this.state = ELEMENT_LITERAL;
    } else {
      throw new JsonShapeError("expected an array element");
    }
    if (this.wantArrayElements) this.beginCapture(i);
    void chunk;
  }

  /** A string closed at `end` (exclusive); what it was depends on the state. */
  private stringEnded(chunk: Uint8Array, end: number): void {
    switch (this.state) {
      case IN_KEY: {
        const raw = this.endCapture(chunk, end);
        try {
          this.key = JSON.parse(new TextDecoder().decode(raw)) as string;
        } catch {
          throw new JsonShapeError("an object key is not valid JSON");
        }
        this.state = AFTER_KEY;
        break;
      }
      case ROOT_STRING:
        this.endRootValue(chunk, end);
        break;
      case ELEMENT_STRING:
        this.endElement(chunk, end);
        break;
      default:
        break; // a string inside a nested value
    }
  }

  private endRootValue(chunk: Uint8Array, end: number): void {
    if (this.capturing) {
      const raw = this.endCapture(chunk, end);
      this.handlers.onValue?.(this.key, new TextDecoder().decode(raw));
    }
    this.state = AFTER_VALUE;
  }

  private endElement(chunk: Uint8Array, end: number): void {
    const raw = this.capturing ? this.endCapture(chunk, end) : null;
    this.counts.set(this.arrayKey, (this.counts.get(this.arrayKey) ?? 0) + 1);
    this.handlers.onElement?.(this.arrayKey, raw);
    this.state = ARRAY_AFTER;
  }

  private endArray(): void {
    this.depth = 1;
    this.state = AFTER_VALUE;
  }

  private beginCapture(start: number): void {
    this.capturing = true;
    this.captureStart = start;
    this.captureParts = [];
    this.captureSize = 0;
  }

  /** Keep a copy of chunk[start, end): the stream may reuse or free its buffers. */
  private keepCaptured(chunk: Uint8Array, start: number, end: number): void {
    if (end <= start) return;
    this.captureSize += end - start;
    if (this.captureSize > this.maxCapture) {
      throw new JsonShapeError(`a JSON value is larger than ${this.maxCapture} bytes`);
    }
    this.captureParts.push(chunk.slice(start, end));
  }

  private endCapture(chunk: Uint8Array, end: number): Uint8Array {
    this.keepCaptured(chunk, this.captureStart, end);
    this.capturing = false;
    const parts = this.captureParts;
    this.captureParts = [];
    if (parts.length === 1) return parts[0];
    const joined = new Uint8Array(this.captureSize);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    return joined;
  }
}

/**
 * Scan a whole byte stream (for example a `fetch` response body). `onChunk` is
 * called after each chunk arrives, so a caller can run an idle timeout.
 */
export async function scanRootObject(
  stream: ReadableStream<Uint8Array>,
  handlers: RootScanHandlers = {},
  onChunk?: () => void,
): Promise<RootScanResult> {
  const scanner = new RootObjectScanner(handlers);
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      scanner.write(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return scanner.finish();
}

// Shared helpers for the Zarr recordings collector tests: the real index
// fixtures, a local HTTP server that serves them the way S3 does (ETag,
// conditional GET, 403 for a missing key), and a local copy of the public
// catalog's paging. These are network-behavior stand-ins only: every byte the
// collector's own code reads is a real recorded index.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const DIR = new URL("../fixtures/zarr-index/", import.meta.url);

/** Raw bytes of a committed real index (or trimmed real index) fixture. */
export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`${name}.json`, DIR)));
}

export function fixtureObject(name: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fixtureBytes(name))) as Record<string, unknown>;
}

/** The ids of the committed fixtures, with the dataset each one is a copy of. */
export const FIXTURES = [
  "nm000118",
  "on004457",
  "nm000105",
  "on000117",
  "on005873-trimmed",
  "on006012-trimmed",
  "on005065-trimmed",
] as const;

export const datasetIdOf = (fixture: string): string => fixture.replace(/-trimmed$/, "");

export const etagOf = (body: Uint8Array): string =>
  `"${createHash("md5").update(body).digest("hex")}"`;

export type ServedObject = { body: Uint8Array; etag: string };

export const served = (body: Uint8Array | object): ServedObject => {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
  return { body: bytes, etag: etagOf(bytes) };
};

export type IndexRequest = {
  id: string;
  ifNoneMatch: string | null;
  userAgent: string | null;
  authorization: string | null;
  status: number;
};

export type IndexServer = ReturnType<typeof startIndexServer>;

/**
 * An S3-like index server. `objects` maps a dataset id to what it serves;
 * an id that is absent answers 403 (as the real bucket does for a missing key)
 * unless `missingStatus` says 404. `script` lets a test override one response.
 */
export function startIndexServer(objects: Map<string, ServedObject>) {
  const requests: IndexRequest[] = [];
  const state = {
    missingStatus: 403,
    ignoreConditional: false,
    /** id -> statuses to answer, in order, before serving normally. */
    failures: new Map<string, number[]>(),
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const match = /^\/([a-z0-9]+)\/zarr\/index\.json$/.exec(new URL(request.url).pathname);
      const id = match?.[1] ?? "";
      const record = (status: number) =>
        requests.push({
          id,
          ifNoneMatch: request.headers.get("if-none-match"),
          userAgent: request.headers.get("user-agent"),
          authorization: request.headers.get("authorization"),
          status,
        });
      const queued = state.failures.get(id);
      if (queued && queued.length > 0) {
        const status = queued.shift() as number;
        record(status);
        return new Response("injected failure", { status });
      }
      const object = objects.get(id);
      if (!object) {
        record(state.missingStatus);
        return new Response("<Error><Code>AccessDenied</Code></Error>", {
          status: state.missingStatus,
        });
      }
      if (!state.ignoreConditional && request.headers.get("if-none-match") === object.etag) {
        record(304);
        return new Response(null, { status: 304, headers: { etag: object.etag } });
      }
      record(200);
      return new Response(object.body, {
        headers: { etag: object.etag, "content-type": "application/json" },
      });
    },
  });
  return {
    server,
    state,
    requests,
    url: server.url.href.replace(/\/$/, ""),
    stop: () => server.stop(true),
  };
}

/**
 * A server that promises the whole body and then drops the connection after
 * `cutAt` bytes of it, as a network fault does mid-download. A raw TCP socket,
 * because an HTTP framework would not let a response lie about its length.
 */
export function startDroppingServer(body: Uint8Array, cutAt: number) {
  let connections = 0;
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        connections += 1;
        const head = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nETag: "dropped"\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
        socket.write(head);
        socket.write(body.subarray(0, cutAt));
        socket.end();
      },
    },
  });
  return {
    url: `http://127.0.0.1:${listener.port}`,
    connections: () => connections,
    stop: () => listener.stop(true),
  };
}

export type CatalogRow = {
  dataset_id: string;
  status?: string;
  visibility?: string;
  source_type?: string;
  zarr_status?: string | null;
};

/**
 * A catalog server with the real `GET /datasets` paging contract: `limit`
 * (at most 200), `offset`, and `total_count`. Rows carry the fields of a real
 * catalog row that the collector looks at.
 */
export function startCatalogServer(rows: CatalogRow[]) {
  const seen: { url: string; authorization: string | null; userAgent: string | null }[] = [];
  const state = { failWith: 0 };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({
        url: `${url.pathname}${url.search}`,
        authorization: request.headers.get("authorization"),
        userAgent: request.headers.get("user-agent"),
      });
      if (state.failWith) return new Response("down", { status: state.failWith });
      if (url.pathname !== "/datasets") return new Response("not found", { status: 404 });
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return Response.json({
        datasets: rows.slice(offset, offset + limit).map((row) => ({
          status: "active",
          visibility: "public",
          source_type: "managed",
          zarr_status: "ready",
          ...row,
        })),
        count: Math.min(limit, Math.max(0, rows.length - offset)),
        total_count: rows.length,
        limit,
        offset,
      });
    },
  });
  return {
    server,
    state,
    seen,
    url: server.url.href.replace(/\/$/, ""),
    stop: () => server.stop(true),
  };
}

/** Serve every committed fixture under its dataset id. */
export function allFixtureObjects(): Map<string, ServedObject> {
  return new Map(FIXTURES.map((name) => [datasetIdOf(name), served(fixtureBytes(name))]));
}

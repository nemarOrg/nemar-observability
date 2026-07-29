// A minimal D1Database-shaped adapter over a real bun:sqlite Database. This is
// NOT a mock: it runs the EXACT SQL our worker code issues against a real SQLite
// engine, just behind the D1 prepare/bind/all/first surface. Only the methods
// our code actually calls are implemented (prepare -> bind -> all/first).

import type { Database } from "bun:sqlite";

class D1PreparedStatementShim {
  private boundArgs: unknown[] = [];
  constructor(
    private readonly engine: Database,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): D1PreparedStatementShim {
    this.boundArgs = args;
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const rows = this.engine.query(this.sql).all(...(this.boundArgs as never[])) as T[];
    return { results: rows };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.engine.query(this.sql).get(...(this.boundArgs as never[])) as T | null;
    return row ?? null;
  }

  async run(): Promise<{ success: true }> {
    this.engine.query(this.sql).run(...(this.boundArgs as never[]));
    return { success: true };
  }
}

class D1DatabaseShim {
  constructor(private readonly engine: Database) {}
  prepare(sql: string): D1PreparedStatementShim {
    return new D1PreparedStatementShim(this.engine, sql);
  }
}

/** Wrap a real bun:sqlite Database as a D1Database for the worker code. */
export function asD1(engine: Database): D1Database {
  return new D1DatabaseShim(engine) as unknown as D1Database;
}

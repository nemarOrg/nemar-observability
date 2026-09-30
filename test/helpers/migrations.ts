// Every migration in src/db/migrations, in order, as SQL text. Tests apply all
// of them so a new migration reaches every store a test builds; a test that
// listed files by name would silently run without it.

import { readdirSync } from "node:fs";

const DIR = new URL("../../src/db/migrations/", import.meta.url);

export const MIGRATIONS: string[] = await Promise.all(
  readdirSync(DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => Bun.file(new URL(name, DIR)).text()),
);

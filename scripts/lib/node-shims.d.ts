// The few Node built-ins the nemaring collectors use, typed exactly as used.
// The project compiles with Cloudflare Workers types only (tsconfig `types`),
// which do not declare `node:` modules, and the collectors run under Bun on a
// bare checkout. Bun implements all of these; the signatures below are the
// subset the collectors call.

declare module "node:fs/promises" {
  export function mkdir(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<string | undefined>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
  export function rename(from: string, to: string): Promise<void>;
  export function rm(path: string, options?: { force?: boolean }): Promise<void>;
  export function stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  export function writeFile(path: string, data: string, options?: { mode?: number }): Promise<void>;
}

declare module "node:path" {
  export function join(...segments: string[]): string;
}

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:process" {
  export const pid: number;
  export const argv: string[];
  export const env: Record<string, string | undefined>;
  export function exit(code?: number): never;
}

// Shared SQL fragments + helpers for querying nemar-cli's nemar-db (read-only).
//
// The predicates MUST match the rest of NEMAR so the dashboard's counts agree
// with `GET /admin/stats` and `GET /datasets`:
//   - exclude folded legacy catalog rows: owner_user_id != SYSTEM_USER_ID (-1)
//   - exclude sandbox (xx) datasets
//   - "public" = active + visibility public

/** The folded-catalog sentinel owner (nemar-cli SYSTEM_USER_ID). */
export const SYSTEM_USER_ID = -1;

/** Real, managed datasets (not folded catalog, not sandbox). */
export const MANAGED = `owner_user_id != ${SYSTEM_USER_ID} AND (is_sandbox = 0 OR is_sandbox IS NULL)`;

/** Public, managed, active datasets — the catalog the website shows. */
export const PUBLIC_MANAGED = `${MANAGED} AND status = 'active' AND visibility = 'public'`;

/** Private managed datasets (active). */
export const PRIVATE_MANAGED = `${MANAGED} AND status = 'active' AND visibility = 'private'`;

/** Published = public managed with a concept DOI (these should have an archive). */
export const PUBLISHED = `${PUBLIC_MANAGED} AND concept_doi IS NOT NULL AND concept_doi != ''`;

/** Run a single-column scalar query, returning the number (0 if no row/NULL). */
export async function scalar(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Run a query whose single row is a map of name -> number, returning that map. */
export async function counts<K extends string>(
  db: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<Record<K, number>> {
  const row = (await db
    .prepare(sql)
    .bind(...binds)
    .first()) as Record<K, number> | null;
  return row ?? ({} as Record<K, number>);
}

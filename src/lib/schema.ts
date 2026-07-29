// The MetricSnapshot standard (epic nemarOrg/nemar-cli#695).
//
// One versioned contract every dashboard panel speaks. Built-in sections are
// computed hourly (pull); external pipelines push schema-conformant sections to
// /api/sections/:key (push). Adding a pipeline never requires changing the core.
//
// Zod is the single source of truth: TS types are inferred from it, and the
// push endpoint validates against it at runtime. A hand-mirrored JSON Schema
// lives at src/lib/metric-snapshot.schema.json for non-TS consumers.

import { z } from "zod";

/** Bump only on a breaking change to the snapshot shape. */
export const SCHEMA_VERSION = "1.0" as const;

/** Drives a tile's color. ok=green, warn=amber, error=red, info=neutral. */
export const SeveritySchema = z.enum(["ok", "warn", "error", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

/** A single labelled count in a metric's breakdown (e.g. per-license, per-modality). */
export const BreakdownItemSchema = z.object({
  label: z.string(),
  value: z.number(),
});
export type BreakdownItem = z.infer<typeof BreakdownItemSchema>;

/**
 * One headline metric = a tile. `value` is the number; `total`, when present,
 * is the denominator so the UI can show a percent (value/total). `drilldown`,
 * when present, is the key the admin drill-down endpoint resolves to the list
 * of items behind the number.
 */
export const MetricSchema = z.object({
  /** Stable, namespaced id, e.g. "archive.missing". */
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.number(),
  total: z.number().optional(),
  /** datasets | bytes | percent | count | ... (free-form; UI formats by it). */
  unit: z.string().default("datasets"),
  severity: SeveritySchema.default("info"),
  /** Admin drill-down key; omitted means the tile has no list behind it. */
  drilldown: z.string().optional(),
  breakdown: z.array(BreakdownItemSchema).optional(),
  /** Short tooltip / context line. */
  hint: z.string().optional(),
});
export type Metric = z.infer<typeof MetricSchema>;

/**
 * A group of related metrics from one producer. `source` identifies the
 * producer ("nemar-cli", "access", or a pipeline id like "qa-pipeline").
 */
export const SectionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  source: z.string().min(1),
  metrics: z.array(MetricSchema).min(1),
  /** ISO-8601 of when this section's data was computed/received. */
  updated_at: z.string().datetime(),
});
export type Section = z.infer<typeof SectionSchema>;

/** A built-in section that failed to compute this run (surfaced in the UI). */
export const SectionErrorSchema = z.object({ key: z.string(), error: z.string() });
export type SectionError = z.infer<typeof SectionErrorSchema>;

/** The full snapshot the dashboard renders. */
export const MetricSnapshotSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  generated_at: z.string().datetime(),
  sections: z.array(SectionSchema),
  /** Sections that failed this run; empty/absent when all succeeded. */
  section_errors: z.array(SectionErrorSchema).optional(),
});
export type MetricSnapshot = z.infer<typeof MetricSnapshotSchema>;

/**
 * Reserved keys the cron computes; a pushed section may not shadow these.
 * `sync` stays reserved even though the section is gone: nemar-cli migration
 * 0053 retired the legacy nemar.org datapipeline, and the key should not be
 * recyclable by a pipeline push that would then read as the old sync state.
 */
export const BUILTIN_SECTION_KEYS: ReadonlySet<string> = new Set([
  "datasets",
  "archive",
  "zarr",
  "imports",
  "sync",
  "publication",
  "access",
  "users",
]);

/**
 * Payload a pipeline POSTs to /api/sections/:key (push mode). Same as a Section
 * but `updated_at` is server-stamped, and `source`/`key` are taken from the
 * body (must match the :key path param).
 */
export const SectionIngestSchema = SectionSchema.omit({ updated_at: true });
export type SectionIngest = z.infer<typeof SectionIngestSchema>;

/** Convenience: build a Metric with defaults applied (parse fills unit/severity). */
export function metric(input: z.input<typeof MetricSchema>): Metric {
  return MetricSchema.parse(input);
}

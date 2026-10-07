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
  /**
   * Unit for the `breakdown` values, when it differs from `unit`. A tile whose
   * value counts items can still break down by something else entirely — e.g.
   * "Most read datasets" is a count of datasets broken down by bytes each. A
   * consumer that does not understand this field falls back to `unit`, which
   * only ever mis-formats a bar label.
   */
  breakdown_unit: z.string().optional(),
  /**
   * How to draw the breakdown.
   *
   * "bars" (default) compares categories against each other — a distribution,
   * where the bar IS the information. "ranked" is an ordered top-N list, where
   * the value is printed beside each label and a bar would only restate it;
   * worse, one dominant entry flattens every other bar to an identical stub,
   * so the chart implies "these are all the same" when they are not.
   */
  breakdown_style: z.enum(["bars", "ranked"]).optional(),
  /** Short tooltip / context line. */
  hint: z.string().optional(),
});
export type Metric = z.infer<typeof MetricSchema>;

/**
 * Counts stay inside JavaScript's exact integer range, so sums of valid counts
 * cannot silently lose precision.
 */
const countSchema = z.number().int().safe();

/** Channel counts: at least one, and 100,000 is far beyond any real montage. */
const channelsSchema = z.number().int().min(1).max(100_000);

/**
 * One exact channel count within a modality: how much recorded time was
 * captured with that many channels. Bins are sparse (only counts that occur,
 * so `recordings` is at least 1) and exact, never pre-grouped, so a consumer can
 * apply any "N channels or more" threshold and draw any binning it likes.
 */
export const ChannelHoursBinSchema = z
  .object({
    channels: channelsSchema,
    /**
     * Summed recording time, in hours, of recordings with this channel count.
     * Zero is legal: a recording can be measured and have no duration.
     */
    hours: z.number().finite().nonnegative(),
    recordings: countSchema.positive(),
  })
  .strict();
export type ChannelHoursBin = z.infer<typeof ChannelHoursBinSchema>;

/**
 * Datasets whose largest recording in this modality has exactly `channels`
 * channels. Summing the peaks at or above N gives the exact number of datasets
 * that offer N or more channels, which per-recording bins cannot (a dataset
 * with recordings at 16 and 32 channels would count twice). Peaks are computed
 * over the same recordings as the bins, so every peak has a bin.
 */
export const ChannelHoursDatasetPeakSchema = z
  .object({
    channels: channelsSchema,
    datasets: countSchema.positive(),
  })
  .strict();
export type ChannelHoursDatasetPeak = z.infer<typeof ChannelHoursDatasetPeakSchema>;

/**
 * Plain names only: producers copy modality names from untrusted index files,
 * and the consumers print them. Uniqueness is case-insensitive, so "EEG" and
 * "eeg" are one modality.
 */
const modalityNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/, {
  message: "Modality must be a plain name: a letter, then letters, digits, hyphens or underscores",
});

/** Hours of data by channel count for one modality (EEG, iEEG, MEG, EMG, ...). */
export const ChannelHoursModalitySchema = z
  .object({
    /** Stable key and display name, e.g. "EEG", "iEEG", "MEG", "EMG". Unique per section. */
    modality: modalityNameSchema,
    /**
     * Totals. `hours` and `recordings` are the sums over `bins`, `datasets` is
     * the sum over `dataset_peaks`; the superRefine below enforces all three.
     * Round each bin first, then sum the rounded bins for `hours`: a total
     * rounded from the unrounded sum can drift past the check.
     */
    hours: z.number().finite().nonnegative(),
    recordings: countSchema.nonnegative(),
    datasets: countSchema.nonnegative(),
    /** Strictly ascending by `channels`, so consumers never need to sort. */
    bins: z.array(ChannelHoursBinSchema).min(1).max(1024),
    /** Strictly ascending by `channels`; never empty, because some dataset holds the bins. */
    dataset_peaks: z.array(ChannelHoursDatasetPeakSchema).min(1).max(1024),
  })
  .strict()
  .superRefine((m, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const ascending = (
      key: "bins" | "dataset_peaks",
      items: readonly { channels: number }[],
    ): void => {
      items.forEach((item, index) => {
        const previous = items[index - 1];
        if (previous === undefined) return;
        if (item.channels === previous.channels) {
          issue([key, index, "channels"], "Duplicate channel count");
        } else if (item.channels < previous.channels) {
          issue([key, index, "channels"], "Channel counts must be in ascending order");
        }
      });
    };
    ascending("bins", m.bins);
    ascending("dataset_peaks", m.dataset_peaks);

    let hours = 0;
    let recordings = 0;
    const binRecordings = new Map<number, number>();
    for (const bin of m.bins) {
      hours += bin.hours;
      recordings += bin.recordings;
      binRecordings.set(bin.channels, bin.recordings);
    }
    let datasets = 0;
    m.dataset_peaks.forEach((peak, index) => {
      datasets += peak.datasets;
      const inBin = binRecordings.get(peak.channels);
      if (inBin === undefined) {
        issue(["dataset_peaks", index, "channels"], "No bin at this channel count");
      } else if (peak.datasets > inBin) {
        issue(
          ["dataset_peaks", index, "datasets"],
          `${peak.datasets} datasets peak here but the bin holds only ${inBin} recordings`,
        );
      }
    });
    const topBin = Math.max(...m.bins.map((b) => b.channels));
    const topPeak = Math.max(...m.dataset_peaks.map((p) => p.channels));
    if (topPeak !== topBin) {
      issue(
        ["dataset_peaks"],
        `The largest peak (${topPeak} channels) must match the largest bin (${topBin})`,
      );
    }

    if (recordings !== m.recordings) {
      issue(
        ["recordings"],
        `recordings must equal the sum over bins (expected ${recordings}, got ${m.recordings})`,
      );
    }
    if (Math.abs(hours - m.hours) > Math.max(1e-6, m.hours * 1e-9)) {
      issue(["hours"], `hours must equal the sum over bins (expected ${hours}, got ${m.hours})`);
    }
    if (datasets !== m.datasets) {
      issue(
        ["datasets"],
        `datasets must equal the sum over dataset_peaks (expected ${datasets}, got ${m.datasets})`,
      );
    }
  });
export type ChannelHoursModality = z.infer<typeof ChannelHoursModalitySchema>;

/**
 * Recorded hours by channel count, per modality: the payload behind the
 * "hours of data" explorer. Aggregates over public datasets only, so it carries
 * no dataset identifiers. Recordings that converted but lack a duration or a
 * channel count are counted in `recordings_unmeasured` and left out of every
 * bin: unknown is not zero.
 *
 * The nested objects are strict on purpose: an unknown key could be a dataset
 * identifier, and a push carrying one must fail (422) instead of being stored.
 * The cost is that a producer adding a field needs the Worker deployed first.
 * The array and name bounds are headroom; the push endpoint's 1 MB body cap is
 * the effective size limit.
 */
export const ChannelHoursSchema = z
  .object({
    /** Public datasets whose Zarr index was read. */
    datasets_scanned: countSchema.nonnegative(),
    /** Public datasets with a Zarr copy whose index could not be read this run. */
    datasets_unavailable: countSchema.nonnegative(),
    recordings_unmeasured: countSchema.nonnegative(),
    modalities: z.array(ChannelHoursModalitySchema).min(1).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.modalities.forEach((m, index) => {
      const key = m.modality.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["modalities", index, "modality"],
          message: "Duplicate modality",
        });
      }
      seen.add(key);
      if (m.datasets > value.datasets_scanned) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["modalities", index, "datasets"],
          message: `${m.datasets} datasets in this modality exceeds the ${value.datasets_scanned} scanned`,
        });
      }
    });
  });
export type ChannelHours = z.infer<typeof ChannelHoursSchema>;

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
  /**
   * How to arrange this section's tiles.
   *
   * "tiles" (default) is the uniform auto-fill grid every stat section uses.
   * "split" is a wide-left/narrow-right pair for a distribution and its
   * companion list: a 23-bin histogram in a 210px stat-tile column renders
   * 50px bars, and letting it merely span columns leaves the short tiles
   * beside it stretched over a tall empty row. Consumers that don't know this
   * field fall back to the uniform grid, so it can only ever affect layout.
   */
  layout: z.enum(["tiles", "split"]).optional(),
  /**
   * Recorded hours by channel count per modality, for the Zarr "hours of data"
   * explorer. Optional and additive: a consumer that does not know the field
   * ignores it and still renders the section's metrics.
   */
  channel_hours: ChannelHoursSchema.optional(),
});
export type Section = z.infer<typeof SectionSchema>;

/** Strict calendar date (not merely a parseable JS date), interpreted as UTC. */
export const UtcDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Expected a valid YYYY-MM-DD UTC date");

export const DailySeriesSchema = z
  .object({
    key: z.string().min(1).max(128),
    label: z.string().min(1).max(256),
    unit: z.enum(["count", "bytes"]),
    aggregation: z.literal("sum"),
    timezone: z.literal("UTC"),
    coverage_start: UtcDateSchema,
    coverage_end: UtcDateSchema,
    freshness_after_hours: z.number().int().min(1).max(168).default(36),
    points: z
      .array(z.object({ date: UtcDateSchema, value: z.number().finite().nonnegative() }).strict())
      .min(1)
      .max(3660),
  })
  .strict()
  .superRefine((series, ctx) => {
    if (series.coverage_start > series.coverage_end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coverage_end"],
        message: "Must not precede coverage_start",
      });
    }
    const seen = new Set<string>();
    series.points.forEach((point, index) => {
      if (seen.has(point.date))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index, "date"],
          message: "Duplicate daily date",
        });
      seen.add(point.date);
      if (point.date < series.coverage_start || point.date > series.coverage_end) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index, "date"],
          message: "Point outside declared coverage",
        });
      }
    });
  });
export type DailySeries = z.infer<typeof DailySeriesSchema>;

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
  "sizes",
  "imports",
  "sync",
  "publication",
  "access",
  "cf",
  "users",
]);

/**
 * Payload a pipeline POSTs to /api/sections/:key (push mode). Same as a Section
 * but `updated_at` is server-stamped, and `source`/`key` are taken from the
 * body (must match the :key path param).
 */
export const SectionIngestSchema = SectionSchema.omit({ updated_at: true })
  .extend({ daily_series: z.array(DailySeriesSchema).max(16).optional() })
  .superRefine((section, ctx) => {
    const keys = new Set<string>();
    let pointCount = 0;
    section.daily_series?.forEach((series, index) => {
      if (keys.has(series.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["daily_series", index, "key"],
          message: "Duplicate series key",
        });
      }
      keys.add(series.key);
      pointCount += series.points.length;
    });
    if (pointCount > 5000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["daily_series"],
        message: "A section push cannot contain more than 5000 daily points",
      });
    }
  });
export type SectionIngest = z.infer<typeof SectionIngestSchema>;

/** Convenience: build a Metric with defaults applied (parse fills unit/severity). */
export function metric(input: z.input<typeof MetricSchema>): Metric {
  return MetricSchema.parse(input);
}

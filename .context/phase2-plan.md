# Phase 2: Daily usage series and dashboard

Issue: `nemarOrg/nemar-observability#51`

Epic: `nemarOrg/nemar-observability#52`

## Goal

Render anonymous website and storage usage as daily source-backed series, with
day, week, month, and custom date-range views. Preserve the existing public,
credential-free dashboard and keep source measures separate.

## Decisions

- Ingest credentials are a JSON map keyed by section (`OBS_INGEST_TOKENS_JSON`).
  The endpoint-wide legacy secret has no fallback. A token configured for one
  section cannot write another section.
- A section push may include daily series alongside its existing headline
  metrics. Series are additive counts or bytes in UTC; unique people and other
  non-additive values do not enter the chart rollups.
- Store daily series in the observability Worker's own D1, separate from hourly
  snapshots. The public snapshot remains small. A separate read endpoint
  returns only aggregate values, coverage bounds, timezone, and server receipt
  time.
- The browser fetches daily points for the chosen date range and performs
  week/month grouping. A missing day stays unknown; it is not filled with zero,
  and a grouped bucket is shown only when all requested days in that bucket have
  observations.
- Keep the Worker-rendered page and inline client script. Use accessible SVG
  charts without a CDN or browser analytics credential.
- Umami page/event counts and AWS S3 response bytes remain separate series.
  S3's `AWS/S3:BytesDownloaded` series is collected by a separate observability
  follow-up from CloudWatch for bucket `nemar`, filter `EntireBucket`, region
  `us-east-2`. It includes conversion reads and has no caller attribution.
  Cloudflare edge bytes remain a separate measure; no billing reconciliation is
  in scope.

## Definition of done

1. Per-section tokens fail closed when absent or malformed and cannot be used
   across section keys.
2. The push schema validates unique UTC dates, additive non-negative values,
   and declared coverage. Upserts replace overlapping days rather than adding
   repeated hourly collections.
3. The public read API validates date bounds and returns the exact requested
   range with series metadata and daily points, without exposing push tokens or
   private dataset IDs.
4. The dashboard has range and grouping controls, plots each series
   independently, and shows source, UTC coverage, and freshness. Missing
   telemetry is visible as a gap; exact daily or grouped values are available
   in an accessible table and point labels.
5. Real SQLite/D1 integration tests cover migrations, replacement semantics,
   range filtering, and section-token isolation. Typecheck, Biome, and the test
   suite pass.

## Phase agent budget

One Luna implementer in this isolated worktree, followed sequentially by one
fresh security-focused reviewer. The lead owns contract decisions and verifies
the authorization, D1, and rendered-browser paths. Once the review gate passes,
publish the phase PR through the authenticated nemaring GitHub CLI. Do not
deploy or merge until required CI and review checks pass and the owner approves
the production merge.

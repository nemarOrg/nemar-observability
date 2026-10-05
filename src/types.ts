/** Cloudflare Workers bindings for the observability worker. */
export interface Bindings {
  /** nemar-cli's D1, READ-ONLY. SELECT only; never write, never migrate. */
  NEMAR_DB: D1Database;
  /** This worker's own D1: snapshot history + pushed pipeline sections. */
  OBS_DB: D1Database;

  ENVIRONMENT: string;
  /** Base URL of the nemar-cli API (for the /auth/me admin-check delegation). */
  NEMAR_API_BASE: string;
  /** SCCN account id, for the Analytics Engine SQL API URL. */
  CF_ACCOUNT_ID: string;
  /** Analytics Engine dataset name written by nemar-cli's data-plane. */
  AE_DATASET: string;
  /** Analytics Engine dataset the website writes one point to per embed load
   *  (nemar_website_embeds in production, nemar_website_embeds_dev for staging
   *  and previews). Optional: without it the signal viewer entry reports the
   *  third-party view as not configured. */
  EMBED_AE_DATASET?: string;
  /** The website origin dataset links on the page point at: https://nemar.org in
   *  production, https://test.nemar.org for env.dev. Defaults to nemar.org. */
  WEBSITE_BASE_URL?: string;

  /** nemar.org zone id, for the zone GraphQL Analytics API. */
  CF_ZONE_ID: string;

  /** Bearer token (Account Analytics Read) for the AE SQL API. Optional: the
   *  access section degrades to empty when unset. */
  CF_ANALYTICS_TOKEN?: string;
  /** Bearer token (Zone Analytics Read on nemar.org) for the GraphQL Analytics
   *  API. Separate from CF_ANALYTICS_TOKEN because account-level Analytics Read
   *  does NOT grant zone analytics. Optional: the cf section degrades to a
   *  single "unconfigured" metric when unset. */
  CF_ZONE_ANALYTICS_TOKEN?: string;
  /** Self-hosted Umami base URL and website id for range-aware audience metrics.
   *  Both are optional; without either the Umami source reports unconfigured. */
  UMAMI_BASE_URL?: string;
  UMAMI_WEBSITE_ID?: string;
  /** Server-only Umami API key. Install as a Worker secret; never expose it to
   *  the dashboard page or include it in a public API response. */
  UMAMI_API_KEY?: string;
  /** First complete UTC day covered by event instrumentation (recorded unless the visitor has opted out).
   *  This is non-secret deployment configuration and must match the website's
   *  verified production instrumentation date. */
  UMAMI_EVENTS_COVERAGE_START?: string;
  /** JSON object mapping pushed section keys to their dedicated bearer tokens. */
  OBS_INGEST_TOKENS_JSON?: string;
}

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
  /** Bearer token external pipelines present to POST /api/sections/:key. */
  OBS_INGEST_TOKEN?: string;
}

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

  /** Bearer token (Account Analytics Read) for the AE SQL API. Optional: the
   *  access section degrades to empty when unset. */
  CF_ANALYTICS_TOKEN?: string;
  /** Bearer token external pipelines present to POST /api/sections/:key. */
  OBS_INGEST_TOKEN?: string;
}

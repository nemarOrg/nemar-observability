// The website writes nemar_website_embeds (production) and nemar_website_embeds_dev
// (staging and previews). A typo here would not fail: Analytics Engine answers a
// dataset nothing was written to with an empty 200, and the dashboard would show
// "none recorded" forever. So the names are pinned to the website's.

import { describe, expect, test } from "bun:test";

const config = Bun.TOML.parse(
  await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
) as {
  vars: Record<string, string>;
  env: { dev: { vars: Record<string, string> } };
};

describe("wrangler.toml embed datasets", () => {
  test("production reads the website's production dataset", () => {
    expect(config.vars.EMBED_AE_DATASET).toBe("nemar_website_embeds");
  });
  test("env.dev reads the website's dev dataset, not production's", () => {
    expect(config.env.dev.vars.EMBED_AE_DATASET).toBe("nemar_website_embeds_dev");
  });
  test("the access dataset stays separate from the embed dataset", () => {
    expect(config.vars.AE_DATASET).not.toBe(config.vars.EMBED_AE_DATASET);
    expect(config.env.dev.vars.AE_DATASET).not.toBe(config.env.dev.vars.EMBED_AE_DATASET);
  });
});

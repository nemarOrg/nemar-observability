import { describe, expect, test } from "bun:test";
import { renderDashboardPage } from "../src/routes/ui";

describe("public dashboard page", () => {
  test("renders question-led sections and UTC range controls", () => {
    const html = renderDashboardPage();

    expect(html).toContain("How is NEMAR being used?");
    expect(html).toContain('data-range="7"');
    expect(html).toContain('data-range="30"');
    expect(html).toContain('data-range="90"');
    expect(html).toContain('data-range="365"');
    expect(html).toContain('id="range-start"');
    expect(html).toContain('id="range-end"');
    expect(html).toContain('id="grouping"');
    expect(html).toContain("Calendar week");
    expect(html).toContain("Calendar month");
    expect(html).toContain("Where do visitors and requests come from?");
    expect(html).toContain("What is the latest state of datasets and pipelines?");
  });
});

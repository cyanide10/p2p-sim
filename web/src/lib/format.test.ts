import { describe, expect, it } from "vitest";
import { describeQueueLoad, formatPdesMetricValue, pdesMetricLabel } from "./format";

describe("describeQueueLoad", () => {
  it("describes arrival, service and utilisation in human terms", () => {
    expect(describeQueueLoad(2, 4, 0.5)).toBe("~2 requests/s in · service ~4/s · ~50% loaded");
  });

  describe("PDES metric formatting", () => {
    it("uses readable labels with units", () => {
      expect(pdesMetricLabel("mean_delay")).toBe("Mean delay (s)");
      expect(pdesMetricLabel("loss_rate")).toBe("Loss rate (%)");
      expect(pdesMetricLabel("ci95_half_width")).toBe("95% CI half-width");
    });

    it("formats proportions as percentages and null values as placeholders", () => {
      expect(formatPdesMetricValue("loss_rate", 0.125)).toBe("12.50%");
      expect(formatPdesMetricValue("utilization", 0.5)).toBe("50.00%");
      expect(formatPdesMetricValue("mean_delay", null)).toBe("--");
    });

    it("falls back to humanized labels for unknown metrics", () => {
      expect(pdesMetricLabel("custom_metric")).toBe("custom metric");
    });
  });

  it("keeps two meaningful decimals without trailing zeroes", () => {
    expect(describeQueueLoad(1.25, 3, 0.4167)).toBe("~1.25 requests/s in · service ~3/s · ~42% loaded");
  });

  it("returns a placeholder for missing data", () => {
    expect(describeQueueLoad(Number.NaN, 4, 0.5)).toBe("--");
  });
});

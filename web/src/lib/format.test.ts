import { describe, expect, it } from "vitest";
import { describeQueueLoad } from "./format";

describe("describeQueueLoad", () => {
  it("describes arrival, service and utilisation in human terms", () => {
    expect(describeQueueLoad(2, 4, 0.5)).toBe("~2 requests/s in · service ~4/s · ~50% loaded");
  });

  it("keeps two meaningful decimals without trailing zeroes", () => {
    expect(describeQueueLoad(1.25, 3, 0.4167)).toBe("~1.25 requests/s in · service ~3/s · ~42% loaded");
  });

  it("returns a placeholder for missing data", () => {
    expect(describeQueueLoad(Number.NaN, 4, 0.5)).toBe("--");
  });
});

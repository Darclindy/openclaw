import { afterEach, describe, expect, it, vi } from "vitest";

const normalizeModelRefMock = vi.hoisted(() =>
  vi.fn(
    (
      provider: string,
      model: string,
      options?: { allowPluginNormalization?: boolean },
    ): { provider: string; model: string } => ({
      provider,
      model:
        model === "alias-model" && options?.allowPluginNormalization !== false
          ? "normalized-model"
          : model,
    }),
  ),
);

vi.mock("../agents/model-selection.js", () => ({
  normalizeModelRef: normalizeModelRefMock,
}));

import {
  __setGatewayModelPricingForTest,
  clearGatewayModelPricingCacheState,
  getCachedGatewayModelPricing,
} from "./model-pricing-cache-state.js";

describe("model-pricing-cache-state", () => {
  afterEach(() => {
    clearGatewayModelPricingCacheState();
    normalizeModelRefMock.mockClear();
  });

  it("preserves plugin-normalized pricing lookup by default", () => {
    const pricing = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
    __setGatewayModelPricingForTest([
      {
        provider: "demo",
        model: "normalized-model",
        pricing,
      },
    ]);

    expect(getCachedGatewayModelPricing({ provider: "demo", model: "alias-model" })).toEqual(
      pricing,
    );
    expect(
      getCachedGatewayModelPricing({
        provider: "demo",
        model: "alias-model",
        allowPluginNormalization: false,
      }),
    ).toBeUndefined();
  });
});

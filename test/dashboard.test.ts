import { describe, expect, it } from "vitest";
import { DASHBOARD_PATHS, parseVirtualPath, virtualEndpoint } from "../dashboard";

describe("dashboard virtual endpoints", () => {
  it("gives each instance a distinct virtual endpoint URL", () => {
    expect(virtualEndpoint("http://127.0.0.1:38886", "plugin")).toBe("http://127.0.0.1:38886/__claude_copilot/plugin/usage");
    expect(virtualEndpoint("http://127.0.0.1:38886", "1fd3236a0707")).toBe(
      "http://127.0.0.1:38886/__claude_copilot/1fd3236a0707/usage",
    );
  });

  it("extracts the instance id and upstream API path from instance-prefixed paths", () => {
    expect(parseVirtualPath("/plugin/token-usage?period=this_month", "other")).toEqual({
      instance: "plugin",
      path: "/token-usage?period=this_month",
    });
    expect(parseVirtualPath("/1fd3236a0707/token-usage/daily?period=this_month", "plugin")).toEqual({
      instance: "1fd3236a0707",
      path: "/token-usage/daily?period=this_month",
    });
    expect(parseVirtualPath("/1fd3236a0707/usage/copilot", "plugin")).toEqual({
      instance: "1fd3236a0707",
      path: "/usage/copilot",
    });
    expect(parseVirtualPath("/1fd3236a0707/models", "plugin")).toEqual({
      instance: "1fd3236a0707",
      path: "/models",
    });
  });

  it("falls back to the selected instance for legacy unprefixed paths", () => {
    expect(parseVirtualPath("/token-usage?period=this_month", "1fd3236a0707")).toEqual({
      instance: "1fd3236a0707",
      path: "/token-usage?period=this_month",
    });
    expect(parseVirtualPath("/usage", "plugin")).toEqual({
      instance: "plugin",
      path: "/usage",
    });
  });

  it("does not unwrap disallowed or traversal paths", () => {
    const bad = parseVirtualPath("/plugin/admin/config", "plugin");
    expect(DASHBOARD_PATHS.test(bad.path.split("?")[0] ?? "")).toBe(false);
    const traversal = parseVirtualPath("/plugin/../usage", "plugin");
    expect(DASHBOARD_PATHS.test(traversal.path.split("?")[0] ?? "")).toBe(false);
  });
});

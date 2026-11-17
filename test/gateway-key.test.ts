import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addGatewayKey, readGateway, withGatewayKey } from "../gateway-key";

const gateway = { url: "http://127.0.0.1:4567", apiKey: "bbcc-key" };

describe("the gateway key is added on the host, never through bb's provider environment", () => {
  it("reads the URL and key from proxy.json; null before setup", () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-"));
    expect(readGateway(dir)).toBeNull();
    writeFileSync(join(dir, "proxy.json"), JSON.stringify({ port: 4567, apiKey: "bbcc-key", adminKey: "x" }));
    expect(readGateway(dir)).toEqual(gateway);
  });

  it("adds the key to thread and turn commands (params.options) and model listing whose base URL is our copilot-api", () => {
    const start = { jsonrpc: "2.0", id: 1, method: "thread/start", params: { config: { envVars: { ANTHROPIC_BASE_URL: gateway.url, FOO: "1" } } } };
    expect(JSON.parse(withGatewayKey(JSON.stringify(start), gateway)).params.config.envVars).toEqual({
      ANTHROPIC_BASE_URL: gateway.url,
      FOO: "1",
      ANTHROPIC_AUTH_TOKEN: "bbcc-key",
    });
    const turn = { jsonrpc: "2.0", id: 3, method: "turn/start", params: { input: [], options: { model: "x", envVars: { ANTHROPIC_BASE_URL: gateway.url } } } };
    expect(JSON.parse(withGatewayKey(JSON.stringify(turn), gateway)).params.options.envVars.ANTHROPIC_AUTH_TOKEN).toBe("bbcc-key");
    const list = { jsonrpc: "2.0", id: 2, method: "model/list", params: { envVars: { ANTHROPIC_BASE_URL: gateway.url } } };
    expect(JSON.parse(withGatewayKey(JSON.stringify(list), gateway)).params.envVars.ANTHROPIC_AUTH_TOKEN).toBe("bbcc-key");
  });

  it("never sends the key to another base URL, and leaves other lines alone", () => {
    const other = JSON.stringify({ id: 1, method: "thread/start", params: { config: { envVars: { ANTHROPIC_BASE_URL: "https://example.com" } } } });
    expect(withGatewayKey(other, gateway)).toBe(other);
    const plain = JSON.stringify({ id: 3, method: "turn/start", params: { input: [] } });
    expect(withGatewayKey(plain, gateway)).toBe(plain);
    expect(withGatewayKey("not json \"envVars\"", gateway)).toBe("not json \"envVars\"");
    const start = JSON.stringify({ id: 1, method: "thread/start", params: { config: { envVars: { ANTHROPIC_BASE_URL: gateway.url } } } });
    expect(withGatewayKey(start, null)).toBe(start);
  });

  it("sets the bridge's own environment only for our copilot-api", () => {
    const ours: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: gateway.url };
    addGatewayKey(ours, gateway);
    expect(ours.ANTHROPIC_AUTH_TOKEN).toBe("bbcc-key");
    const other: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: "https://example.com" };
    addGatewayKey(other, gateway);
    expect(other.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});

// Answers one copilot-api /token-usage request with copilot-api's own code,
// for another local copilot-api instance. Run by the host entry with
//   COPILOT_API_HOME=<scratch dir>  COPILOT_API_SQLITE_DB_PATH=<snapshot>
// Usage: usage-reader.mjs <pluginDir> <path, e.g. /token-usage/daily?period=this_month>
// Prints the JSON response to stdout.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [pluginDir, rawPath] = process.argv.slice(2);
const dist = join(pluginDir, "node_modules", "@jeffreycao", "copilot-api", "dist");

// The store module has a content hash in its name; find it and map its
// minified export aliases back to the function names.
const NAMES = ["getTokenUsageSummary", "getTokenUsageDailySummary", "getTokenUsageEventsPage", "getTokenUsageSessionsPage"];
let storeFile = null;
let aliases = {};
for (const file of readdirSync(dist)) {
  if (!/^store-.*\.js$/.test(file)) continue;
  const source = readFileSync(join(dist, file), "utf8");
  const exportLine = /export\s*\{([^}]*)\}\s*;?\s*(\/\/.*)?$/m.exec(source.slice(-4000));
  if (!exportLine || !exportLine[1].includes("getTokenUsageSummary as")) continue;
  storeFile = join(dist, file);
  for (const part of exportLine[1].split(",")) {
    const [name, alias] = part.trim().split(/\s+as\s+/);
    if (NAMES.includes(name)) aliases[name] = alias ?? name;
  }
}
if (!storeFile) {
  process.stderr.write("copilot-api token-usage store module not found\n");
  process.exit(2);
}
const store = await import(pathToFileURL(storeFile).href);
const fn = (name) => store[aliases[name]];

// Same query handling as copilot-api's src/routes/token-usage/route.ts.
const PERIODS = new Set(["today", "this_week", "last_7_days", "this_month", "last_30_days", "lifetime"]);
const LEGACY = { day: "today", week: "last_7_days", month: "last_30_days" };
const url = new URL(rawPath, "http://reader");
const period = PERIODS.has(url.searchParams.get("period")) ? url.searchParams.get("period") : (LEGACY[url.searchParams.get("period")] ?? "today");
const positive = (value, fallback) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const page = { period, page: positive(url.searchParams.get("page"), 1), pageSize: positive(url.searchParams.get("page_size"), 20) };

let result;
switch (url.pathname) {
  case "/token-usage":
    result = await fn("getTokenUsageSummary")(period);
    break;
  case "/token-usage/daily":
    result = await fn("getTokenUsageDailySummary")(period);
    break;
  case "/token-usage/events":
    result = await fn("getTokenUsageEventsPage")(page);
    break;
  case "/token-usage/sessions":
    result = await fn("getTokenUsageSessionsPage")(page);
    break;
  default:
    process.stderr.write(`unsupported path ${url.pathname}\n`);
    process.exit(2);
}
process.stdout.write(JSON.stringify(result));
process.exit(0);

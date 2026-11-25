import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { extractPsEnvTail, parseCopilotApiProcess, parsePsPidLines, snapshotDatabase } from "../instances";

const DEFAULT_HOME = "/Users/alex/.local/share/copilot-api";

describe("running copilot-api process parsing", () => {
  it("parses command args and COPILOT_API_HOME from macOS ps -E env tail", () => {
    const args = "/Applications/bb.app/Contents/MacOS/bb /path/copilot-api/dist/main.js start --host 127.0.0.1 --port 63495";
    const env = "ELECTRON_RUN_AS_NODE=1 PATH=/usr/bin COPILOT_API_HOME=/Users/alex/.bb/plugins/claude-copilot/host-data/copilot-api";
    expect(parseCopilotApiProcess(args, env, DEFAULT_HOME)).toEqual({
      home: "/Users/alex/.bb/plugins/claude-copilot/host-data/copilot-api",
      port: 63495,
    });
  });

  it("handles paths with spaces in COPILOT_API_HOME and Linux NUL-delimited environ", () => {
    const args = "node /opt/homebrew/bin/copilot-api start -p 4242";
    expect(
      parseCopilotApiProcess(args, "FOO=1 COPILOT_API_HOME=/Users/alex/Application Support/copilot-api BAR=2", DEFAULT_HOME),
    ).toEqual({
      home: "/Users/alex/Application Support/copilot-api",
      port: 4242,
    });
    expect(
      parseCopilotApiProcess(args, "FOO=1\0COPILOT_API_HOME=/var/lib/copilot api\0BAR=2\0", DEFAULT_HOME),
    ).toEqual({
      home: "/var/lib/copilot api",
      port: 4242,
    });
  });

  it("falls back to defaultHome and port 4141 when omitted", () => {
    expect(parseCopilotApiProcess("node /opt/homebrew/bin/copilot-api start", "", DEFAULT_HOME)).toEqual({
      home: DEFAULT_HOME,
      port: 4141,
    });
  });

  it("ignores env vars when matching copilot-api, start, or --port/-p", () => {
    // Non-copilot-api process whose env happens to contain copilot-api start
    expect(parseCopilotApiProcess("bash -l", "LAST_CMD=copilot-api start --port 4141", DEFAULT_HOME)).toBeNull();
    // Real copilot-api start without --port, whose env contains -p 9999
    expect(parseCopilotApiProcess("node /opt/homebrew/bin/copilot-api start", "OPTS=-p 9999 FOO=bar", DEFAULT_HOME)).toEqual({
      home: DEFAULT_HOME,
      port: 4141,
    });
  });

  it("splits ps -o pid=,command= and strips args prefix from ps -E lines", () => {
    const cmdLine = "node /opt/homebrew/bin/copilot-api start --port 4141";
    const envTail = "HOME=/Users/alex COPILOT_API_HOME=/tmp/custom-home";
    const byPid = parsePsPidLines(`  37808 ${cmdLine}\n  999 bash\n`);
    expect(byPid.get(37808)).toBe(cmdLine);
    expect(extractPsEnvTail(cmdLine, `${cmdLine} ${envTail}`)).toBe(envTail);
    expect(extractPsEnvTail(cmdLine, cmdLine)).toBe("");
    expect(extractPsEnvTail(cmdLine, "different-process FOO=1")).toBe("");
  });
});

describe("snapshotDatabase", () => {
  it("creates a snapshot, reuses fresh snapshots, and removes stale -wal/-shm files on refresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "snapshot-"));
    const source = join(dir, "source.sqlite");
    const target = join(dir, "snapshots", "inst.sqlite");

    const src = new DatabaseSync(source);
    src.exec("CREATE TABLE items (v INTEGER); INSERT INTO items VALUES (1);");
    src.close();

    // Initial snapshot
    expect(await snapshotDatabase(source, target, 30_000)).toBe(target);
    const readCount = (file: string) => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    expect(readCount(target)).toBe(1);

    // Update source, but fresh snapshot is reused within maxAgeMs
    const src2 = new DatabaseSync(source);
    src2.exec("INSERT INTO items VALUES (2);");
    src2.close();
    expect(await snapshotDatabase(source, target, 30_000)).toBe(target);
    expect(readCount(target)).toBe(1);

    // Simulate leftover -wal and -shm files from a previous reader and expire snapshot mtime
    writeFileSync(`${target}-wal`, "stale-wal-bytes");
    writeFileSync(`${target}-shm`, "stale-shm-bytes");
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(target, oldTime, oldTime);

    expect(await snapshotDatabase(source, target, 30_000)).toBe(target);
    expect(existsSync(`${target}-wal`)).toBe(false);
    expect(existsSync(`${target}-shm`)).toBe(false);
    expect(readCount(target)).toBe(2);
  });
});

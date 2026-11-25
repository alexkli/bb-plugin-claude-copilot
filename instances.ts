// Discovery and snapshot helpers for other local copilot-api instances.
import { existsSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export type RunningCopilotApi = { home: string; port: number | null };

const COPILOT_API_RE = /copilot-api/;
const START_SUBCOMMAND_RE = /\sstart(\s|$)/;
const API_HOME_ARG_RE = /(?:^|\s)--api-home[= ](\S+)/;
const PORT_ARG_RE = /(?:^|\s)(?:--port|-p)[= ](\d+)(?=\s|$)/;
const PS_ENV_HOME_RE = /(?:^|\s)COPILOT_API_HOME=(.+?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|$)/;

/** Read COPILOT_API_HOME from either Linux NUL-delimited environ or BSD `ps -E` env tail. */
function envCopilotApiHome(env: string): string | null {
  if (!env) return null;
  if (env.includes("\0")) {
    for (const entry of env.split("\0")) {
      if (entry.startsWith("COPILOT_API_HOME=")) {
        const value = entry.slice("COPILOT_API_HOME=".length).trim();
        return value || null;
      }
    }
    return null;
  }
  const value = PS_ENV_HOME_RE.exec(env)?.[1]?.trim();
  return value || null;
}

/**
 * Parse a running `copilot-api start` process from its command line (`args`)
 * and environment (`env`). Flags are matched strictly against `args` so
 * environment variables cannot trigger false matches or override `--port`.
 */
export function parseCopilotApiProcess(args: string, env: string, fallbackHome: string): RunningCopilotApi | null {
  if (!COPILOT_API_RE.test(args) || !START_SUBCOMMAND_RE.test(args)) return null;
  const apiHome = API_HOME_ARG_RE.exec(args)?.[1] ?? envCopilotApiHome(env) ?? fallbackHome;
  const port = Number(PORT_ARG_RE.exec(args)?.[1] ?? "4141");
  return { home: apiHome, port: Number.isFinite(port) ? port : null };
}

/** Parse `ps ... -o pid=,command=` output into a pid -> command map. */
export function parsePsPidLines(output: string): Map<number, string> {
  const byPid = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    if (Number.isFinite(pid) && command) byPid.set(pid, command);
  }
  return byPid;
}

/**
 * Strip the known `args` prefix (from `ps -o pid=,command=`) off the `ps -E`
 * line so only the environment tail remains.
 */
export function extractPsEnvTail(args: string, argsWithEnv: string): string {
  if (argsWithEnv.startsWith(`${args} `)) return argsWithEnv.slice(args.length + 1);
  return "";
}

/**
 * Create or reuse a consistent standalone snapshot of `sourceDb` at `targetDb`.
 * Removes stale `-wal` and `-shm` sidecar files before swapping the snapshot so
 * a subsequent reader cannot replay WAL frames from an earlier snapshot.
 */
export async function snapshotDatabase(sourceDb: string, targetDb: string, maxAgeMs: number): Promise<string> {
  if (existsSync(targetDb) && Date.now() - statSync(targetDb).mtimeMs < maxAgeMs) return targetDb;
  const dir = dirname(targetDb);
  await mkdir(dir, { recursive: true });
  const temp = `${targetDb}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const { DatabaseSync } = (await import("node:sqlite")) as typeof import("node:sqlite");
  const db = new DatabaseSync(sourceDb, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${temp.replaceAll("'", "''")}'`);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  } finally {
    db.close();
  }
  await Promise.all([rm(`${targetDb}-wal`, { force: true }), rm(`${targetDb}-shm`, { force: true })]);
  await rename(temp, targetDb);
  return targetDb;
}

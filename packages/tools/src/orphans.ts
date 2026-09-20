import { userInfo } from "node:os";
import { basename } from "node:path";
import { capture } from "./proc.js";

export interface Orphan {
  pid: number;
  cpu: number;
  etime: string;
  comm: string;
}

/** A launchd-adopted shell or node process above this is spinning, not finishing up. */
export const ORPHAN_CPU_MIN = 25;

const SPINNERS = new Set(["sh", "bash", "zsh", "node"]);

/**
 * Parses `ps -o pid=,ppid=,pcpu=,etime=,comm=` and keeps what is adopted by launchd (PPID 1),
 * busy, and a shell or node: the signature of a background task's loop outliving its session.
 * Daemons and apps that legitimately hang off launchd are not shells, so they never match.
 */
export function parseOrphans(output: string, minCpu: number = ORPHAN_CPU_MIN): Orphan[] {
  const orphans: Orphan[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const [, pid, ppid, cpu, etime, comm] = match;
    if (ppid !== "1" || Number(cpu) < minCpu || !SPINNERS.has(basename(comm!))) continue;
    orphans.push({ pid: Number(pid), cpu: Number(cpu), etime: etime!, comm: comm! });
  }
  return orphans;
}

export function findOrphans(): Orphan[] | undefined {
  const ps = capture("ps", ["-U", userInfo().username, "-o", "pid=,ppid=,pcpu=,etime=,comm="]);
  return ps.ok ? parseOrphans(ps.stdout) : undefined;
}

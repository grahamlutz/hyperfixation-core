import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect as connectTcp, type Socket } from "node:net";

export interface ExecOptions {
  /** Written to the command's stdin and then closed. SQL goes here, never into argv. */
  input?: string;
}

export interface ExecResult {
  /** `null` when the command was killed by a signal or by `timeoutMs`. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Tunnel {
  /** On 127.0.0.1, already accepting connections. */
  localPort: number;
  close(): Promise<void>;
}

/**
 * Somewhere commands run: the Coolify box over `ssh`, or this machine in a test.
 *
 * `exec` takes an argument array, never a string. Everything it is asked to run carries an app
 * name, a container name or a role name that came from a flag or an API, and the one shape that
 * cannot be talked into a second command is a vector the shell never sees as one token.
 */
export interface Runner {
  exec(command: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  /** Forwards a local port to `127.0.0.1:<remotePort>` on the far side. */
  tunnel(remotePort: number): Promise<Tunnel>;
}

export class RunnerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunnerError";
  }
}

/**
 * What `HF_SSH_HOST` may be: `[user@]host`, and nothing that `ssh` would read as an option.
 *
 * A destination beginning `-o` is `ssh`'s own `-oProxyCommand=…`, which runs whatever it says
 * on *this* machine. The config file is the operator's, but it is also the one place an env
 * override reaches, so the destination is checked rather than trusted.
 */
const SSH_HOST = /^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/;

/**
 * Options every `ssh` invocation carries.
 *
 * `BatchMode=yes` so a missing key fails instead of prompting a non-interactive run for a
 * password; `ControlMaster=no` with `ControlPath=none` so a multiplexed session left over from
 * the operator's own `ssh` cannot silently carry a tunnel that outlives this process, and so a
 * broken master socket cannot wedge provisioning.
 */
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
] as const;

/** The argv `exec` runs, `ssh` excluded — the array the test asserts against. */
export function sshExecArgv(host: string, command: readonly string[]): string[] {
  assertHost(host);
  // `ssh` hands the remote end one string and the login shell splits it, so the array has to be
  // re-quoted for that shell; nothing else in this file ever builds a shell word.
  return ["-T", ...SSH_OPTIONS, host, shellQuote(command)];
}

export function sshTunnelArgv(host: string, localPort: number, remotePort: number): string[] {
  assertHost(host);
  return [
    "-N",
    "-T",
    ...SSH_OPTIONS,
    "-L",
    `${String(localPort)}:127.0.0.1:${String(remotePort)}`,
    host,
  ];
}

/** Single-quotes one word for a POSIX remote shell. */
export function shellQuote(command: readonly string[]): string {
  return command.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" ");
}

export interface SshRunnerOptions {
  /** `HF_SSH_HOST`. */
  host: string;
  /** The `ssh` binary; overridden only by tests that assert the argv. */
  sshPath?: string;
  /** How long to wait for a forwarded port to accept a connection. */
  tunnelReadyTimeoutMs?: number;
}

export const DEFAULT_TUNNEL_READY_TIMEOUT_MS = 10_000;

/** A `Runner` that reaches the box over `ssh`. */
export function createSshRunner(options: SshRunnerOptions): Runner {
  const ssh = options.sshPath ?? "ssh";
  assertHost(options.host);

  return {
    exec: async (command, execOptions) =>
      await spawnCollecting(ssh, sshExecArgv(options.host, command), execOptions),

    tunnel: async (remotePort) => {
      const localPort = await freeLocalPort();
      const child = spawn(ssh, sshTunnelArgv(options.host, localPort, remotePort), {
        stdio: ["ignore", "ignore", "pipe"],
      });

      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

      try {
        await waitForPort(
          localPort,
          options.tunnelReadyTimeoutMs ?? DEFAULT_TUNNEL_READY_TIMEOUT_MS,
          child,
        );
      } catch (cause) {
        child.kill("SIGTERM");
        await exited;
        throw new RunnerError(
          `ssh -L ${String(localPort)}:127.0.0.1:${String(remotePort)} never became ready` +
            (stderr === "" ? "" : `: ${stderr.trim()}`),
          { cause },
        );
      }

      return {
        localPort,
        close: async () => {
          child.kill("SIGTERM");
          await exited;
        },
      };
    },
  };
}

export interface LocalRunnerOptions {
  /** What `tunnel()` reports; the local Postgres a test already has. */
  tunnelPort?: number;
}

export interface LocalRunner extends Runner {
  /** Every argv `exec` was asked for, in order. */
  readonly commands: readonly (readonly string[])[];
  /** Every remote port `tunnel` was asked for, in order. */
  readonly tunnels: readonly number[];
}

/**
 * A `Runner` that runs on this machine and records what it was asked to run.
 *
 * `tunnel()` forwards nothing — it names a port the test already has — so provisioning can be
 * exercised end to end against the test cluster without an `ssh` anywhere in the suite.
 */
export function createLocalRunner(options: LocalRunnerOptions = {}): LocalRunner {
  const commands: (readonly string[])[] = [];
  const tunnels: number[] = [];

  return {
    get commands() {
      return commands;
    },
    get tunnels() {
      return tunnels;
    },
    exec: async (command, execOptions) => {
      commands.push([...command]);
      const [bin, ...args] = command;
      if (bin === undefined) throw new RunnerError("exec was given an empty command");
      return await spawnCollecting(bin, args, execOptions);
    },
    tunnel: async (remotePort) => {
      tunnels.push(remotePort);
      const localPort = options.tunnelPort;
      if (localPort === undefined) {
        throw new RunnerError("this local Runner was not given a tunnelPort");
      }
      return { localPort, close: async () => undefined };
    },
  };
}

async function spawnCollecting(
  bin: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const child = spawn(bin, [...args], { stdio: ["pipe", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  child.stdin?.end(options.input ?? "");

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  });
  return { code, stdout, stderr };
}

/**
 * A port nothing is listening on, by binding one and letting go.
 *
 * Inherently a race — something else on the machine may take it in between — so the ready check
 * below is what actually decides whether the forward came up.
 */
async function freeLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new RunnerError("could not take a local port for the tunnel"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new RunnerError(`ssh exited before the forward on ${String(port)} was ready`);
    }
    if (await canConnect(port)) return;
    if (Date.now() >= deadline) {
      throw new RunnerError(`nothing accepted on 127.0.0.1:${String(port)} within ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let socket: Socket;
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket = connectTcp({ port, host: "127.0.0.1" });
    socket.setTimeout(1_000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

function assertHost(host: string): void {
  if (!SSH_HOST.test(host)) {
    throw new RunnerError(
      `HF_SSH_HOST must match ${SSH_HOST.source}, got ${JSON.stringify(host)}`,
    );
  }
}

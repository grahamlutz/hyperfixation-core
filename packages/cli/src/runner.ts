import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer, connect as connectTcp, type Socket } from "node:net";

export interface ExecOptions {
  /** Written to the command's stdin and then closed. SQL goes here, never into argv. */
  input?: string;
  /**
   * A file **on the far side**, streamed into the command's stdin instead of `input`.
   *
   * How a dump on the box reaches a `pg_restore` that runs inside the Postgres container: the
   * file is the host's and the process is the container's, so nothing but stdin spans the two.
   * Takes precedence over `input`.
   */
  inputFile?: string;
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
  /**
   * Forwards a local port to `<remoteHost>:<remotePort>` as the far side sees it.
   *
   * `remoteHost` defaults to the far side's own loopback; it is an address on a network the far
   * side can route to, which is how a container that publishes nothing is still reachable.
   */
  tunnel(remotePort: number, remoteHost?: string): Promise<Tunnel>;
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
export function sshExecArgv(
  host: string,
  command: readonly string[],
  options: ExecOptions = {},
): string[] {
  assertHost(host);
  // `ssh` hands the remote end one string and the login shell splits it, so the array has to be
  // re-quoted for that shell; nothing else in this file ever builds a shell word. `inputFile`
  // becomes that shell's own `<` redirection, which is the only way a far-side file reaches the
  // stdin of a far-side command without being pulled across the link first.
  const remote =
    options.inputFile === undefined
      ? shellQuote(command)
      : `${shellQuote(command)} < ${shellQuote([options.inputFile])}`;
  return ["-T", ...SSH_OPTIONS, host, remote];
}

export function sshTunnelArgv(
  host: string,
  localPort: number,
  remotePort: number,
  remoteHost: string = TUNNEL_LOOPBACK,
): string[] {
  assertHost(host);
  assertTunnelHost(remoteHost);
  return [
    "-N",
    "-T",
    ...SSH_OPTIONS,
    "-L",
    `${String(localPort)}:${remoteHost}:${String(remotePort)}`,
    host,
  ];
}

/** Where a forward lands when the caller names no host: the far side's own loopback. */
export const TUNNEL_LOOPBACK = "127.0.0.1";

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
      // The redirection is the remote shell's, so `inputFile` is spent building the remote word
      // and must not also be opened on this machine.
      await spawnCollecting(ssh, sshExecArgv(options.host, command, execOptions), {
        ...execOptions,
        inputFile: undefined,
      }),

    tunnel: async (remotePort, remoteHost = TUNNEL_LOOPBACK) => {
      const localPort = await freeLocalPort();
      const child = spawn(ssh, sshTunnelArgv(options.host, localPort, remotePort, remoteHost), {
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
          `ssh -L ${String(localPort)}:${remoteHost}:${String(remotePort)} never became ready` +
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

  const file = options.inputFile === undefined ? undefined : createReadStream(options.inputFile);

  const closed = new Promise<number | null>((resolve, reject) => {
    // A child that exits before reading its stdin (`true`, a refused ssh) makes the write fail with
    // EPIPE; the exit code already says what happened. Any other stdin error is a real failure.
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      file?.destroy();
      if (error.code === "EPIPE") return;
      child.kill();
      reject(error);
    });
    file?.once("error", (cause) => {
      child.kill();
      reject(new RunnerError(`could not read ${String(options.inputFile)} into stdin`, { cause }));
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  });

  if (file === undefined) child.stdin?.end(options.input ?? "");
  else if (child.stdin !== null) file.pipe(child.stdin);

  const code = await closed;
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

/**
 * The far-side end of a `-L` forward, which is a bare address or hostname and nothing else.
 *
 * It arrives from `docker inspect` on the box rather than from the operator, and `-L` takes its
 * three fields colon-separated, so a value carrying a colon or a space would silently become a
 * different forward than the one asked for.
 */
function assertTunnelHost(remoteHost: string): void {
  if (!TUNNEL_HOST.test(remoteHost)) {
    throw new RunnerError(
      `a tunnel's remote host must match ${TUNNEL_HOST.source}, got ${JSON.stringify(remoteHost)}`,
    );
  }
}

const TUNNEL_HOST = /^[A-Za-z0-9._-]+$/;

function assertHost(host: string): void {
  if (!SSH_HOST.test(host)) {
    throw new RunnerError(
      `HF_SSH_HOST must match ${SSH_HOST.source}, got ${JSON.stringify(host)}`,
    );
  }
}

import { describe, expect, it } from "vitest";
import { createLocalRunner, RunnerError, shellQuote, sshExecArgv, sshTunnelArgv } from "./runner.js";

const HOST = "hf@box.example";

describe("the ssh Runner's argv", () => {
  it("passes the command as one re-quoted word, after the batch-mode options", () => {
    expect(sshExecArgv(HOST, ["docker", "exec", "-i", "pg-1", "psql", "-U", "postgres"])).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      HOST,
      "'docker' 'exec' '-i' 'pg-1' 'psql' '-U' 'postgres'",
    ]);
  });

  it("forwards a local port to the far side's loopback", () => {
    expect(sshTunnelArgv(HOST, 54321, 5432)).toEqual([
      "-N",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-L",
      "54321:127.0.0.1:5432",
      HOST,
    ]);
  });

  it("quotes a word the remote shell would otherwise split or run", () => {
    expect(shellQuote(["psql", "-c", "SELECT 'a b'; $(id)"])).toBe(
      `'psql' '-c' 'SELECT '\\''a b'\\''; $(id)'`,
    );
  });

  it("refuses a destination ssh would read as an option", () => {
    expect(() => sshExecArgv("-oProxyCommand=id", ["true"])).toThrow(RunnerError);
  });
});

describe("the local Runner", () => {
  it("runs the command and records every argv it was given", async () => {
    const runner = createLocalRunner();

    const result = await runner.exec([process.execPath, "-e", "process.stdout.write('hi')"]);

    expect(result).toMatchObject({ code: 0, stdout: "hi" });
    expect(runner.commands).toEqual([[process.execPath, "-e", "process.stdout.write('hi')"]]);
  });

  it("writes `input` to the command's stdin", async () => {
    const runner = createLocalRunner();

    const result = await runner.exec([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], {
      input: "SELECT 1",
    });

    expect(result.stdout).toBe("SELECT 1");
  });

  it("reports the exit code of a command that exits without reading its input", async () => {
    const runner = createLocalRunner();

    // Big enough to outrun the pipe buffer, so the write is still in flight when the child is gone.
    const result = await runner.exec([process.execPath, "-e", "process.exit(3)"], {
      input: "x".repeat(4 * 1024 * 1024),
    });

    expect(result.code).toBe(3);
  });

  it("reports the exit code of a shell that never reads a small input", async () => {
    const runner = createLocalRunner();

    const result = await runner.exec(["sh", "-c", "exit 3"], { input: "SELECT 1" });

    expect(result.code).toBe(3);
  });

  it("names the port it was configured with instead of forwarding one", async () => {
    const runner = createLocalRunner({ tunnelPort: 5434 });

    const tunnel = await runner.tunnel(5432);

    expect(tunnel.localPort).toBe(5434);
    expect(runner.tunnels).toEqual([5432]);
    await tunnel.close();
  });
});

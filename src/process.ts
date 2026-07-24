import { spawn, type ChildProcess } from "child_process";
import { identityFor, type Queue } from "./queue";

export type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  gateError: string | null;
};

export type CommandRequest = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  interactive?: boolean;
};

type GateState = {
  gateError: string | null;
  childSignal: NodeJS.Signals | null;
};

/** Runs one local command through the worker's tracked launch gate. */
export async function runTrackedCommand(
  workerKey: string,
  request: CommandRequest,
  queue: Queue,
  label: string
): Promise<CommandResult> {
  const gate = spawn(process.execPath, ["-e", GATE_SOURCE], {
    cwd: request.cwd,
    env: request.env,
    stdio: request.interactive
      ? ["inherit", "inherit", "inherit", "ipc"]
      : ["ignore", "pipe", "pipe", "ipc"]
  });
  const state: GateState = {
    gateError: null,
    childSignal: null
  };
  const ready = waitForReady(gate, state, label);
  const exited = waitForExit(gate, state);
  let tracked = false;

  try {
    await ready;
    if (!gate.pid) throw new Error(`${label} launch gate has no PID`);
    await queue.trackChild(workerKey, await identityFor(gate.pid));
    tracked = true;
    await send(gate, {
      type: "launch",
      command: request.command,
      args: request.args
    });
    return await exited;
  } catch (error) {
    stopGate(gate);
    await exited;
    throw error;
  } finally {
    if (tracked) await queue.trackChild(workerKey, null);
  }
}

/** Runs one read-only local command without worker child tracking. */
export function runCommand(request: CommandRequest): Promise<CommandResult> {
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      gateError: string | null
    ) => {
      if (settled) return;
      settled = true;
      resolvePromise({ code, signal, stdout, stderr, gateError });
    };
    child.once("error", (error) => finish(null, null, error.message));
    child.once("close", (code, signal) => finish(code, signal, null));
  });
}

function waitForReady(
  child: ChildProcess,
  state: GateState,
  label: string
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onMessage = (message: unknown) => {
      if (!isGateMessage(message)) return;
      if (message.type === "ready") {
        cleanup();
        resolvePromise();
      } else if (message.type === "error") {
        state.gateError = message.error;
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(state.gateError || `${label} launch gate exited early`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function waitForExit(
  child: ChildProcess,
  state: GateState
): Promise<CommandResult> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });
  child.on("message", (message: unknown) => {
    if (!isGateMessage(message)) return;
    if (message.type === "error") {
      state.gateError = message.error;
    } else if (message.type === "exit") {
      state.childSignal = message.signal;
    }
  });

  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        code,
        signal: state.childSignal || signal,
        stdout,
        stderr,
        gateError: state.gateError
      });
    };
    child.once("error", (error) => {
      state.gateError ||= error.message;
      finish(null, null);
    });
    child.once("close", finish);
  });
}

function send(
  child: ChildProcess,
  message: { type: "launch"; command: string; args: string[] }
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (!child.connected) {
      reject(new Error("launch gate disconnected before launch"));
      return;
    }
    child.send(message, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

function stopGate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
}

function appendBounded(current: string, chunk: unknown): string {
  return `${current}${String(chunk)}`.slice(-(1024 * 1024));
}

function isGateMessage(
  value: unknown
): value is
  | { type: "ready" }
  | { type: "error"; error: string }
  | { type: "exit"; signal: NodeJS.Signals | null } {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  if (value.type === "ready") return true;
  if (value.type === "exit") {
    return (
      "signal" in value &&
      (value.signal === null || typeof value.signal === "string")
    );
  }
  return (
    value.type === "error" &&
    "error" in value &&
    typeof value.error === "string"
  );
}

const GATE_SOURCE = String.raw`
const { spawn } = require("child_process");

let child = null;
let stopping = false;
let finished = false;

function exit(message, code) {
  if (finished) return;
  finished = true;
  if (process.send) {
    process.send(message, () => process.exit(code));
  } else {
    process.exit(code);
  }
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (!child) {
    process.exit(1);
    return;
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
  child.once("close", () => clearTimeout(timer));
  child.kill("SIGTERM");
}

process.on("disconnect", stop);
process.on("SIGHUP", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

process.on("message", (message) => {
  if (!message || message.type !== "launch" || child) return;
  child = spawn(message.command, message.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", "inherit", "inherit"]
  });
  child.once("error", (error) => {
    exit({ type: "error", error: error.message }, 1);
  });
  child.once("close", (code, signal) => {
    exit(
      { type: "exit", code, signal },
      code === null ? 1 : code
    );
  });
});

if (process.send) process.send({ type: "ready" });
`;

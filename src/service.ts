import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { TextDecoder } from "node:util";
import type { Submission } from "./jobs";
import type { Orchestrator } from "./orchestrator";

export const DEFAULT_SERVICE_PORT = 8787;
export const SERVICE_HOST = "127.0.0.1";

const MAX_BODY_BYTES = 64 * 1024;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const JSON_MEDIA_TYPE =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i;

export type ServiceRuntime = Pick<
  Orchestrator,
  "register" | "drive" | "wake"
>;

export type ServiceHandle = {
  address: {
    host: typeof SERVICE_HOST;
    port: number;
  };
  lifetime: Promise<void>;
  close: () => Promise<void>;
};

export type ServiceOptions = {
  port: number;
  cwd: string;
  diagnostic?: (message: string) => void;
};

type Intake = {
  prompt: string;
  projectHint: string | null;
};

class RequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly closeConnection = false
  ) {
    super(code);
  }
}

class RequestAborted extends Error {}

/** Starts the attached loopback HTTP intake service. */
export async function startService(
  runtime: ServiceRuntime,
  options: ServiceOptions
): Promise<ServiceHandle> {
  assertPort(options.port);
  const diagnostic = options.diagnostic || (() => undefined);
  const server = createServer((request, response) => {
    void handleRequest(runtime, options.cwd, request, response, diagnostic).catch(
      () => {
        diagnostic("Guppi service request failed");
        sendError(response, 500, "registration_failed");
      }
    );
  });

  await listen(server, options.port);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Guppi service did not receive a TCP address");
  }
  const lifetime = serverLifetime(server);

  void runtime.wake().catch(() => {
    diagnostic("Guppi service startup wake failed");
  });

  let closing: Promise<void> | null = null;
  return {
    address: {
      host: SERVICE_HOST,
      port: address.port
    },
    lifetime,
    close: () => {
      closing ||= closeServer(server);
      return closing;
    }
  };
}

async function handleRequest(
  runtime: ServiceRuntime,
  cwd: string,
  request: IncomingMessage,
  response: ServerResponse,
  diagnostic: (message: string) => void
): Promise<void> {
  if (request.url !== "/jobs") {
    sendError(response, 404, "not_found");
    return;
  }
  if (request.method !== "POST") {
    sendError(response, 405, "method_not_allowed", { Allow: "POST" });
    return;
  }
  if (!isJsonContentType(request.headers["content-type"])) {
    sendError(response, 415, "unsupported_media_type");
    return;
  }

  let intake: Intake;
  try {
    intake = parseIntake(await readBody(request));
  } catch (error) {
    if (error instanceof RequestAborted) return;
    if (error instanceof RequestFailure) {
      if (error.closeConnection) closeAfterResponse(request, response);
      sendError(response, error.status, error.code);
      return;
    }
    throw error;
  }

  const submission: Submission = {
    raw: intake.prompt,
    mode: "async",
    projectHint: intake.projectHint,
    cwd
  };
  let jobId: string;
  try {
    jobId = (await runtime.register(submission)).id;
  } catch {
    diagnostic("Guppi service registration failed");
    sendError(response, 500, "registration_failed");
    return;
  }

  void runtime
    .drive(jobId)
    .catch(() => {
      diagnostic(`${jobId}: service drive failed`);
    })
    .then(() => runtime.wake())
    .catch(() => {
      diagnostic(`${jobId}: service follow-up wake failed`);
    });
  sendJson(response, 202, { jobId });
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      return Promise.reject(
        new RequestFailure(413, "payload_too_large", true)
      );
    }
  }

  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        request.pause();
        finish(() =>
          reject(new RequestFailure(413, "payload_too_large", true))
        );
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () =>
      finish(() => resolvePromise(Buffer.concat(chunks, total)));
    const onAborted = () => finish(() => reject(new RequestAborted()));
    const onError = () => finish(() => reject(new RequestAborted()));
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}

function parseIntake(body: Buffer): Intake {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    value = JSON.parse(text);
  } catch {
    throw new RequestFailure(400, "invalid_request");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestFailure(400, "invalid_request");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    !Object.prototype.hasOwnProperty.call(record, "prompt") ||
    keys.some((key) => key !== "prompt" && key !== "projectHint")
  ) {
    throw new RequestFailure(400, "invalid_request");
  }
  if (
    typeof record.prompt !== "string" ||
    !record.prompt.trim() ||
    record.prompt.includes("\0")
  ) {
    throw new RequestFailure(400, "invalid_request");
  }

  const hint = record.projectHint;
  if (hint !== undefined && hint !== null && typeof hint !== "string") {
    throw new RequestFailure(400, "invalid_request");
  }
  if (typeof hint === "string" && hint.includes("\0")) {
    throw new RequestFailure(400, "invalid_request");
  }

  return {
    prompt: record.prompt,
    projectHint: typeof hint === "string" ? hint.trim() || null : null
  };
}

function isJsonContentType(value: string | undefined): boolean {
  return typeof value === "string" && JSON_MEDIA_TYPE.test(value);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  headers: Record<string, string> = {}
): void {
  sendJson(response, status, { error: code }, headers);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: Record<string, string>,
  headers: Record<string, string> = {}
): void {
  if (response.destroyed || response.writableEnded) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": JSON_CONTENT_TYPE,
    "Content-Length": Buffer.byteLength(body).toString(),
    ...headers
  });
  response.end(body);
}

function closeAfterResponse(
  request: IncomingMessage,
  response: ServerResponse
): void {
  response.setHeader("Connection", "close");
  response.once("finish", () => request.destroy());
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolvePromise();
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, SERVICE_HOST);
  });
}

function serverLifetime(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const cleanup = () => {
      server.off("close", onClose);
      server.off("error", onError);
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!server.listening) {
        reject(error);
        return;
      }
      server.close(() => reject(error));
      server.closeAllConnections();
    };
    server.once("close", onClose);
    server.once("error", onError);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("service port must be an integer from 0 to 65535");
  }
}

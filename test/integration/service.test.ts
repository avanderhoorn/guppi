import assert from "node:assert/strict";
import {
  request as httpRequest,
  type IncomingHttpHeaders
} from "node:http";
import test, { type TestContext } from "node:test";
import type { Job, Submission } from "../../src/jobs";
import {
  startService,
  type ServiceHandle,
  type ServiceRuntime
} from "../../src/service";

const JOB_ID = "2026-01-01T00-00-00.000Z-deadbeef";

test("accepts one durable async submission before responding", async (context) => {
  const runtime = new FakeRuntime();
  const registration = deferred<Job>();
  const drive = deferred<Job>();
  runtime.registerImpl = () => registration.promise;
  runtime.driveImpl = () => drive.promise;
  const service = await startTestService(context, runtime);

  let responded = false;
  const responsePromise = send(service, {
    body: JSON.stringify({
      prompt: "  Capture the release idea  ",
      projectHint: "  Alpha  "
    })
  }).then((response) => {
    responded = true;
    return response;
  });
  await waitFor(() => runtime.submissions.length === 1);
  await waitFor(() => runtime.submissions.length === 1);
  assert.equal(responded, false);
  assert.deepEqual(runtime.submissions, [
    {
      raw: "  Capture the release idea  ",
      mode: "async",
      projectHint: "Alpha",
      cwd: "/service/cwd"
    }
  ]);

  registration.resolve(job(runtime.submissions[0]));
  const response = await responsePromise;
  assert.equal(response.status, 202);
  assert.deepEqual(JSON.parse(response.body), { jobId: JOB_ID });
  await waitFor(() => runtime.driveIds.length === 1);
  assert.deepEqual(runtime.driveIds, [JOB_ID]);
  assert.equal(runtime.wakeCalls, 1);
  drive.resolve(job(runtime.submissions[0]));
  await waitFor(() => runtime.wakeCalls === 2);
});

test("rejects invalid endpoints and request bodies without registration", async (context) => {
  const runtime = new FakeRuntime();
  const service = await startTestService(context, runtime);
  const cases: Array<{
    name: string;
    request: RequestOptions;
    status: number;
    error: string;
    allow?: string;
  }> = [
    {
      name: "unknown path",
      request: { path: "/missing", body: "{}" },
      status: 404,
      error: "not_found"
    },
    {
      name: "wrong method",
      request: { method: "GET" },
      status: 405,
      error: "method_not_allowed",
      allow: "POST"
    },
    {
      name: "missing content type",
      request: {
        contentType: null,
        body: JSON.stringify({ prompt: "message" })
      },
      status: 415,
      error: "unsupported_media_type"
    },
    {
      name: "unsupported charset",
      request: {
        contentType: "application/json; charset=iso-8859-1",
        body: JSON.stringify({ prompt: "message" })
      },
      status: 415,
      error: "unsupported_media_type"
    },
    {
      name: "malformed UTF-8",
      request: { body: Buffer.from([0xff]) },
      status: 400,
      error: "invalid_request"
    },
    {
      name: "malformed JSON",
      request: { body: "{" },
      status: 400,
      error: "invalid_request"
    },
    {
      name: "array body",
      request: { body: "[]" },
      status: 400,
      error: "invalid_request"
    },
    {
      name: "null body",
      request: { body: "null" },
      status: 400,
      error: "invalid_request"
    },
    {
      name: "primitive body",
      request: { body: "42" },
      status: 400,
      error: "invalid_request"
    },
    {
      name: "missing prompt",
      request: { body: "{}" },
      status: 400,
      error: "invalid_request"
    },
    {
      name: "non-string prompt",
      request: { body: JSON.stringify({ prompt: 42 }) },
      status: 400,
      error: "invalid_request"
    },
    {
      name: "blank prompt",
      request: { body: JSON.stringify({ prompt: "   " }) },
      status: 400,
      error: "invalid_request"
    },
    {
      name: "unknown field",
      request: {
        body: JSON.stringify({ prompt: "message", project: "Alpha" })
      },
      status: 400,
      error: "invalid_request"
    },
    {
      name: "invalid hint",
      request: {
        body: JSON.stringify({ prompt: "message", projectHint: 42 })
      },
      status: 400,
      error: "invalid_request"
    },
    {
      name: "NUL prompt",
      request: { body: JSON.stringify({ prompt: "bad\0prompt" }) },
      status: 400,
      error: "invalid_request"
    },
    {
      name: "NUL hint",
      request: {
        body: JSON.stringify({ prompt: "message", projectHint: "bad\0hint" })
      },
      status: 400,
      error: "invalid_request"
    }
  ];

  for (const candidate of cases) {
    const response = await send(service, candidate.request);
    assert.equal(response.status, candidate.status, candidate.name);
    assert.deepEqual(
      JSON.parse(response.body),
      { error: candidate.error },
      candidate.name
    );
    if (candidate.allow) {
      assert.equal(response.headers.allow, candidate.allow, candidate.name);
    }
  }
  assert.equal(runtime.submissions.length, 0);
});

test("enforces the raw byte limit for exact, multibyte, and chunked bodies", async (context) => {
  const runtime = new FakeRuntime();
  const service = await startTestService(context, runtime);
  const prefix = '{"prompt":"';
  const suffix = '"}';
  const exact = `${prefix}${"a".repeat(
    64 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
  )}${suffix}`;
  assert.equal(Buffer.byteLength(exact), 64 * 1024);

  const accepted = await send(service, { body: exact });
  assert.equal(accepted.status, 202);
  assert.equal(runtime.submissions.length, 1);

  const multibyte = JSON.stringify({ prompt: "😀".repeat(17_000) });
  assert.ok(Buffer.byteLength(multibyte) > 64 * 1024);
  const multibyteResponse = await send(service, { body: multibyte });
  assert.equal(multibyteResponse.status, 413);
  assert.deepEqual(JSON.parse(multibyteResponse.body), {
    error: "payload_too_large"
  });

  const chunkedResponse = await send(service, {
    chunks: [
      Buffer.alloc(32 * 1024, 0x20),
      Buffer.alloc(32 * 1024 + 1, 0x20)
    ]
  });
  assert.equal(chunkedResponse.status, 413);
  assert.deepEqual(JSON.parse(chunkedResponse.body), {
    error: "payload_too_large"
  });

  const declaredResponse = await send(service, {
    body: "{}",
    contentLength: String(64 * 1024 + 1)
  });
  assert.equal(declaredResponse.status, 413);
  assert.deepEqual(JSON.parse(declaredResponse.body), {
    error: "payload_too_large"
  });
  assert.equal(runtime.submissions.length, 1);
});

test("reports registration and background failures without stopping intake", async (context) => {
  const registrationRuntime = new FakeRuntime();
  registrationRuntime.registerImpl = async () => {
    throw new Error("secret registration detail");
  };
  const registrationDiagnostics: string[] = [];
  const registrationService = await startTestService(
    context,
    registrationRuntime,
    registrationDiagnostics
  );
  const failed = await send(registrationService, {
    body: JSON.stringify({ prompt: "secret prompt" })
  });
  assert.equal(failed.status, 500);
  assert.deepEqual(JSON.parse(failed.body), {
    error: "registration_failed"
  });
  assert.deepEqual(registrationDiagnostics, [
    "Guppi service registration failed"
  ]);
  assert.doesNotMatch(registrationDiagnostics.join("\n"), /secret/);

  const backgroundRuntime = new FakeRuntime();
  backgroundRuntime.wakeImpl = async () => {
    throw new Error("wake detail");
  };
  backgroundRuntime.driveImpl = async () => {
    throw new Error("drive detail");
  };
  const backgroundDiagnostics: string[] = [];
  const backgroundService = await startTestService(
    context,
    backgroundRuntime,
    backgroundDiagnostics
  );
  await waitFor(() =>
    backgroundDiagnostics.includes("Guppi service startup wake failed")
  );

  const accepted = await send(backgroundService, {
    body: JSON.stringify({ prompt: "first prompt" })
  });
  assert.equal(accepted.status, 202);
  await waitFor(() =>
    backgroundDiagnostics.includes(`${JOB_ID}: service drive failed`)
  );
  await waitFor(() =>
    backgroundDiagnostics.includes(
      `${JOB_ID}: service follow-up wake failed`
    )
  );
  const second = await send(backgroundService, {
    body: JSON.stringify({ prompt: "second prompt" })
  });
  assert.equal(second.status, 202);
  assert.doesNotMatch(backgroundDiagnostics.join("\n"), /prompt|detail/);
});

test("does not register an aborted partial body", async (context) => {
  const runtime = new FakeRuntime();
  const service = await startTestService(context, runtime);

  await abortPartialRequest(service);
  await delay(25);
  assert.equal(runtime.submissions.length, 0);
});

test("close is idempotent and resolves service lifetime", async () => {
  const service = await startService(new FakeRuntime(), {
    port: 0,
    cwd: "/service/cwd"
  });
  const first = service.close();
  const second = service.close();
  assert.equal(first, second);
  await first;
  await service.lifetime;
  await service.close();
});

type RequestOptions = {
  path?: string;
  method?: string;
  contentType?: string | null;
  body?: string | Buffer;
  chunks?: Array<string | Buffer>;
  contentLength?: string;
};

type HttpResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
};

class FakeRuntime implements ServiceRuntime {
  readonly submissions: Submission[] = [];
  readonly driveIds: string[] = [];
  wakeCalls = 0;
  registerImpl: (submission: Submission) => Promise<Job> = async (submission) =>
    job(submission);
  driveImpl: (jobId: string) => Promise<Job> = async () =>
    job({
      raw: "message",
      mode: "async",
      projectHint: null,
      cwd: "/service/cwd"
    });
  wakeImpl: () => Promise<void> = async () => undefined;

  async register(submission: Submission): Promise<Job> {
    this.submissions.push(submission);
    return this.registerImpl(submission);
  }

  async drive(jobId: string): Promise<Job> {
    this.driveIds.push(jobId);
    return this.driveImpl(jobId);
  }

  async wake(): Promise<void> {
    this.wakeCalls += 1;
    return this.wakeImpl();
  }
}

function job(submission: Submission): Job {
  return {
    version: 1,
    id: JOB_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    input: {
      ...submission,
      interactiveOwner: null
    },
    status: "queued-router",
    route: null,
    attempts: {
      router: 0,
      project: 0
    },
    error: null
  };
}

async function startTestService(
  context: TestContext,
  runtime: ServiceRuntime,
  diagnostics: string[] = []
): Promise<ServiceHandle> {
  const service = await startService(runtime, {
    port: 0,
    cwd: "/service/cwd",
    diagnostic: (message) => diagnostics.push(message)
  });
  context.after(async () => {
    await service.close();
    await service.lifetime;
  });
  return service;
}

function send(
  service: ServiceHandle,
  options: RequestOptions = {}
): Promise<HttpResponse> {
  const body = options.body;
  const headers: Record<string, string> = {
    Connection: "close"
  };
  if (options.contentType !== null) {
    headers["Content-Type"] = options.contentType || "application/json";
  }
  if (options.contentLength !== undefined) {
    headers["Content-Length"] = options.contentLength;
  }

  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        host: service.address.host,
        port: service.address.port,
        path: options.path || "/jobs",
        method: options.method || "POST",
        agent: false,
        headers
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () =>
          resolvePromise({
            status: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    request.once("error", reject);
    if (options.chunks) {
      for (const chunk of options.chunks) request.write(chunk);
      request.end();
    } else {
      request.end(body);
    }
  });
}

function abortPartialRequest(service: ServiceHandle): Promise<void> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    const request = httpRequest({
      host: service.address.host,
      port: service.address.port,
      path: "/jobs",
      method: "POST",
      agent: false,
      headers: {
        Connection: "close",
        "Content-Type": "application/json",
        "Content-Length": "100"
      }
    });
    request.once("error", finish);
    request.once("close", finish);
    request.once("socket", (socket) => {
      const writePartial = () => {
        request.write('{"prompt":"partial');
        setTimeout(() => request.destroy(), 5);
      };
      if (socket.connecting) socket.once("connect", writePartial);
      else writePartial();
    });
  });
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("condition was not reached");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

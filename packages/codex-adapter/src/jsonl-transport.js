const { TextDecoder } = require("node:util");

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING = 256;

function redactDiagnostic(value) {
  return String(value)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|authorization)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]");
}

function createJsonlTransport({
  process,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxPending = DEFAULT_MAX_PENDING,
  onProtocolError = () => {},
  onDiagnostic = () => {},
  onFrame = () => {}
}) {
  if (!process?.stdin || !process?.stdout || typeof process.on !== "function") {
    throw new TypeError("process must expose stdin, stdout, and event methods");
  }
  if (!Number.isInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new TypeError("maxLineBytes must be a positive integer");
  }
  if (!Number.isInteger(maxPending) || maxPending < 1) {
    throw new TypeError("maxPending must be a positive integer");
  }

  let nextId = 1;
  let inputBuffer = Buffer.alloc(0);
  let closedError = null;
  let processExited = false;
  let processClosed = false;
  let stdoutEnded = false;
  let shutdownPromise = null;
  let acceptingWrites = true;
  let shuttingDown = false;
  let inputDrainScheduled = false;
  let shutdownCheck = () => {};
  const pending = new Map();
  const serverRequests = new Map();
  const settledDynamicToolRequestIds = new Set();
  const duplicatedServerRequestIds = new Set();
  const settledIds = new Set();
  const settledOrder = [];
  const inputLines = [];
  const inputDrainWaiters = new Set();
  const notificationListeners = new Set();
  const serverRequestListeners = new Set();

  function rememberSettled(id) {
    settledIds.add(id);
    settledOrder.push(id);
    if (settledOrder.length > maxPending) {
      settledIds.delete(settledOrder.shift());
    }
  }

  function rejectPending(error) {
    for (const [id, entry] of pending) {
      rememberSettled(id);
      entry.reject(error);
    }
    pending.clear();
  }

  function fail(error) {
    if (closedError) return;
    closedError = error instanceof Error ? error : new Error(String(error));
    rejectPending(closedError);
    serverRequests.clear();
    settledDynamicToolRequestIds.clear();
    duplicatedServerRequestIds.clear();
    onProtocolError(closedError);
  }

  function observeFrame(direction, frame, request = null) {
    try {
      onFrame(Object.freeze({ direction, frame, request }));
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(new Error(`App Server frame observer rejected a protocol frame: schema validation failed: ${detail}`, { cause: error }));
      return false;
    }
  }

  function writeMessage(message, request = null) {
    if (closedError) throw closedError;
    if (!acceptingWrites) throw new Error("App Server transport shut down");
    if (!observeFrame("client_to_provider", message, request)) throw closedError;
    process.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  function handleResponse(message) {
    if (settledIds.has(message.id)) {
      if (shuttingDown) return;
      fail(new Error(`duplicate response ID: ${message.id}`));
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      if (shuttingDown) return;
      fail(new Error(`unknown response ID: ${message.id}`));
      return;
    }
    if (!observeFrame("provider_to_client", message, entry.request)) return;
    pending.delete(message.id);
    rememberSettled(message.id);
    if (Object.hasOwn(message, "error")) {
      const detail = message.error?.message || "App Server returned an error";
      entry.reject(new Error(detail));
      return;
    }
    entry.resolve(message.result);
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      fail(new Error("JSONL message must be an object"));
      return;
    }
    const hasId = Object.hasOwn(message, "id");
    const hasMethod = typeof message.method === "string";
    if (hasId && hasMethod) {
      if (!observeFrame("provider_to_client", message)) return;
      if (serverRequests.has(message.id)
          || (message.method === "item/tool/call" && settledDynamicToolRequestIds.has(message.id))) {
        if (message.method === "item/tool/call" && serverRequests.has(message.id)) {
          duplicatedServerRequestIds.add(message.id);
        }
        onDiagnostic(Object.freeze({
          type: "duplicate_server_request_id",
          message: "duplicate App Server request ID was ignored"
        }));
        return;
      }
      serverRequests.set(message.id, message);
      for (const listener of serverRequestListeners) listener(message);
      return;
    }
    if (hasMethod) {
      if (!observeFrame("provider_to_client", message)) return;
      for (const listener of notificationListeners) listener(message);
      return;
    }
    if (hasId) {
      handleResponse(message);
      return;
    }
    fail(new Error("unrecognized JSONL message shape"));
  }

  function resolveInputDrainWaiters() {
    if (inputDrainScheduled || inputLines.length > 0) return;
    for (const resolve of inputDrainWaiters) resolve();
    inputDrainWaiters.clear();
    shutdownCheck();
  }

  function scheduleInputDrain() {
    if (inputDrainScheduled || inputLines.length === 0) {
      resolveInputDrainWaiters();
      return;
    }
    inputDrainScheduled = true;
    queueMicrotask(() => {
      inputDrainScheduled = false;
      const line = inputLines.shift();
      if (line && !closedError) handleLine(line);
      // Deliberately yield between frames. Resolving a response promise queues its
      // continuation before the next JSONL frame, so adapter correlation state is
      // committed before a coalesced notification/server request is observed.
      scheduleInputDrain();
    });
  }

  function awaitInputDrain() {
    if (!inputDrainScheduled && inputLines.length === 0) return Promise.resolve();
    return new Promise((resolve) => inputDrainWaiters.add(resolve));
  }

  function handleLine(line) {
    if (line.length > maxLineBytes) {
      fail(new Error(`maximum JSONL line size is ${maxLineBytes} bytes`));
      return;
    }
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch (error) {
      fail(new Error("invalid UTF-8 in App Server JSONL", { cause: error }));
      return;
    }
    if (source.endsWith("\r")) source = source.slice(0, -1);
    if (source === "") return;
    let message;
    try {
      message = JSON.parse(source);
    } catch (error) {
      fail(new Error("invalid JSON in App Server JSONL", { cause: error }));
      return;
    }
    handleMessage(message);
  }

  process.stdout.on("data", (chunk) => {
    if (closedError) return;
    inputBuffer = Buffer.concat([inputBuffer, Buffer.from(chunk)]);
    let newlineIndex;
    while ((newlineIndex = inputBuffer.indexOf(0x0a)) !== -1) {
      const line = inputBuffer.subarray(0, newlineIndex);
      inputBuffer = inputBuffer.subarray(newlineIndex + 1);
      inputLines.push(line);
    }
    scheduleInputDrain();
    if (inputBuffer.length > maxLineBytes) {
      fail(new Error(`maximum JSONL line size is ${maxLineBytes} bytes`));
    }
  });
  process.stdout.on("end", () => {
    stdoutEnded = true;
    shutdownCheck();
  });
  process.stdout.on("close", () => {
    stdoutEnded = true;
    shutdownCheck();
  });

  process.stderr?.on("data", (chunk) => {
    onDiagnostic(Object.freeze({
      type: "stderr",
      message: redactDiagnostic(Buffer.from(chunk).toString("utf8")).slice(0, 1000)
    }));
  });

  process.on("error", (error) => {
    fail(new Error(`App Server process error: ${error.message}`, { cause: error }));
  });
  process.on("exit", (code, signal) => {
    processExited = true;
    if (shuttingDown) {
      shutdownCheck();
      return;
    }
    const suffix = signal ? ` signal ${signal}` : ` code ${code}`;
    fail(new Error(`App Server process exited with${suffix}`));
  });
  process.on("close", () => {
    processClosed = true;
    processExited = true;
    shutdownCheck();
  });

  return Object.freeze({
    request(method, params) {
      if (closedError) return Promise.reject(closedError);
      if (typeof method !== "string" || method === "") {
        return Promise.reject(new TypeError("request method must be a non-empty string"));
      }
      if (pending.size >= maxPending) {
        return Promise.reject(
          new Error(`pending request limit ${maxPending} reached`)
        );
      }
      const id = nextId++;
      const frame = { id, method, params };
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, request: frame });
      });
      try {
        writeMessage(frame);
      } catch (error) {
        pending.delete(id);
        return Promise.reject(error);
      }
      return promise;
    },
    notify(method, params) {
      const message = params === undefined ? { method } : { method, params };
      writeMessage(message);
    },
    respond(id, result) {
      const request = serverRequests.get(id);
      if (!request) throw new Error(`unknown server request ID: ${id}`);
      const overridden = request.method === "item/tool/call" && duplicatedServerRequestIds.delete(id);
      const response = overridden
        ? { success: false, contentItems: [{ type: "inputText", text: "dynamic_tool_request_duplicate" }] }
        : result;
      writeMessage({ id, result: response }, request);
      serverRequests.delete(id);
      if (request.method === "item/tool/call") settledDynamicToolRequestIds.add(id);
      return { overridden };
    },
    onNotification(listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onServerRequest(listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      serverRequestListeners.add(listener);
      return () => serverRequestListeners.delete(listener);
    },
    close(reason = "transport closed") {
      fail(new Error(reason));
    },
    shutdown({ timeoutMs = 1500 } = {}) {
      if (shutdownPromise) return shutdownPromise;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
        return Promise.reject(new TypeError("shutdown timeoutMs must be a non-negative integer"));
      }

      shuttingDown = true;
      acceptingWrites = false;
      const shutdownError = new Error("App Server transport shut down");
      rejectPending(shutdownError);

      shutdownPromise = new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const finish = async () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          await awaitInputDrain();
          if (inputBuffer.length > 0) {
            const error = new Error("App Server stdout closed with a truncated JSONL frame");
            fail(error);
            reject(error);
            return;
          }
          if (closedError) {
            reject(closedError);
            return;
          }
          closedError = shutdownError;
          resolve();
        };
        shutdownCheck = () => {
          const streamDrained = !inputDrainScheduled && inputLines.length === 0;
          if ((processClosed || (processExited && stdoutEnded)) && streamDrained) void finish();
        };
        timer = setTimeout(() => {
          if (!processExited && typeof process.kill === "function") {
            try {
              process.kill();
            } catch (error) {
              onDiagnostic(Object.freeze({
                type: "shutdown_kill_error",
                message: String(error?.message || error).slice(0, 1000)
              }));
            }
          }
          shutdownCheck();
          if (settled) return;
          // ChildProcess kill/exit/stdio close is asynchronous on real OS
          // processes. Preserve a short, bounded post-kill drain window instead
          // of declaring failure in the same microtask as kill().
          const postKillDrainMs = Math.max(25, Math.min(timeoutMs || 25, 250));
          timer = setTimeout(() => {
            shutdownCheck();
            if (!settled) {
              settled = true;
              const error = new Error("App Server shutdown drain could not be confirmed");
              closedError = error;
              reject(error);
            }
          }, postKillDrainMs);
        }, timeoutMs);
        try {
          if (!process.stdin.writableEnded && !process.stdin.destroyed) {
            process.stdin.end();
          }
        } catch (error) {
          onDiagnostic(Object.freeze({
            type: "shutdown_stdin_error",
            message: String(error?.message || error).slice(0, 1000)
          }));
        }

        shutdownCheck();
      });
      return shutdownPromise;
    }
  });
}

module.exports = {
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_PENDING,
  createJsonlTransport,
  redactDiagnostic
};

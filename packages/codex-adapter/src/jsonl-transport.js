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
  onDiagnostic = () => {}
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
  let shutdownPromise = null;
  const pending = new Map();
  const settledIds = new Set();
  const settledOrder = [];
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
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  }

  function fail(error) {
    if (closedError) return;
    closedError = error instanceof Error ? error : new Error(String(error));
    rejectPending(closedError);
    onProtocolError(closedError);
  }

  function writeMessage(message) {
    if (closedError) throw closedError;
    process.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  function handleResponse(message) {
    if (settledIds.has(message.id)) {
      fail(new Error(`duplicate response ID: ${message.id}`));
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      fail(new Error(`unknown response ID: ${message.id}`));
      return;
    }
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
      for (const listener of serverRequestListeners) listener(message);
      return;
    }
    if (hasMethod) {
      for (const listener of notificationListeners) listener(message);
      return;
    }
    if (hasId) {
      handleResponse(message);
      return;
    }
    fail(new Error("unrecognized JSONL message shape"));
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
      handleLine(line);
      if (closedError) return;
    }
    if (inputBuffer.length > maxLineBytes) {
      fail(new Error(`maximum JSONL line size is ${maxLineBytes} bytes`));
    }
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
    const suffix = signal ? ` signal ${signal}` : ` code ${code}`;
    fail(new Error(`App Server process exited with${suffix}`));
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
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      try {
        writeMessage({ id, method, params });
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
      writeMessage({ id, result });
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

      if (!closedError) {
        closedError = new Error("App Server transport shut down");
        rejectPending(closedError);
      }

      shutdownPromise = new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          process.off("exit", handleExit);
          resolve();
        };
        const handleExit = () => finish();

        if (!processExited) process.once("exit", handleExit);
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

        if (processExited) {
          finish();
          return;
        }
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
          finish();
        }, timeoutMs);
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

const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");

class FakeAppServerProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.clientMessages = [];
    this.clientBuffer = "";
    this.stdin = new Writable({
      write: (chunk, encoding, callback) => {
        this.clientBuffer += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
        let newline;
        while ((newline = this.clientBuffer.indexOf("\n")) !== -1) {
          const line = this.clientBuffer.slice(0, newline);
          this.clientBuffer = this.clientBuffer.slice(newline + 1);
          if (line !== "") {
            const message = JSON.parse(line);
            this.clientMessages.push(message);
            this.emit("clientMessage", message);
          }
        }
        callback();
      }
    });
  }

  send(message, splitAt = null) {
    const data = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (Number.isInteger(splitAt) && splitAt > 0 && splitAt < data.length) {
      this.stdout.write(data.subarray(0, splitAt));
      this.stdout.write(data.subarray(splitAt));
      return;
    }
    this.stdout.write(data);
  }

  sendRaw(data) {
    this.stdout.write(data);
  }

  writeStderr(value) {
    this.stderr.write(value);
  }

  exit(code = 0, signal = null) {
    this.emit("exit", code, signal);
  }
}

module.exports = {
  FakeAppServerProcess
};

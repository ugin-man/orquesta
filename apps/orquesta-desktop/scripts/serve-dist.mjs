import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectDir = resolve(scriptDir, "..");
const distDir = resolve(projectDir, "dist");
const host = "127.0.0.1";
const port = Number(process.env.ORQUESTA_PREVIEW_PORT ?? 4173);
const shouldOpen = process.argv.includes("--open");

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

if (!existsSync(join(distDir, "index.html"))) {
  console.error("[Orquesta] dist/index.html がありません。配布ZIPをもう一度展開してください。");
  process.exit(1);
}

function openBrowser(url) {
  if (!shouldOpen) return;

  if (process.platform === "win32") {
    execFile("cmd", ["/c", "start", "", url], { windowsHide: true });
    return;
  }

  const command = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(command, [url]);
}

const server = createServer((request, response) => {
  const rawPath = decodeURIComponent((request.url ?? "/").split("?")[0]);
  const requestedPath = rawPath === "/" ? "/index.html" : rawPath;
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = resolve(distDir, `.${safePath.startsWith("/") ? safePath : `/${safePath}`}`);

  if (!filePath.startsWith(distDir)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(distDir, "index.html");
  }

  const contentType = mimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  });
  createReadStream(filePath).pipe(response);
});

server.on("error", (error) => {
  console.error(`[Orquesta] 起動に失敗しました: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log("[Orquesta] UIプレビューを起動しました。");
  console.log(`[Orquesta] ${url}`);
  console.log("[Orquesta] 終了するときは、この画面で Ctrl+C を押してください。");
  openBrowser(url);
});

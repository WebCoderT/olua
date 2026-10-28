/**
 * 构建产物的静态文件服务器（零依赖）
 *
 * 只做三件事：正确的 MIME、禁止缓存、把目录的 / 指到 index.html。
 * 之所以不用 http-server 之类的包：Cocos 构建产物里有 .wasm / .bin / .json，
 * MIME 给错会让 instantiateStreaming 直接失败，这类失败最容易伪装成「引擎加载不出来」。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * 起一个静态服务器
 * @param {string} root 构建产物目录（绝对路径）
 * @param {number} port 端口，0 表示让系统分配
 * @returns {Promise<{server: import('http').Server, port: number, origin: string, close: () => Promise<void>}>}
 */
function serve(root, port = 0) {
  const rootDir = path.resolve(root);
  const server = http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch {
      res.writeHead(400).end("bad uri");
      return;
    }
    if (urlPath.endsWith("/")) urlPath += "index.html";
    const filePath = path.resolve(path.join(rootDir, urlPath));
    // 目录穿越防护
    if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("not found: " + urlPath);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": "no-store",
      });
      fs.createReadStream(filePath).pipe(res);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({
        server,
        port: actual,
        origin: `http://127.0.0.1:${actual}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { serve };

import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import httpProxy from "http-proxy";
import serveHandler from "serve-handler";

const webDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(webDirectory, "out");
const port = Number(process.env.PORT ?? 3000);
const apiPort = Number(process.env.API_PORT ?? 4000);
const apiProxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${apiPort}`,
  changeOrigin: true,
  ws: true,
});

function getApiPath(requestUrl) {
  const url = requestUrl ?? "/";
  const pathname = new URL(url, "http://localhost").pathname;

  if (pathname === "/health" || /^\/socket\.io(?:\/|$)/.test(pathname)) {
    return url;
  }
  if (/^\/control-socket\.io\/relay(?:\/|$)/.test(pathname)) {
    return url.replace(/^\/control-socket\.io\/relay/, "/socket.io");
  }
  return null;
}

apiProxy.on("error", (_error, _request, response) => {
  if (response && typeof response.writeHead === "function") {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end("Control server unavailable");
    return;
  }
  response?.destroy();
});

const server = createServer((request, response) => {
  const apiPath = getApiPath(request.url);
  if (apiPath) {
    request.url = apiPath;
    delete request.headers.origin;
    apiProxy.web(request, response);
    return;
  }

  serveHandler(request, response, { public: outputDirectory }).catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end("Unable to serve dashboard");
  });
});

server.on("upgrade", (request, socket, head) => {
  const apiPath = getApiPath(request.url);
  if (!apiPath || !/^\/socket\.io(?:\/|$)/.test(new URL(apiPath, "http://localhost").pathname)) {
    socket.destroy();
    return;
  }

  request.url = apiPath;
  delete request.headers.origin;
  apiProxy.ws(request, socket, head);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Dashboard listening on port ${port}; control API on port ${apiPort}.`);
});
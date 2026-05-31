import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 3000);

function loadLocalEnv() {
  const envPath = join(rootDir, ".env");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = process.env[key] || value;
  }
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const apiRoutes = [
  [/^\/api\/health\/?$/, "./api/health.js"],
  [/^\/api\/auth\/login\/?$/, "./api/auth/login.js"],
  [/^\/api\/auth\/register\/?$/, "./api/auth/register.js"],
  [/^\/api\/auth\/me\/?$/, "./api/auth/me.js"],
  [/^\/api\/dashboard\/?$/, "./api/dashboard.js"],
  [/^\/api\/checkout\/pix\/?$/, "./api/checkout/pix.js"],
  [/^\/api\/syncpay\/webhook\/?$/, "./api/syncpay/webhook.js"],
  [/^\/api\/payments\/([^/]+)\/?$/, "./api/payments/[identifier].js"],
];

async function handleApi(request, response, pathname) {
  const route = apiRoutes.find(([pattern]) => pattern.test(pathname));
  if (!route) return false;

  const [pattern, modulePath] = route;
  const match = pathname.match(pattern);
  request.query = match?.[1] ? { identifier: decodeURIComponent(match[1]) } : {};

  try {
    const module = await import(pathToFileURL(join(rootDir, modulePath)).href);
    await module.default(request, response);
  } catch (error) {
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        error: error.message || "Erro inesperado na API local.",
        status: 500,
      }),
    );
  }

  return true;
}

function serveStatic(request, response, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const target = resolve(rootDir, `.${normalize(cleanPath)}`);

  if (!target.startsWith(resolve(rootDir))) {
    response.statusCode = 403;
    response.end("Forbidden");
    return;
  }

  if (!existsSync(target) || !statSync(target).isFile()) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", mimeTypes[extname(target).toLowerCase()] || "application/octet-stream");
  response.end(readFileSync(target));
}

loadLocalEnv();

http
  .createServer(async (request, response) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (await handleApi(request, response, pathname)) return;
    serveStatic(request, response, pathname);
  })
  .listen(port, () => {
    console.log(`CloneGo local API running at http://localhost:${port}`);
  });

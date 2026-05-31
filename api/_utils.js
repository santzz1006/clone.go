const allowedLocalOrigins = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://127.0.0.1:5501",
  "http://localhost:5501",
  "http://localhost:3000",
]);

function allowedOrigins() {
  const configuredOrigins = String(process.env.ADMIN_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (process.env.SITE_URL) configuredOrigins.push(process.env.SITE_URL.replace(/\/+$/, ""));
  if (process.env.VERCEL_URL) configuredOrigins.push(`https://${process.env.VERCEL_URL}`);

  return new Set([...allowedLocalOrigins, ...configuredOrigins]);
}

export function setCors(request, response) {
  const origin = request.headers.origin;
  if (origin && (allowedOrigins().has(origin) || origin === "null")) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Admin-Key,x-admin-key");
  response.setHeader("Access-Control-Max-Age", "86400");

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return true;
  }

  return false;
}

export function requireAdminKey(request, response) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    sendJson(response, 500, {
      error: "Variavel ADMIN_API_KEY nao configurada na Vercel.",
      status: 500,
    });
    return false;
  }

  const received = request.headers["x-admin-key"];
  if (received === expected) return true;

  sendJson(response, 401, {
    error: "Chave admin invalida.",
    status: 401,
  });
  return false;
}

export async function readBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

export function sendError(response, error) {
  const status = error.status >= 400 && error.status < 600 ? error.status : 500;
  sendJson(response, status, {
    error: error.message || "Erro inesperado.",
    status,
    details: error.body || error.cause?.message || null,
  });
}

export function requireMethod(request, response, method) {
  if (request.method === method) return true;

  response.setHeader("Allow", method);
  sendJson(response, 405, {
    error: `Metodo ${request.method} nao permitido.`,
    status: 405,
  });
  return false;
}

export function onlyDigits(value = "") {
  return String(value).replace(/\D/g, "");
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function isValidCpf(value = "") {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  const calculateDigit = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(cpf[index]) * (length + 1 - index);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };

  return calculateDigit(9) === Number(cpf[9]) && calculateDigit(10) === Number(cpf[10]);
}

export function validateCustomer(customer = {}) {
  const normalized = {
    name: String(customer.name || "").trim(),
    email: String(customer.email || "").trim().toLowerCase(),
    phone: String(customer.phone || "").trim(),
    cpf: onlyDigits(customer.cpf || customer.document || ""),
  };

  if (!normalized.name) throw validationError("Nome completo e obrigatorio.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) throw validationError("E-mail invalido.");
  if (normalized.cpf.length !== 11) throw validationError("CPF precisa ter 11 digitos.");
  if (!isValidCpf(normalized.cpf)) throw validationError("CPF invalido. Confira os digitos informados.");

  return normalized;
}

export function publicBaseUrl(request) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, "");

  const protocol = request.headers["x-forwarded-proto"] || "https";
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  return `${protocol}://${host}`;
}

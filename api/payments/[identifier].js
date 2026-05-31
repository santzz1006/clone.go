function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function fail(response, error) {
  const status = error.status >= 400 && error.status < 600 ? error.status : 500;
  sendJson(response, status, {
    error: error.message || "Erro inesperado.",
    status,
    details: error.body || null,
  });
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`Variavel ${name} nao configurada na Vercel.`);
    error.status = 500;
    throw error;
  }
  return value;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function syncpayFetch(path, options = {}) {
  const baseUrl = requiredEnv("SYNCPAY_BASE_URL").replace(/\/+$/, "");
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  let response;

  try {
    response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } catch (error) {
    const detail = error.cause?.code || error.cause?.message || error.message;
    const wrapped = new Error(`Nao foi possivel conectar na Syncpay (${detail}).`);
    wrapped.status = 502;
    throw wrapped;
  }

  const body = await readJsonResponse(response);
  if (!response.ok) {
    const detail = body?.message || body?.error || body?.raw || `HTTP ${response.status}`;
    const error = new Error(`Syncpay recusou a requisicao: ${detail}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function getSyncpayToken() {
  const authPath = process.env.SYNCPAY_AUTH_PATH || "/api/partner/v1/auth-token";
  const body = await syncpayFetch(authPath, {
    method: "POST",
    body: JSON.stringify({
      client_id: requiredEnv("SYNCPAY_CLIENT_ID"),
      client_secret: requiredEnv("SYNCPAY_CLIENT_SECRET"),
    }),
  });
  const accessToken = body?.access_token || body?.token || body?.data?.access_token;

  if (!accessToken) {
    const error = new Error("Syncpay nao retornou access_token.");
    error.status = 502;
    throw error;
  }

  return accessToken;
}

function getIdentifier(request) {
  const queryIdentifier = Array.isArray(request.query?.identifier)
    ? request.query.identifier[0]
    : request.query?.identifier;

  if (queryIdentifier) return queryIdentifier;

  const pathname = new URL(request.url || "", "https://local.vercel").pathname;
  return decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
}

function isPaidStatus(payload) {
  const status = String(
    payload?.status ||
      payload?.transaction_status ||
      payload?.payment_status ||
      payload?.data?.status ||
      payload?.data?.transaction_status ||
      "",
  ).toLowerCase();

  return ["paid", "confirmed", "success", "approved", "completed", "liquidated"].includes(status);
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    sendJson(response, 405, { error: `Metodo ${request.method} nao permitido.`, status: 405 });
    return;
  }

  try {
    const identifier = getIdentifier(request);
    if (!identifier) {
      sendJson(response, 400, { error: "Identifier da transacao e obrigatorio.", status: 400 });
      return;
    }

    const token = await getSyncpayToken();
    const transactionPath = process.env.SYNCPAY_TRANSACTION_PATH || "/api/partner/v1/transaction";
    const statusPayload = await syncpayFetch(
      `${transactionPath.replace(/\/+$/, "")}/${encodeURIComponent(identifier)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );
    const paid = isPaidStatus(statusPayload);
    let orderId = null;
    let orderUpdateError = null;

    if (paid) {
      try {
        const { confirmPixPayment } = await import("../../server/supabase.js");
        orderId = await confirmPixPayment(identifier, statusPayload);
      } catch (error) {
        orderUpdateError = error.message || "Nao foi possivel atualizar o pedido no Supabase.";
      }
    }

    sendJson(response, 200, {
      ok: true,
      paid,
      orderId,
      orderUpdateError,
      status: statusPayload,
    });
  } catch (error) {
    fail(response, error);
  }
}

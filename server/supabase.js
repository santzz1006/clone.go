import crypto from "node:crypto";
import { catalog } from "./catalog.js";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variavel ${name} nao configurada.`);
  }
  return value;
}

function supabaseHeaders(extra = {}) {
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
    ...extra,
  };
}

function supabaseUrl(path) {
  return `${requiredEnv("SUPABASE_URL").replace(/\/+$/, "")}${path}`;
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

async function supabaseRequest(path, options = {}) {
  const response = await fetch(supabaseUrl(path), {
    ...options,
    headers: supabaseHeaders(options.headers),
  });
  const body = await readJsonResponse(response);

  if (!response.ok) {
    const detail = body?.message || body?.details || body?.hint || body?.raw || `HTTP ${response.status}`;
    const error = new Error(`Supabase recusou a requisicao: ${detail}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function publicCode(prefix = "CP") {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

function normalizeOrderItems(items = []) {
  return items.map((item) => {
    const productId = String(item.product_id || item.id || "").trim();
    const product = catalog[productId];
    if (!product) {
      throw new Error(`Produto invalido no pedido: ${productId || "sem id"}.`);
    }

    const quantity = Math.max(Number.parseInt(item.quantity || item.qty || 1, 10), 1);
    const unitPrice = Number(product.price);
    return {
      product_id: product.id,
      product_name: product.name,
      quantity,
      unit_price: unitPrice,
      total: Number((unitPrice * quantity).toFixed(2)),
    };
  });
}

async function syncCheckoutUser(user, customer) {
  if (!user) {
    const error = new Error("Conta do cliente nao encontrada. Faca login novamente.");
    error.status = 401;
    throw error;
  }

  if (user.cpf_digits && customer.cpf && user.cpf_digits !== customer.cpf) {
    const error = new Error("CPF do checkout diferente do CPF salvo na conta.");
    error.status = 409;
    throw error;
  }

  const patch = {};
  if (customer.name && customer.name !== user.name) patch.name = customer.name;
  if (customer.phone && customer.phone !== user.phone) patch.phone = customer.phone;
  if (customer.cpf && !user.cpf_digits) patch.cpf_digits = customer.cpf;

  if (!Object.keys(patch).length) return user;

  const body = await supabaseRequest(`/rest/v1/users?id=eq.${encodeURIComponent(user.id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return Array.isArray(body) ? body[0] || { ...user, ...patch } : { ...user, ...patch };
}

export async function ensureCheckoutCustomer(customer) {
  return syncCheckoutUser(await findUserByEmail(customer.email), customer);
}

export async function findUserByEmail(email) {
  const query = new URLSearchParams({
    email: `eq.${String(email).trim().toLowerCase()}`,
    select: "id,name,email,phone,cpf_digits,password_hash,role,is_guest,created_at",
    limit: "1",
  });
  const body = await supabaseRequest(`/rest/v1/users?${query.toString()}`, {
    method: "GET",
  });

  return Array.isArray(body) ? body[0] || null : null;
}

export async function createUserAccount({ name, email, passwordHash }) {
  const existing = await findUserByEmail(email);
  if (existing?.password_hash) {
    const error = new Error("Este e-mail ja tem cadastro. Entre com sua senha.");
    error.status = 409;
    throw error;
  }

  if (existing) {
    const body = await supabaseRequest(`/rest/v1/users?id=eq.${encodeURIComponent(existing.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        name,
        email,
        password_hash: passwordHash,
        is_guest: false,
      }),
    });
    return Array.isArray(body) ? body[0] : body;
  }

  const body = await supabaseRequest("/rest/v1/users", {
    method: "POST",
    body: JSON.stringify({
      name,
      email,
      password_hash: passwordHash,
      role: "customer",
      is_guest: false,
    }),
  });

  return Array.isArray(body) ? body[0] : body;
}

export async function createCheckoutOrder({ customer, items, briefing, pix }) {
  const user = await syncCheckoutUser(await findUserByEmail(customer.email), customer);
  const orderItems = normalizeOrderItems(items);
  const subtotal = Number(orderItems.reduce((sum, item) => sum + item.total, 0).toFixed(2));
  const title = orderItems.map((item) => item.product_name).join(", ");
  const public_code = publicCode("CP");

  const orderBody = await supabaseRequest("/rest/v1/orders", {
    method: "POST",
    body: JSON.stringify({
      public_code,
      user_id: user.id,
      title: title || "Pedido CloneGo",
      subtotal,
      fees: 0,
      total: subtotal,
      status: "waiting_payment",
      status_label: "Aguardando pagamento",
      progress: 10,
      customer_message: "Pedido criado. Aguardando confirmacao Pix.",
      customer_name: customer.name,
      customer_email: customer.email,
      customer_phone: customer.phone || null,
      customer_cpf_digits: customer.cpf,
    }),
  });
  const order = Array.isArray(orderBody) ? orderBody[0] : orderBody;

  if (!order?.id) {
    throw new Error("Supabase nao retornou o pedido criado.");
  }

  await supabaseRequest("/rest/v1/order_items", {
    method: "POST",
    body: JSON.stringify(
      orderItems.map((item) => ({
        order_id: order.id,
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: item.quantity,
        unit_price: item.unit_price,
      })),
    ),
  });

  await supabaseRequest("/rest/v1/order_briefings", {
    method: "POST",
    body: JSON.stringify({
      order_id: order.id,
      customer_name: customer.name,
      customer_email: customer.email,
      customer_phone: customer.phone || null,
      customer_cpf_digits: customer.cpf,
      reference_url: briefing?.reference_url || null,
      niche: briefing?.niche || null,
      colors: briefing?.colors || null,
      gateway_notes: briefing?.gateway_notes || null,
      raw_payload: briefing || {},
    }),
  });

  await supabaseRequest("/rest/v1/payments", {
    method: "POST",
    body: JSON.stringify({
      order_id: order.id,
      provider: "pix",
      status: "pending",
      amount: subtotal,
      pix_txid: pix.identifier,
      pix_qr_code: pix.qrCodeDataUrl || null,
      pix_copy_paste: pix.pixCode,
      expires_at: pix.expiresAt || null,
      payer_name: customer.name,
      payer_email: customer.email,
      payer_phone: customer.phone || null,
      payer_cpf_digits: customer.cpf,
    }),
  });

  await supabaseRequest("/rest/v1/order_status_history", {
    method: "POST",
    body: JSON.stringify([
      {
        order_id: order.id,
        status: "waiting_payment",
        status_label: "Aguardando pagamento",
        progress: 10,
        message: "Pedido criado no checkout com dados do cliente salvos.",
      },
      {
        order_id: order.id,
        status: "request_submitted",
        status_label: "Briefing recebido",
        progress: 20,
        message: "Briefing, contato e CPF do cliente foram vinculados ao pedido.",
      },
    ]),
  });

  return order.id;
}

export async function confirmPixPayment(identifier, rawPayload = {}) {
  const body = await supabaseRequest("/rest/v1/rpc/confirm_pix_payment", {
    method: "POST",
    body: JSON.stringify({
      p_pix_txid: identifier,
      p_provider_reference: identifier,
      p_raw_payload: rawPayload,
    }),
  });

  return Array.isArray(body) ? body[0] : body;
}

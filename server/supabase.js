import crypto from "node:crypto";
import { FREE_TRIAL_PROMO, catalog } from "./catalog.js";

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

function trialPublicCode(cpfDigits) {
  const hash = crypto.createHash("sha256").update(String(cpfDigits)).digest("hex").slice(0, 10).toUpperCase();
  return `TRIAL-${hash}`;
}

function normalizeOrderItems(items = []) {
  return items.map((item) => {
    const productId = String(item.product_id || item.id || "").trim();
    const product = catalog[productId];
    if (!product) {
      throw new Error(`Produto invalido no pedido: ${productId || "sem id"}.`);
    }

    const quantity = Math.max(Number.parseInt(item.quantity || item.qty || 1, 10), 1);
    const isFreeTrial = productId === "plus" && item.promo === FREE_TRIAL_PROMO;
    const unitPrice = isFreeTrial ? 0 : Number(product.price);
    return {
      product_id: product.id,
      product_name: isFreeTrial ? `${product.name} - Teste gratis` : product.name,
      quantity: isFreeTrial ? 1 : quantity,
      unit_price: unitPrice,
      total: Number((unitPrice * (isFreeTrial ? 1 : quantity)).toFixed(2)),
      promo: item.promo || null,
    };
  });
}

async function requireCheckoutUser(user, customer) {
  if (!user) {
    const error = new Error("Conta do cliente nao encontrada. Faca login novamente.");
    error.status = 401;
    throw error;
  }

  if (String(user.email || "").toLowerCase() !== String(customer.email || "").toLowerCase()) {
    const error = new Error("Sessao desatualizada. Saia da conta, entre novamente e tente outra vez.");
    error.status = 409;
    throw error;
  }

  return user;
}

export async function findUserById(id) {
  const query = new URLSearchParams({
    id: `eq.${String(id || "").trim()}`,
    select: "id,name,email,phone,cpf_digits,password_hash,role,is_guest,created_at",
    limit: "1",
  });
  const body = await supabaseRequest(`/rest/v1/users?${query.toString()}`, {
    method: "GET",
  });

  return Array.isArray(body) ? body[0] || null : null;
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

async function updateExistingAccount(existing, { name, email, passwordHash }) {
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

function isDuplicateEmailError(error) {
  return (
    error.body?.code === "23505" &&
    (String(error.body?.details || "").includes("email") || String(error.message || "").includes("users_email_key"))
  );
}

export async function createUserAccount({ name, email, passwordHash }) {
  const existing = await findUserByEmail(email);
  if (existing?.password_hash) {
    const error = new Error("Este e-mail ja tem cadastro. Entre com sua senha.");
    error.status = 409;
    throw error;
  }

  if (existing) {
    return updateExistingAccount(existing, { name, email, passwordHash });
  }

  let body;
  try {
    body = await supabaseRequest("/rest/v1/users", {
      method: "POST",
      body: JSON.stringify({
        name,
        email,
        password_hash: passwordHash,
        role: "customer",
        is_guest: false,
      }),
    });
  } catch (error) {
    if (!isDuplicateEmailError(error)) throw error;

    const current = await findUserByEmail(email);
    if (current?.password_hash) {
      const friendly = new Error("Este e-mail ja tem cadastro. Entre com sua senha.");
      friendly.status = 409;
      throw friendly;
    }
    if (current) return updateExistingAccount(current, { name, email, passwordHash });
    throw error;
  }

  return Array.isArray(body) ? body[0] : body;
}

async function findCheckoutUser(userId) {
  return userId ? await findUserById(userId) : null;
}

export async function createCheckoutOrder({ customer, items, briefing, pix, userId }) {
  const user = await requireCheckoutUser(await findCheckoutUser(userId), customer);
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

export async function hasUsedFreeTrial(cpfDigits) {
  const public_code = trialPublicCode(cpfDigits);
  const existingQuery = new URLSearchParams({
    public_code: `eq.${public_code}`,
    select: "id,public_code,created_at",
    limit: "1",
  });
  const existing = await supabaseRequest(`/rest/v1/orders?${existingQuery.toString()}`, {
    method: "GET",
  });

  return Array.isArray(existing) && existing.length > 0;
}

export async function createFreeTrialOrder({ customer, briefing, userId }) {
  const public_code = trialPublicCode(customer.cpf);

  if (await hasUsedFreeTrial(customer.cpf)) {
    const error = new Error("Este CPF ja usou o teste gratis do Plus Plan.");
    error.status = 409;
    throw error;
  }

  const user = await requireCheckoutUser(await findCheckoutUser(userId), customer);

  let order;
  try {
    const orderBody = await supabaseRequest("/rest/v1/orders", {
      method: "POST",
      body: JSON.stringify({
        public_code,
        user_id: user.id,
        title: "Teste gratis - Plus Plan Structured",
        subtotal: 0,
        fees: 0,
        total: 0,
        status: "payment_confirmed",
        status_label: "Teste gratis liberado",
        progress: 35,
        customer_message: "Seu teste gratis do Plus Plan foi liberado e entrou na fila.",
        customer_name: customer.name,
        customer_email: customer.email,
        customer_phone: customer.phone || null,
        customer_cpf_digits: customer.cpf,
      }),
    });
    order = Array.isArray(orderBody) ? orderBody[0] : orderBody;
  } catch (error) {
    if (error.body?.code === "23505" || String(error.message).includes("orders_public_code_unique")) {
      const friendly = new Error("Este CPF ja usou o teste gratis do Plus Plan.");
      friendly.status = 409;
      throw friendly;
    }
    throw error;
  }

  if (!order?.id) {
    throw new Error("Supabase nao retornou o pedido de teste gratis.");
  }

  await supabaseRequest("/rest/v1/order_items", {
    method: "POST",
    body: JSON.stringify({
      order_id: order.id,
      product_id: "plus",
      product_name: "Plus Plan Structured - Teste gratis",
      quantity: 1,
      unit_price: 0,
    }),
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
      raw_payload: {
        ...(briefing || {}),
        promo: FREE_TRIAL_PROMO,
        terms: "Promocao limitada a 1 teste gratis por CPF.",
      },
    }),
  });

  await supabaseRequest("/rest/v1/payments", {
    method: "POST",
    body: JSON.stringify({
      order_id: order.id,
      provider: "manual",
      status: "confirmed",
      amount: 0,
      provider_reference: public_code,
      paid_at: new Date().toISOString(),
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
        status: "payment_confirmed",
        status_label: "Teste gratis liberado",
        progress: 35,
        message: "Teste gratis do Plus Plan liberado. Promocao limitada a 1 por CPF.",
      },
      {
        order_id: order.id,
        status: "request_submitted",
        status_label: "Briefing recebido",
        progress: 45,
        message: "Briefing do teste gratis foi vinculado ao pedido.",
      },
    ]),
  });

  return {
    id: order.id,
    publicCode: public_code,
  };
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

export async function getAdminOrders() {
  const query = new URLSearchParams({
    select: "*",
    order: "created_at.desc",
    limit: "100",
  });
  const body = await supabaseRequest(`/rest/v1/admin_order_overview?${query.toString()}`, {
    method: "GET",
  });

  return Array.isArray(body) ? body : [];
}

function normalizeDashboardHistory(row) {
  return {
    status: row.status_label || row.status || "Atualizacao",
    at: row.created_at,
    text: row.message || "Status atualizado.",
  };
}

function normalizeDashboardOrder(row, historyByOrderId) {
  const history = historyByOrderId.get(row.id) || [];

  return {
    id: row.public_code || row.id,
    databaseId: row.id,
    publicCode: row.public_code || row.id,
    title: row.title || "Pedido CloneGo",
    total: Number(row.total || 0),
    status: row.status || "waiting_payment",
    statusLabel: row.status_label || "Aguardando pagamento",
    progress: Number(row.progress || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    message: row.customer_message || "Pedido em acompanhamento.",
    history:
      history.length > 0
        ? history.map(normalizeDashboardHistory)
        : [
            {
              status: row.status_label || "Pedido criado",
              at: row.updated_at || row.created_at,
              text: row.customer_message || "Pedido registrado no banco.",
            },
          ],
  };
}

function normalizeDashboardFile(row, ordersById) {
  const order = ordersById.get(row.order_id);

  return {
    id: row.id,
    orderId: row.order_id,
    orderCode: row.order_code || order?.public_code || row.order_id,
    orderTitle: row.order_title || order?.title || "Pedido CloneGo",
    name: row.file_name,
    url: row.file_url,
    sizeBytes: row.file_size_bytes || null,
    mimeType: row.mime_type || "application/zip",
    createdAt: row.created_at,
  };
}

export async function getUserDashboard(userId) {
  const safeUserId = String(userId || "").trim();
  if (!safeUserId) {
    const error = new Error("Usuario nao informado.");
    error.status = 401;
    throw error;
  }

  const orderQuery = new URLSearchParams({
    user_id: `eq.${safeUserId}`,
    select: "id,public_code,title,total,status,status_label,progress,customer_message,created_at,updated_at",
    order: "created_at.desc",
  });
  const ordersBody = await supabaseRequest(`/rest/v1/orders?${orderQuery.toString()}`, {
    method: "GET",
  });
  const orderRows = Array.isArray(ordersBody) ? ordersBody : [];
  const orderIds = orderRows.map((order) => order.id).filter(Boolean);
  const ordersById = new Map(orderRows.map((order) => [order.id, order]));

  let historyRows = [];
  if (orderIds.length > 0) {
    const historyQuery = new URLSearchParams({
      order_id: `in.(${orderIds.join(",")})`,
      select: "order_id,status,status_label,progress,message,created_at",
      order: "created_at.asc",
    });
    const historyBody = await supabaseRequest(`/rest/v1/order_status_history?${historyQuery.toString()}`, {
      method: "GET",
    });
    historyRows = Array.isArray(historyBody) ? historyBody : [];
  }

  const historyByOrderId = historyRows.reduce((map, row) => {
    if (!map.has(row.order_id)) map.set(row.order_id, []);
    map.get(row.order_id).push(row);
    return map;
  }, new Map());

  const fileQuery = new URLSearchParams({
    user_id: `eq.${safeUserId}`,
    is_available: "eq.true",
    select: "id,user_id,order_id,order_code,order_title,file_name,file_url,file_size_bytes,mime_type,is_available,created_at",
    order: "created_at.desc",
  });

  let fileRows;
  try {
    fileRows = await supabaseRequest(`/rest/v1/user_backpack?${fileQuery.toString()}`, {
      method: "GET",
    });
  } catch {
    const fallbackQuery = new URLSearchParams({
      user_id: `eq.${safeUserId}`,
      is_available: "eq.true",
      select: "id,user_id,order_id,file_name,file_url,file_size_bytes,mime_type,is_available,created_at",
      order: "created_at.desc",
    });
    fileRows = await supabaseRequest(`/rest/v1/backpack_files?${fallbackQuery.toString()}`, {
      method: "GET",
    });
  }

  return {
    orders: orderRows.map((order) => normalizeDashboardOrder(order, historyByOrderId)),
    files: (Array.isArray(fileRows) ? fileRows : []).map((file) => normalizeDashboardFile(file, ordersById)),
  };
}

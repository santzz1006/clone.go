import { getAdminOrders } from "../../server/supabase.js";
import { requireMethod, sendError, sendJson, setCors } from "../_utils.js";

function isLocalAdminRequest(request) {
  const host = String(request.headers.host || "");
  const origin = String(request.headers.origin || "");
  const localPattern = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?$/;

  return localPattern.test(host) || localPattern.test(origin);
}

function normalizeAdminOrder(row) {
  return {
    id: row.public_code || row.id,
    databaseId: row.id,
    publicCode: row.public_code,
    title: row.title || "Pedido CloneGo",
    total: Number(row.total || 0),
    status: row.status || "waiting_payment",
    statusLabel: row.status_label || "Aguardando pagamento",
    progress: Number(row.progress || 0),
    paymentStatus: row.payment_status || "pending",
    provider: row.provider || "pix",
    pixTxid: row.pix_txid || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveryFile: row.delivered_file_name || null,
    deliveryUrl: row.delivered_file_url || null,
    request: {
      name: row.customer_name || "",
      email: row.customer_email || "",
      phone: row.customer_phone || "",
      cpf: row.customer_cpf_digits || "",
    },
    history: [
      {
        status: row.status_label || "Pedido criado",
        at: row.updated_at || row.created_at,
        text:
          row.payment_status === "confirmed"
            ? "Pagamento confirmado pela Syncpay."
            : "Pedido criado no checkout e aguardando confirmacao Pix.",
      },
    ],
  };
}

export default async function handler(request, response) {
  if (setCors(request, response)) return;
  if (!requireMethod(request, response, "GET")) return;

  if (!isLocalAdminRequest(request)) {
    sendJson(response, 403, {
      error: "A API admin so funciona localmente.",
      status: 403,
    });
    return;
  }

  try {
    const orders = await getAdminOrders();
    sendJson(response, 200, {
      ok: true,
      orders: orders.map(normalizeAdminOrder),
    });
  } catch (error) {
    sendError(response, error);
  }
}

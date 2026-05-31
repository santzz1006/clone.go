import QRCode from "qrcode";
import { getBearerToken, verifySessionToken } from "../../server/auth.js";
import { calculateAmountCents, hasPromoItem, isFreeTrialCheckout, normalizeCheckoutItems } from "../../server/catalog.js";
import { createCheckoutOrder, createFreeTrialOrder } from "../../server/supabase.js";
import { createPixCashIn } from "../../server/syncpay.js";
import { publicBaseUrl, readBody, requireMethod, sendError, sendJson, setCors, validateCustomer } from "../_utils.js";

export default async function handler(request, response) {
  if (setCors(request, response)) return;
  if (!requireMethod(request, response, "POST")) return;

  try {
    const session = verifySessionToken(getBearerToken(request));
    if (!session) {
      sendJson(response, 401, { error: "Entre na sua conta para finalizar a compra.", status: 401 });
      return;
    }

    const body = await readBody(request);
    const customer = validateCustomer(body.customer);
    if (customer.email !== String(session.email || "").toLowerCase()) {
      sendJson(response, 403, { error: "Use no checkout o mesmo e-mail da conta logada.", status: 403 });
      return;
    }

    const items = normalizeCheckoutItems(body.items);
    const freeTrial = isFreeTrialCheckout(items);
    if (hasPromoItem(items) && !freeTrial) {
      sendJson(response, 400, {
        error: "Promocao invalida. O teste gratis precisa ser apenas do Plus Plan, 1 unidade.",
        status: 400,
      });
      return;
    }

    if (freeTrial) {
      const order = await createFreeTrialOrder({
        customer,
        briefing: body.briefing || {},
        userId: session.id,
      });

      sendJson(response, 201, {
        ok: true,
        freeTrial: true,
        orderId: order.id,
        identifier: order.publicCode,
        amountCents: 0,
        amount: 0,
        statusLabel: "Teste gratis liberado",
        message: "Seu teste gratis do Plus Plan foi criado e enviado para a fila.",
      });
      return;
    }

    const amountCents = calculateAmountCents(items);
    const pix = await createPixCashIn({
      amountCents,
      customer,
      description: items.map((item) => item.name).join(", "),
      webhookUrl: `${publicBaseUrl(request)}/api/syncpay/webhook`,
    });
    const qrCodeDataUrl = await QRCode.toDataURL(pix.pixCode, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
    });
    const orderId = await createCheckoutOrder({
      customer,
      items: items.map(({ product_id, quantity }) => ({ product_id, quantity })),
      briefing: body.briefing || {},
      userId: session.id,
      pix: {
        identifier: pix.identifier,
        pixCode: pix.pixCode,
        qrCodeDataUrl,
      },
    });

    sendJson(response, 201, {
      ok: true,
      orderId,
      identifier: pix.identifier,
      pixCode: pix.pixCode,
      qrCodeDataUrl,
      amountCents,
      amount: amountCents / 100,
    });
  } catch (error) {
    sendError(response, error);
  }
}

import { getBearerToken, verifySessionToken } from "../server/auth.js";
import { getUserDashboard } from "../server/supabase.js";
import { requireMethod, sendError, sendJson, setCors } from "./_utils.js";

export default async function handler(request, response) {
  if (setCors(request, response)) return;
  if (!requireMethod(request, response, "GET")) return;

  try {
    const session = verifySessionToken(getBearerToken(request));
    if (!session) {
      sendJson(response, 401, { error: "Login necessario para carregar a Mochila.", status: 401 });
      return;
    }

    const dashboard = await getUserDashboard(session.id);
    sendJson(response, 200, {
      ok: true,
      ...dashboard,
    });
  } catch (error) {
    sendError(response, error);
  }
}

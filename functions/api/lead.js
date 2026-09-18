/**
 * POST /api/lead  —  recebe a aplicação do popup da LP (same-origin, sem CORS).
 *   1) enriquece com IP/User-Agent e repassa pro webhook do n8n
 *      (fan-out: Google Sheets + DataCrazy CRM + grupo no WhatsApp)
 *   2) dispara o evento Lead na Meta CAPI (server-side, dedup por event_id com o Pixel)
 *
 * Env (Cloudflare Pages → Settings → Environment variables / secrets):
 *   N8N_LEAD_WEBHOOK = URL do webhook de produção do n8n
 *   CAPI_TOKEN       = token da Conversions API da Meta (secret)
 *   PIXEL_ID         = (opcional) id do pixel; default 517148810323901
 */
const DEFAULT_PIXEL = '517148810323901';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fireCAPI(env, data, enriched) {
  const token = env.CAPI_TOKEN;
  if (!token) return;
  const pixel = env.PIXEL_ID || DEFAULT_PIXEL;
  const email = (data.email || '').trim().toLowerCase();
  const phone = (data.whatsapp_completo || '').replace(/\D/g, '');
  const ud = {};
  if (email) ud.em = [await sha256(email)];
  if (phone) ud.ph = [await sha256(phone)];
  if (data.fbp) ud.fbp = data.fbp;
  if (data.fbc) ud.fbc = data.fbc;
  if (enriched.client_ip) ud.client_ip_address = enriched.client_ip;
  if (enriched.user_agent) ud.client_user_agent = enriched.user_agent;

  const body = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_id: data.event_id || undefined,
      action_source: 'website',
      event_source_url: data.event_source_url || '',
      user_data: ud,
      custom_data: { content_name: 'Aplicacao Black Belt' },
    }],
  };
  const url = `https://graph.facebook.com/v21.0/${pixel}/events?access_token=${encodeURIComponent(token)}`;
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}
export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch (_) {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  // Enriquece com dados que só o edge tem (Meta CAPI precisa de IP + UA)
  const enriched = {
    ...data,
    client_ip: request.headers.get('CF-Connecting-IP') || '',
    user_agent: request.headers.get('User-Agent') || '',
    referer: request.headers.get('Referer') || '',
    country: (request.cf && request.cf.country) || '',
    received_at: new Date().toISOString(),
  };

  const webhook = env.N8N_LEAD_WEBHOOK;
  if (webhook) {
    try {
      // Não bloqueia a resposta ao usuário se o n8n demorar/cair
      context.waitUntil(
        fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enriched),
        }).catch(() => {})
      );
    } catch (_) {}
  }

  // Meta CAPI server-side (dedup por event_id com o Pixel do navegador)
  try { context.waitUntil(fireCAPI(env, data, enriched)); } catch (_) {}

  // Sempre responde ok: o lead também é registrado pelo Pixel no cliente
  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

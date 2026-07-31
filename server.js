'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = Number.parseInt(process.env.PORT || '8787', 10);
const SHARED_SECRET = String(process.env.SHARED_SECRET || '').trim();
const SESSION_ID = String(process.env.SESSION_ID || 'send-code').replace(/[^a-zA-Z0-9_-]/g, '') || 'send-code';
const DATA_PATH = path.resolve(process.env.DATA_PATH || path.join(__dirname, 'data'));
const AUTH_PATH = path.join(DATA_PATH, 'auth');
const REQUESTS_FILE = path.join(DATA_PATH, 'sent-requests.json');
const CHROME_PATH = String(process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
const MAX_MESSAGE_LENGTH = 4096;
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SIGNATURE_WINDOW_SECONDS = 300;

if (!SHARED_SECRET || SHARED_SECRET.length < 32) {
  console.error('SHARED_SECRET ausente ou curto. Use pelo menos 32 caracteres aleatórios.');
  process.exit(1);
}

fs.mkdirSync(DATA_PATH, { recursive: true });
fs.mkdirSync(AUTH_PATH, { recursive: true });

const state = {
  status: 'starting',
  qrDataUrl: '',
  number: '',
  name: '',
  lastError: '',
  updatedAt: new Date().toISOString(),
};

let client = null;
let initializePromise = null;
let restartTimer = null;
let sendQueue = Promise.resolve();
let sentRequests = loadSentRequests();

function updateState(patch) {
  Object.assign(state, patch, { updatedAt: new Date().toISOString() });
}

function publicState(includeQr = false) {
  return {
    ok: true,
    status: state.status,
    number: state.number,
    name: state.name,
    lastError: state.lastError,
    updatedAt: state.updatedAt,
    ...(includeQr ? { qrDataUrl: state.qrDataUrl } : {}),
  };
}

function loadSentRequests() {
  try {
    if (!fs.existsSync(REQUESTS_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value && now - Number(value.sentAt || 0) < IDEMPOTENCY_TTL_MS)
    );
  } catch (error) {
    console.error('Não foi possível carregar o histórico de idempotência:', error.message);
    return {};
  }
}

function saveSentRequests() {
  const now = Date.now();
  sentRequests = Object.fromEntries(
    Object.entries(sentRequests).filter(([, value]) => value && now - Number(value.sentAt || 0) < IDEMPOTENCY_TTL_MS)
  );
  const temporary = `${REQUESTS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(sentRequests, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, REQUESTS_FILE);
}

function safeEqualHex(actual, expected) {
  try {
    const left = Buffer.from(String(actual || ''), 'hex');
    const right = Buffer.from(String(expected || ''), 'hex');
    return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function verifySignature(req, res, next) {
  const timestamp = String(req.get('x-ghost-timestamp') || '');
  const signature = String(req.get('x-ghost-signature') || '');
  const unix = Number.parseInt(timestamp, 10);

  if (!Number.isFinite(unix) || Math.abs(Math.floor(Date.now() / 1000) - unix) > SIGNATURE_WINDOW_SECONDS) {
    return res.status(401).json({ ok: false, message: 'Assinatura expirada ou inválida.' });
  }

  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
  const payload = `${timestamp}\n${req.method.toUpperCase()}\n${req.originalUrl}\n${rawBody}`;
  const expected = crypto.createHmac('sha256', SHARED_SECRET).update(payload).digest('hex');

  if (!safeEqualHex(signature, expected)) {
    return res.status(401).json({ ok: false, message: 'Assinatura inválida.' });
  }

  next();
}

function normalizeNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return /^\d{10,15}$/.test(digits) ? digits : '';
}

function sessionDirectory() {
  return path.join(AUTH_PATH, `session-${SESSION_ID}`);
}

function scheduleRestart(delayMs = 5000) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    startClient().catch((error) => {
      updateState({ status: 'error', lastError: error.message || 'Falha ao reiniciar.' });
    });
  }, delayMs);
}

async function destroyClient() {
  if (!client) return;
  const current = client;
  client = null;
  try {
    await current.destroy();
  } catch (error) {
    console.error('Falha ao encerrar o cliente:', error.message);
  }
}

async function startClient() {
  if (initializePromise) return initializePromise;

  initializePromise = (async () => {
    if (client) await destroyClient();

    updateState({ status: 'starting', qrDataUrl: '', number: '', name: '', lastError: '' });

    const puppeteer = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
      ],
    };
    if (CHROME_PATH) puppeteer.executablePath = CHROME_PATH;

    const nextClient = new Client({
      authStrategy: new LocalAuth({ clientId: SESSION_ID, dataPath: AUTH_PATH }),
      puppeteer,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 10000,
    });

    client = nextClient;

    nextClient.on('qr', async (qr) => {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 340,
        });
        updateState({ status: 'qr', qrDataUrl, number: '', name: '', lastError: '' });
      } catch (error) {
        updateState({ status: 'error', qrDataUrl: '', lastError: 'Falha ao gerar o QR Code.' });
      }
    });

    nextClient.on('authenticated', () => {
      updateState({ status: 'authenticated', qrDataUrl: '', lastError: '' });
    });

    nextClient.on('ready', () => {
      const info = nextClient.info || {};
      updateState({
        status: 'connected',
        qrDataUrl: '',
        number: info.wid && info.wid.user ? String(info.wid.user) : '',
        name: info.pushname ? String(info.pushname) : '',
        lastError: '',
      });
      console.log(`WhatsApp conectado${state.number ? `: +${state.number}` : ''}.`);
    });

    nextClient.on('auth_failure', (message) => {
      updateState({ status: 'auth_failure', qrDataUrl: '', number: '', name: '', lastError: String(message || 'Falha de autenticação.') });
      scheduleRestart(5000);
    });

    nextClient.on('disconnected', (reason) => {
      updateState({ status: 'disconnected', qrDataUrl: '', number: '', name: '', lastError: String(reason || 'Sessão desconectada.') });
      scheduleRestart(5000);
    });

    try {
      await nextClient.initialize();
    } catch (error) {
      updateState({ status: 'error', qrDataUrl: '', lastError: error.message || 'Falha ao iniciar o WhatsApp.' });
      throw error;
    }
  })();

  try {
    return await initializePromise;
  } finally {
    initializePromise = null;
  }
}

function enqueueSend(task) {
  const result = sendQueue.then(task, task);
  sendQueue = result.catch(() => undefined);
  return result;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({
  limit: '64kb',
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));

const rateBuckets = new Map();
app.use((req, res, next) => {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const current = rateBuckets.get(key) || { count: 0, resetAt: now + 60000 };
  if (now > current.resetAt) {
    current.count = 0;
    current.resetAt = now + 60000;
  }
  current.count += 1;
  rateBuckets.set(key, current);
  if (current.count > 180) return res.status(429).json({ ok: false, message: 'Muitas solicitações.' });
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'ghost-whatsapp-bridge', version: '1.0.0' });
});

app.use('/v1', verifySignature);

app.get('/v1/status', (req, res) => {
  res.json(publicState(false));
});

app.get('/v1/qr', (req, res) => {
  res.json(publicState(true));
});

app.post('/v1/send', async (req, res) => {
  const number = normalizeNumber(req.body && req.body.number);
  const text = String((req.body && req.body.text) || '').trim();
  const requestId = String((req.body && req.body.requestId) || '').trim();

  if (!number) return res.status(422).json({ ok: false, message: 'Número inválido.' });
  if (!text || text.length > MAX_MESSAGE_LENGTH) return res.status(422).json({ ok: false, message: 'Mensagem vazia ou muito longa.' });
  if (!/^[a-zA-Z0-9._:-]{8,160}$/.test(requestId)) return res.status(422).json({ ok: false, message: 'Identificador da solicitação inválido.' });

  if (sentRequests[requestId]) {
    return res.json({ ok: true, duplicate: true, messageId: sentRequests[requestId].messageId || '' });
  }

  try {
    const result = await enqueueSend(async () => {
      if (!client || state.status !== 'connected') {
        const error = new Error('O WhatsApp não está conectado.');
        error.statusCode = 409;
        throw error;
      }

      const message = await client.sendMessage(`${number}@c.us`, text, { linkPreview: false });
      const messageId = message && message.id && message.id._serialized ? String(message.id._serialized) : '';

      sentRequests[requestId] = {
        messageId,
        sentAt: Date.now(),
        numberTail: number.slice(-4),
      };
      saveSentRequests();

      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { messageId };
    });

    res.json({ ok: true, duplicate: false, messageId: result.messageId });
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    console.error(`Falha no envio para final ${number.slice(-4)}:`, error.message);
    res.status(statusCode).json({ ok: false, message: statusCode === 409 ? error.message : 'Não foi possível enviar a mensagem.' });
  }
});

app.post('/v1/restart', async (req, res) => {
  updateState({ status: 'starting', qrDataUrl: '', lastError: '' });
  scheduleRestart(100);
  res.json(publicState(true));
});

app.post('/v1/disconnect', async (req, res) => {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;

  if (client) {
    try {
      await client.logout();
    } catch (error) {
      console.error('Falha ao sair da sessão:', error.message);
    }
  }
  await destroyClient();

  try {
    fs.rmSync(sessionDirectory(), { recursive: true, force: true });
  } catch (error) {
    console.error('Falha ao remover a sessão:', error.message);
  }

  updateState({ status: 'disconnected', qrDataUrl: '', number: '', name: '', lastError: '' });
  scheduleRestart(1500);
  res.json(publicState(true));
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError) {
    return res.status(400).json({ ok: false, message: 'JSON inválido.' });
  }
  console.error('Erro inesperado:', error.message);
  res.status(500).json({ ok: false, message: 'Erro interno.' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Ghost WhatsApp Bridge ativo na porta ${PORT}.`);
  startClient().catch((error) => console.error('Falha inicial:', error.message));
});

async function shutdown(signal) {
  console.log(`Encerrando por ${signal}...`);
  server.close();
  await destroyClient();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (error) => {
  console.error('Promise rejeitada:', error && error.message ? error.message : error);
});

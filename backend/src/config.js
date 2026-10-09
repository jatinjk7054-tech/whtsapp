import 'dotenv/config';

const required = [
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'JWT_SECRET',
];

const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(
    `Missing environment variables: ${missing.join(', ')}\n` +
      'Copy .env.example to .env and fill in the values.'
  );
  process.exit(1);
}

const int = (value, fallback) => (value === undefined ? fallback : Number(value));

/**
 * Module 12 — ICE servers for browser WebRTC. STUN only by default; a TURN
 * relay can be supplied as JSON when customers sit behind symmetric NAT. The
 * value is handed to authenticated staff only (the browser needs it), so never
 * put a long-lived TURN secret here without accepting that exposure.
 */
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

function parseIceServers(raw) {
  if (!raw) return DEFAULT_ICE_SERVERS;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    console.error('CALLING_ICE_SERVERS is not valid JSON; using the default STUN server.');
  }
  return DEFAULT_ICE_SERVERS;
}

// localhost / 127.0.0.1 par koi bhi port, sirf http(s). Ye Vite ke port drift
// (5173, 5174, ...) ko dev me absorb karta hai; production isse kabhi use nahi karti.
const LOCAL_DEV_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

/**
 * True only for loopback dev servers. Non-production use karta hai — production
 * strict CORS_ORIGIN allow-list par fit hoti hai, yahan nahi.
 */
export function isLocalDevOrigin(origin) {
  return typeof origin === 'string' && LOCAL_DEV_ORIGIN.test(origin);
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 4000),
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  db: {
    host: process.env.DB_HOST,
    port: int(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
    seedAdmin: {
      email: process.env.SEED_ADMIN_EMAIL,
      password: process.env.SEED_ADMIN_PASSWORD,
      name: process.env.SEED_ADMIN_NAME ?? 'Admin',
    },
    exampleAgents: [
      {
        name: process.env.SEED_AGENT1_NAME ?? 'Agent 1',
        email: process.env.SEED_AGENT1_EMAIL ?? 'agent1@example.com',
        password: process.env.SEED_AGENT1_PASSWORD ?? 'Agent1@12345',
      },
      {
        name: process.env.SEED_AGENT2_NAME ?? 'Agent 2',
        email: process.env.SEED_AGENT2_EMAIL ?? 'agent2@example.com',
        password: process.env.SEED_AGENT2_PASSWORD ?? 'Agent2@12345',
      },
    ],
  },
  whatsapp: {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
    appSecret: process.env.WHATSAPP_APP_SECRET ?? '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? '',
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? 'v21.0',
    wabaId: process.env.WHATSAPP_WABA_ID ?? '',
    autoReplyEnabled: process.env.WHATSAPP_AUTO_REPLY_ENABLED !== 'false',
    autoReplyText:
      (process.env.WHATSAPP_AUTO_REPLY_TEXT ??
        'Namaste 🙏\nBeing Sevak Charitable Trust se sampark karne ke liye dhanyavaad.\nKripya apna naam aur apni query bhejein. Hamari team jald aapse sampark karegi.').replace(/\\n/g, '\n'),
    get enabled() {
      return Boolean(this.phoneNumberId && this.accessToken);
    },
  },
  // Module 12 — WhatsApp Business Calling (voice). Disabled unless explicitly
  // switched on, so existing installs are never surprised by a new webhook
  // field or a call button they did not configure.
  calling: {
    enabled: process.env.WHATSAPP_CALLING_ENABLED === 'true',
    iceServers: parseIceServers(process.env.CALLING_ICE_SERVERS),
    get configured() {
      return config.whatsapp.enabled && this.enabled;
    },
  },
};

export function assertWhatsAppConfigured() {
  const missingWhatsApp = ['phoneNumberId', 'accessToken'].filter(
    (key) => !config.whatsapp[key]
  );

  if (missingWhatsApp.length > 0) {
    console.error(
      `WhatsApp is not configured: ${missingWhatsApp.join(', ')} is missing.\n` +
        'Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN in .env.'
    );
    process.exit(1);
  }
}
import { config } from '../../config.js';

const GRAPH_BASE = 'https://graph.facebook.com';

export class WhatsAppApiError extends Error {
  constructor(message, { status, code, type, details } = {}) {
    super(message);
    this.name = 'WhatsAppApiError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.details = details;
  }
}

function endpoint(path) {
  return `${GRAPH_BASE}/${config.whatsapp.graphVersion}${path}`;
}

/**
 * Meta ka asli error body log karta hai (message/code/type) taaki "400" jaisa
 * generic message kabhi na dikhe. Authorization header aur access token is line
 * me kabhi nahi jaate; query string bhi kaat di jaati hai.
 */
function metaApiError({ method, url, status, payload }) {
  const error = payload?.error ?? {};
  const safeUrl = String(url).split('?')[0];

  console.error(
    '[whatsapp] Meta API error:',
    JSON.stringify({
      method,
      url: safeUrl,
      status,
      message: error.message ?? null,
      code: error.code ?? null,
      type: error.type ?? null,
      details: error.error_data?.details ?? null,
    })
  );

  return new WhatsAppApiError(error.message ?? `Meta responded with ${status}`, {
    status,
    code: error.code,
    type: error.type,
    details: error.error_data?.details ?? null,
  });
}

async function call(path, body) {
  const url = endpoint(path);

  if (!config.whatsapp.enabled) {
    throw new WhatsAppApiError('WhatsApp Cloud API is not configured');
  }

  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new WhatsAppApiError(`Network error calling Meta: ${cause.message}`, {
      code: 'network_error',
    });
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw metaApiError({ method: 'POST', url, status: response.status, payload });
  }

  return payload;
}

// Module 12 — the Calling API reuses the same POST/error plumbing. Exported so
// the call signalling lives in its own file without duplicating token handling.
export { call as graphPost, graphGet, metaApiError as toMetaApiError };

export async function sendTextMessage({ to, body, contextMessageId }) {
  return call(`/${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    // WhatsApp reply: Meta threads the quoted message when a context id is set.
    ...(contextMessageId ? { context: { message_id: contextMessageId } } : {}),
    text: { preview_url: false, body },
  });
}

export async function sendMediaMessage({ to, type, media, contextMessageId }) {
  if (!['image', 'audio', 'document', 'sticker', 'video'].includes(type)) {
    throw new WhatsAppApiError(`Unsupported media type: ${type}`);
  }

  // `link` for public URLs, `id` for media previously uploaded to Meta.
  const mediaKey = media?.id ? 'id' : 'link';

  return call(`/${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type,
    ...(contextMessageId ? { context: { message_id: contextMessageId } } : {}),
    [type]: { [mediaKey]: media?.[mediaKey] },
  });
}

export async function markMessageAsRead(messageId) {
  return call(`/${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  });
}

async function graphGet(url) {
  if (!config.whatsapp.enabled) {
    throw new WhatsAppApiError('WhatsApp Cloud API is not configured');
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });

  // Sirf error case me body padhi jaati hai, warna callers apna .json() /
  // .arrayBuffer() le sakte hain. Yahan Meta ka asli message/code/type bhi
  // carry hota hai — pehle ye "Meta responded with 400" tak hi simit tha.
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw metaApiError({ method: 'GET', url, status: response.status, payload });
  }

  return response;
}

/**
 * Media inbound messages only carry an opaque id. Resolving it is a two-hop
 * call: id -> short-lived CDN url -> bytes. The url itself is never stored or
 * exposed because it expires in minutes.
 */
export async function downloadMedia(mediaId) {
  const metadata = await graphGet(endpoint(`/${mediaId}`));
  const { url, mime_type: mimeType, file_size: fileSize } = await metadata.json();

  if (!url) {
    throw new WhatsAppApiError('Media id did not resolve to a download URL');
  }

  const body = await graphGet(url);
  const buffer = Buffer.from(await body.arrayBuffer());

  return {
    buffer,
    mimeType: body.headers.get('content-type') ?? mimeType ?? 'application/octet-stream',
    fileSize: body.headers.get('content-length') ?? fileSize ?? buffer.length,
  };
}

const TEMPLATE_CACHE_TTL_MS = 60_000;
let templateCache = { at: 0, items: [] };
let lastTemplateRefreshError = null;

/**
 * Approved templates ko 60s tak ke liye cache me rakha jaata hai. Refresh fail
 * hone par purani list bani rehti hai — send ke waqt definition chahiye hi chahiye.
 */
async function refreshTemplateCache() {
  if (Date.now() - templateCache.at < TEMPLATE_CACHE_TTL_MS && templateCache.items.length) return;

  try {
    const { items } = await listApprovedTemplates();
    templateCache = { at: Date.now(), items };
    lastTemplateRefreshError = null;
  } catch (error) {
    lastTemplateRefreshError = error;
    console.error('[whatsapp] template definition refresh failed:', error.message);
  }
}

/**
 * Approved template ka definition (components + parameter_format). Send ke waqt
 * header media yahin se milta hai, isliye 60s ka cache rakha jaata hai.
 */
async function getTemplateDefinition(name, language) {
  await refreshTemplateCache();

  return (
    templateCache.items.find((t) => t.name === name && t.language === language) ??
    templateCache.items.find((t) => t.name === name) ??
    null
  );
}

/**
 * Module 4 — sirf APPROVED templates ki list se exact name + language lookup.
 * Meta ki list fetch hi na ho paaye aur cache bhi khaali ho to template ko
 * "approved" maana hi nahi jaata: send par clear error aata hai, guess nahi.
 */
export async function findApprovedTemplate(name, language) {
  await refreshTemplateCache();

  if (!templateCache.items.length) {
    throw (
      lastTemplateRefreshError ??
      new WhatsAppApiError('Approved template list is unavailable, so this template cannot be verified.', {
        code: 'template_list_unavailable',
      })
    );
  }

  return templateCache.items.find((t) => t.name === name && t.language === language) ?? null;
}

function countVariables(text) {
  return [...String(text ?? '').matchAll(/\{\{\s*[^}]+?\s*\}\}/g)].length;
}

/**
 * Template ke example.header_handle ki signed URL Meta ki apni downloader se
 * 131053 "Media upload error" de deti hai. Isliye image ek baar khud download
 * karke Cloud API par upload karke uska media ID bhejte hain — Meta recommend
 * bhi yahi karta hai. Sirf successful upload hi cache hota hai.
 */
const headerAssetCache = new Map();

export async function resolveHeaderAsset(type, handle) {
  const cacheKey = `${type}:${handle}`;
  if (headerAssetCache.has(cacheKey)) return headerAssetCache.get(cacheKey);

  let asset;
  if (/^https?:\/\//i.test(handle)) {
    try {
      const response = await fetch(handle, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const mimeType = (response.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim();
        const extension = (mimeType.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
        const uploaded = await uploadMedia(buffer, mimeType, `template-header-${Date.now()}.${extension}`);
        if (uploaded?.id) asset = { id: uploaded.id };
      } else {
        console.error('[whatsapp] header asset download failed:', response.status, handle.split('?')[0]);
      }
    } catch (error) {
      console.error('[whatsapp] header asset upload failed:', error.message);
    }
    if (!asset) asset = { link: handle };
  } else if (/^\d{5,20}$/.test(handle)) {
    asset = { id: handle };
  } else {
    asset = { link: handle };
  }

  if (asset.id) headerAssetCache.set(cacheKey, asset);
  return asset;
}

/**
 * Media header wale template me header component bhejna zaroori hai — bina header
 * media ke Meta (#132012) "Format mismatch, expected IMAGE, received UNKNOWN"
 * deta hai. Body variables ki count bhi check hoti hai.
 */
export async function buildTemplateComponents(template, definition) {
  const definitionTypes = new Set(
    (definition?.components ?? []).map((c) => String(c.type ?? '').toLowerCase().replace(/s$/, ''))
  );
  const components = (Array.isArray(template.components) ? template.components : [])
    .filter(Boolean)
    .filter((c) => !definitionTypes.size || definitionTypes.has(String(c.type ?? '')))
    .map((c) => ({ ...c }));

  const headerDef = definition?.components?.find((c) => c.type === 'HEADER');
  const bodyDef = definition?.components?.find((c) => c.type === 'BODY');
  const hasHeader = components.some((c) => c.type === 'header');
  const hasBody = components.some((c) => c.type === 'body');

  if (!hasHeader && headerDef) {
    const format = String(headerDef.format ?? '').toUpperCase();
    const handle = headerDef.example?.header_handle?.[0];
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format) && handle) {
      const key = format.toLowerCase();
      components.push({
        type: 'header',
        parameters: [{ type: key, [key]: await resolveHeaderAsset(key, handle) }],
      });
    }
  }

  const expectedBodyVariables = countVariables(bodyDef?.text);
  if (expectedBodyVariables > 0) {
    const bodyComponent = components.find((c) => c.type === 'body');
    const supplied = bodyComponent?.parameters?.length ?? 0;
    const templateName = definition?.name ?? template.name;

    if (!hasBody || supplied !== expectedBodyVariables) {
      throw new WhatsAppApiError(
        `Template "${templateName}" ko ${expectedBodyVariables} body variable chahiye, ${supplied} bheje gaye.`,
        { code: 'template_params_mismatch' }
      );
    }

    if (String(definition?.parameter_format ?? '') === 'NAMED') {
      // Meta's named-parameter field is `parameter_name`; older payloads used
      // `name`. Either one satisfies the check, an absent one does not.
      const missingName = bodyComponent.parameters.find(
        (parameter) => !parameter?.parameter_name && !parameter?.name
      );
      if (missingName) {
        throw new WhatsAppApiError(
          `Template "${templateName}" named parameters use karta hai — har parameter me "name" field chahiye.`,
          { code: 'template_params_mismatch' }
        );
      }
    }
  }

  return components.length ? components : undefined;
}

export async function sendTemplateMessage({ to, template }) {
  let definition = null;
  try {
    definition = await getTemplateDefinition(template.name, template.language);
  } catch (error) {
    console.error('[whatsapp] template definition lookup failed:', error.message);
  }

  const components = await buildTemplateComponents(template, definition);

  return call(`/${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
      ...(components ? { components } : {}),
    },
  });
}

/**
 * Graph phone number id se WABA id nahi deta — `?fields=whatsapp_business_account`
 * har version par (#100) nonexisting field deta hai. Webhook payload ka entry.id
 * hi WABA id hota hai, isliye wo yahan se seekh li jaati hai.
 */
let learnedWabaId = '';

export function recordWabaId(id) {
  const value = String(id ?? '');
  if (/^\d{5,20}$/.test(value)) learnedWabaId = value;
}

export function getWabaId() {
  return config.whatsapp.wabaId || learnedWabaId || '';
}

async function resolveWabaId() {
  const configured = getWabaId();
  if (configured) return configured;

  // Purana fallback: phone number node se parent WABA. Har token par kaam
  // nahi karta, isliye yahan fail hona fatal nahi hai.
  try {
    const response = await graphGet(
      endpoint(`/${config.whatsapp.phoneNumberId}?fields=whatsapp_business_account`)
    );
    const data = await response.json();
    if (data?.whatsapp_business_account?.id) return data.whatsapp_business_account.id;
  } catch (error) {
    console.error('[whatsapp] WABA auto-detect from phone number failed:', error.message);
  }

  throw new WhatsAppApiError(
    'WhatsApp Business Account ID patha nahi chala. WHATSAPP_WABA_ID backend/.env me set karo (Meta App Dashboard → WhatsApp → API Setup → WhatsApp Business Account ID).',
    { code: 'waba_id_missing' }
  );
}

export async function listApprovedTemplates() {
  const wabaId = await resolveWabaId();
  const response = await graphGet(
    endpoint(
      `/${wabaId}/message_templates?status=APPROVED&limit=100&fields=id,name,status,language,category,components,parameter_format`
    )
  );
  const data = await response.json();
  const items = (data?.data ?? []).filter((template) => template.status === 'APPROVED');
  templateCache = { at: Date.now(), items };
  return { items, wabaId };
}

export async function uploadMedia(buffer, mimeType, filename) {
  if (!config.whatsapp.enabled) throw new WhatsAppApiError('WhatsApp Cloud API is not configured');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), filename || 'upload');
  let response;
  try {
    response = await fetch(endpoint(`/${config.whatsapp.phoneNumberId}/media`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    throw new WhatsAppApiError(`Network error uploading media: ${cause.message}`, { code: 'network_error' });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw metaApiError({
      method: 'POST',
      url: endpoint(`/${config.whatsapp.phoneNumberId}/media`),
      status: response.status,
      payload,
    });
  }
  return payload;
}

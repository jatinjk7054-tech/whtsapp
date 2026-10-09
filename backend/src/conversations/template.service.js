import { HttpError } from '../lib/HttpError.js';
import { findApprovedTemplate, resolveHeaderAsset, uploadMedia } from '../lib/whatsapp/client.js';

const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

/** `{{1}}` (positional) and `{{first_name}}` (named) both match, in text order. */
export function extractTokens(text) {
  return [...String(text ?? '').matchAll(TOKEN_RE)].map((match) => match[1]);
}

export function renderTemplateText(text, tokens, values) {
  let index = 0;
  return String(text ?? '').replace(TOKEN_RE, () => String(values[index++] ?? ''));
}

function definitionComponent(definition, type) {
  return (
    (definition?.components ?? []).find((c) => String(c.type ?? '').toUpperCase() === type) ?? null
  );
}

/**
 * Template definition ke buttons — Meta ne do shapes bheje hain: naya
 * `BUTTONS: { buttons: [...] }` aur purana `BUTTON + sub_type + index`.
 * Dono ko ek hi list me laata hai taaki preview aur send dono sahi rahein.
 */
export function definitionButtons(definition) {
  const buttons = [];

  const container = definitionComponent(definition, 'BUTTONS');
  for (const button of container?.buttons ?? []) {
    buttons.push({
      kind: String(button.type ?? '').toUpperCase(),
      label: String(button.text ?? ''),
      url: button.url ?? null,
      phone: button.phone_number ?? null,
      index: buttons.length,
    });
  }

  for (const component of definition?.components ?? []) {
    if (String(component.type ?? '').toUpperCase() !== 'BUTTON') continue;
    const parameter = (component.parameters ?? []).find((p) => p?.url) ?? {};
    buttons.push({
      kind: String(component.sub_type ?? component.type ?? '').toUpperCase(),
      label: String(parameter.text ?? component.text ?? ''),
      url: parameter.url ?? component.url ?? null,
      phone: component.phone_number ?? parameter.phone_number ?? null,
      index: Number.isInteger(component.index) ? component.index : buttons.length,
    });
  }

  return buttons;
}

/** Sirf dynamic URL buttons (`https://x/{{1}}`) ko value chahiye. */
export function urlButtonVariable(button) {
  if (button.kind !== 'URL') return null;
  const url = String(button.url ?? '');
  return url.includes('{{') ? url : null;
}

/**
 * Values ki validation: count exact, khaali nahi, aur "{{1}}" jaisa unresolved
 * placeholder kabhi customer ko nahi jaana chahiye.
 */
function requireValues(values, tokens, label) {
  const list = Array.isArray(values) ? values : [];

  if (list.length !== tokens.length) {
    throw new HttpError(
      422,
      `${label} needs ${tokens.length} variable value${tokens.length === 1 ? '' : 's'}, received ${list.length}.`
    );
  }

  return list.map((value, index) => {
    const text = String(value ?? '').trim();
    if (!text) throw new HttpError(422, `${label} variable ${index + 1} is required.`);
    if (/^\{\{[^}]+\}\}$/.test(text)) {
      throw new HttpError(422, `${label} variable ${index + 1} is still an unresolved placeholder.`);
    }
    return text;
  });
}

/**
 * Module 4 — Meta ke approved definition se exact send payload banata hai:
 * header (text variables ya media), body variables aur dynamic URL button values,
 * POSITIONAL aur NAMED dono parameter formats me. Pure-ish: sirf header media
 * upload ke liye Meta call karta hai. HttpError 422 se validate karta hai, isliye
 * galat payload kabhi message row ya Meta tak nahi pahunchta.
 */
export async function buildTemplatePayload(
  definition,
  { variables, headerVariables, headerMedia, buttonParams } = {}
) {
  const named = String(definition?.parameter_format ?? '').toUpperCase() === 'NAMED';
  const components = [];
  const params = {};

  // ---- Header ---------------------------------------------------------------
  const headerDef = definitionComponent(definition, 'HEADER');
  const format = String(headerDef?.format ?? '').toUpperCase();

  if (format === 'TEXT') {
    const tokens = extractTokens(headerDef.text);
    if (tokens.length) {
      const values = requireValues(headerVariables, tokens, 'Header');
      components.push({
        type: 'header',
        parameters: tokens.map((token, index) => ({
          type: 'text',
          text: values[index],
          ...(named ? { parameter_name: token } : {}),
        })),
      });
      params.headerText = renderTemplateText(headerDef.text, tokens, values);
      params.headerVariables = values;
    } else if (headerVariables?.length) {
      throw new HttpError(422, 'This template header has no variables.');
    }
  } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
    const key = format.toLowerCase();

    if (headerMedia) {
      if (String(headerMedia.type ?? '').toLowerCase() !== key) {
        throw new HttpError(422, `This template needs an ${format} header, not ${headerMedia.type}.`);
      }

      let asset;
      if (headerMedia.base64) {
        const clean = String(headerMedia.base64).replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(clean, 'base64');
        if (!buffer.length || buffer.length > MAX_MEDIA_BYTES) {
          throw new HttpError(422, 'Header media must be between 1 byte and 15 MB.');
        }
        const uploaded = await uploadMedia(
          buffer,
          headerMedia.mimeType || 'application/octet-stream',
          headerMedia.filename || `template-header.${key === 'document' ? 'bin' : key}`
        );
        if (!uploaded?.id) throw new HttpError(422, 'Header media could not be uploaded to WhatsApp.');
        asset = { id: uploaded.id };
        // Reuses GET /api/media/:id — the same protected path every other
        // attachment in the CRM uses, so the chat can render it later.
        params.header = { type: key, mediaPath: `/api/media/${uploaded.id}` };
      } else if (headerMedia.url) {
        asset = await resolveHeaderAsset(key, headerMedia.url);
        params.header = { type: key, url: headerMedia.url };
      } else {
        throw new HttpError(422, `Choose a header ${format.toLowerCase()} or paste its URL.`);
      }

      components.push({ type: 'header', parameters: [{ type: key, [key]: asset }] });
    }
    // Header input na dene par definition ke example handle ko sendTemplateMessage
    // khud attach karta hai (existing behaviour, tests se confirm hua).
  } else if (headerMedia || headerVariables?.length) {
    throw new HttpError(422, 'This template does not use a header.');
  }

  // ---- Body -----------------------------------------------------------------
  const bodyDef = definitionComponent(definition, 'BODY');
  const bodyTokens = extractTokens(bodyDef?.text);

  if (bodyTokens.length) {
    const values = requireValues(variables, bodyTokens, 'Body');
    components.push({
      type: 'body',
      parameters: bodyTokens.map((token, index) => ({
        type: 'text',
        text: values[index],
        ...(named ? { parameter_name: token } : {}),
      })),
    });
    params.variables = values;
    params.body = renderTemplateText(bodyDef.text, bodyTokens, values);
  } else if (variables?.length) {
    throw new HttpError(422, 'This template body has no variables.');
  }

  // ---- Buttons --------------------------------------------------------------
  const buttons = definitionButtons(definition);
  const supplied = new Map(
    (buttonParams ?? []).map((entry) => [Number(entry.index), String(entry.value ?? '').trim()])
  );

  for (const button of buttons) {
    const urlTemplate = urlButtonVariable(button);
    if (!urlTemplate) continue;

    const value = supplied.get(button.index);
    if (!value) {
      throw new HttpError(422, `URL button "${button.label || `#${button.index + 1}`}" needs a value.`);
    }

    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(button.index),
      parameters: [{ type: 'text', text: value }],
    });
    (params.buttonParams ??= []).push({ index: button.index, value });
  }

  for (const index of supplied.keys()) {
    const target = buttons.find((button) => button.index === index);
    if (!target || !urlButtonVariable(target)) {
      throw new HttpError(422, `Button ${index + 1} does not accept a value.`);
    }
  }

  return { components: components.length ? components : undefined, body: params.body ?? '', params };
}

/**
 * Send se pehle ka gate: template Meta ke APPROVED list me hona chahiye aur
 * language code exact wahi hona jo agent ne chuna. Pending / rejected /
 * disabled / deleted ya galat language yahin reject ho jaate hain.
 */
export async function prepareTemplateSend({ name, language, components, variables, headerVariables, headerMedia, buttonParams }) {
  const definition = await findApprovedTemplate(name, language);

  if (!definition) {
    throw new HttpError(
      422,
      `No approved Meta template named "${name}" with language "${language}". Open the Template Library and press Refresh Templates.`
    );
  }

  const status = String(definition.status ?? 'APPROVED').toUpperCase();
  if (status !== 'APPROVED') {
    throw new HttpError(422, `Template "${name}" is ${status} and cannot be sent.`);
  }

  // Purane/advanced callers Meta-shaped components khud bhej sakte hain — wahi
  // validate hokar jaata hai jaise pehle jaata tha.
  if (Array.isArray(components) && components.length) {
    return { components, body: '', params: null };
  }

  return buildTemplatePayload(definition, { variables, headerVariables, headerMedia, buttonParams });
}

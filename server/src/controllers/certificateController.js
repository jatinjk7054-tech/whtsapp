import db from '../config/db.js';
import {
  getPkgFormat,
  normalizePlaceholderWhitespace,
  detectPlaceholders,
  renderCertificate,
  humanizeKey,
} from '../services/certificateDocx.js';
import { snapshotToPng } from '../services/slideSnapshot.js';

const BUCKET = 'certificates';
const VALID_STATUS = new Set(['active', 'draft', 'archived']);
const VALID_TYPES = new Set(['text', 'number', 'date', 'time', 'datetime', 'longtext']);
const MAX_FIELDS = 60;

const slugify = (s) =>
  String(s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';

const identity = (req) => ({
  id: String(req.user?.id ?? req.user?.worker_id ?? req.user?.emp_id ?? ''),
  name: String(req.user?.name ?? req.user?.full_name ?? ''),
});

// Prefer a service-role download by storage key. The `certificates` bucket is not
// public, so an anonymous GET against the public URL 403s even though the upload
// itself succeeded — that is what made every render fail with "Unable to read
// template file (403)". The public URL is kept only as a fallback for rows stored
// before template_key existed.
async function fetchFile(url, key) {
  if (key) {
    const { data, error } = await db.storage.from(BUCKET).download(key);
    if (!error && data) return Buffer.from(data);
    const why = error && error.message ? error.message : String(error);
    throw new Error(`Unable to read template file from storage: ${why}`);
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Unable to read template file (${resp.status})`);
  return Buffer.from(await resp.arrayBuffer());
}

async function uploadFile(key, buffer, contentType) {
  const { error } = await db.storage.from(BUCKET).upload(key, buffer, { contentType });
  if (error) throw error;
  const { data } = db.storage.from(BUCKET).getPublicUrl(key);
  return data.publicUrl;
}

async function savePreviewImage(id, template, buffer, ext = 'png', contentType = 'image/png') {
  const key = `previews/${id}-${slugify(template.name)}.${ext}`;
  const url = await uploadFile(key, buffer, contentType);
  if (template.preview_key && template.preview_key !== key) {
    await db.storage.from(BUCKET).remove(template.preview_key).catch(() => {});
  }
  await db._pool.query(
    `UPDATE certificate_templates SET preview_image = $1, preview_key = $2, updated_at = NOW() WHERE id = $3`,
    [url, key, id]);
  return url;
}

// Best-effort: renders the first page/slide of a DOCX/PPTX template via
// LibreOffice and stores it as the template's preview image. Never throws.
export async function autosnapshotTemplate(template) {
  if (!template || !template.template_file) return null;
  try {
    const raw = await fetchFile(template.template_file, template.template_key);
    const png = await snapshotToPng(raw, template.file_format);
    if (!png) return null;
    return savePreviewImage(template.id, template, png);
  } catch {
    return null;
  }
}

async function loadTemplateDetail(id) {
  const { rows: templates } = await db._pool.query(
    `SELECT t.id, t.name, t.description, t.file_format, t.status, t.template_file, t.template_key, t.preview_image, t.placeholders, t.version, t.created_by, t.created_at, t.updated_at,
            t.ngo_id, n.name AS ngo_name, t.purpose
       FROM certificate_templates t
       LEFT JOIN ngos n ON n.id = t.ngo_id
       WHERE t.id = $1`, [id]);
  if (!templates.length) return null;
  const { rows: fields } = await db._pool.query(
    `SELECT id, field_key, display_name, field_type, required, default_value, in_template, sort_order
       FROM certificate_template_fields WHERE template_id = $1 ORDER BY sort_order ASC, id ASC`, [id]);
  const tpl = templates[0];
  const { rows: certCount } = await db._pool.query(
    `SELECT COUNT(*)::int AS n FROM certificates WHERE template_id = $1`, [id]);
  return { ...tpl, fields, certificate_count: certCount[0]?.n || 0 };
}

async function replaceFields(templateId, fields) {
  await db._pool.query('DELETE FROM certificate_template_fields WHERE template_id = $1', [templateId]);
  const seen = new Set();
  const list = Array.isArray(fields) ? fields.slice(0, MAX_FIELDS) : [];
  for (let i = 0; i < list.length; i += 1) {
    const f = list[i] || {};
    const rawKey = String(f.field_key || f.key || '').trim();
    const key = rawKey.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const type = VALID_TYPES.has(f.field_type) ? f.field_type : 'text';
    await db._pool.query(
      `INSERT INTO certificate_template_fields
         (template_id, field_key, display_name, field_type, required, default_value, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [templateId, key, String(f.display_name || humanizeKey(key)).slice(0, 80), type,
       f.required !== false, String(f.default_value ?? ''), Number(f.sort_order ?? i)]);
  }
}

async function syncFieldsWithPlaceholders(templateId, placeholders) {
  const keys = (placeholders || []).map((p) => p.key);
  const { rows } = await db._pool.query(
    `SELECT id, field_key FROM certificate_template_fields WHERE template_id = $1`, [templateId]);
  for (const r of rows) {
    const inTemplate = keys.includes(r.field_key);
    await db._pool.query(
      `UPDATE certificate_template_fields SET in_template = $1 WHERE id = $2`, [inTemplate, r.id]);
  }
  const present = new Set(rows.map((r) => r.field_key));
  let sort = rows.length;
  for (const p of placeholders || []) {
    if (present.has(p.key)) continue;
    await db._pool.query(
      `INSERT INTO certificate_template_fields
         (template_id, field_key, display_name, field_type, required, default_value, in_template, sort_order)
       VALUES ($1, $2, $3, 'text', FALSE, '', TRUE, $4)`,
      [templateId, p.key, p.display, sort]);
    sort += 1;
  }
}

function buildMissing(requiredFields, values) {
  const missing = [];
  for (const f of requiredFields) {
    const v = values[f.field_key];
    if (v == null || String(v).trim() === '') missing.push(f.display_name || f.field_key);
  }
  return missing;
}

async function renderFromTemplate(template, values) {
  if (!template.template_file) throw new Error('Template file is missing');
  const storage = await fetchFile(template.template_file, template.template_key);
  return renderCertificate(storage, values);
}

async function nextCertificateNumber() {
  const year = new Date().getFullYear();
  const { rows } = await db._pool.query(
    `SELECT certificate_number FROM certificates WHERE certificate_number ~ '^CERT-` + year + `-[0-9]+$'`);
  let max = 0;
  for (const r of rows) {
    const m = /-([0-9]+)$/.exec(r.certificate_number);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `CERT-${year}-${String(max + 1).padStart(5, '0')}`;
}

/* -------------------------------------- templates -------------------------------------- */

export const createTemplate = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Template file is required (.docx or .pptx)' });
    const raw = req.file.buffer;
    const fmt = getPkgFormat(raw);
    if (!fmt) return res.status(400).json({ message: 'Invalid file. Upload a valid .docx or .pptx certificate template.' });

    const normalized = normalizePlaceholderWhitespace(raw);
    const { placeholders } = detectPlaceholders(normalized);
    const me = identity(req);
    const name = String(req.body?.name || req.file.originalname).trim().slice(0, 120) || 'Untitled template';
    const description = String(req.body?.description || '').trim().slice(0, 500);
    const purpose = String(req.body?.purpose || '').trim().slice(0, 120);
    const rawNgoId = String(req.body?.ngo_id || '').trim();
    const ngoId = rawNgoId && rawNgoId !== 'null' ? rawNgoId : null;

    const { rows } = await db._pool.query(
      `INSERT INTO certificate_templates (name, description, file_format, template_file, template_key, placeholders, status, version, created_by, ngo_id, purpose)
       VALUES ($1, $2, $3, '', '', $4, 'active', 1, $5, $6, $7) RETURNING id`,
      [name, description, fmt, JSON.stringify(placeholders), me.name || me.id, ngoId, purpose]);
    const id = rows[0].id;

    const key = `templates/${id}-${slugify(name)}-v1.${fmt}`;
    try {
      const url = await uploadFile(key, normalized, req.file.mimetype);
      await db._pool.query(
        `UPDATE certificate_templates SET template_file = $1, template_key = $2 WHERE id = $3`,
        [url, key, id]);
    } catch (e) {
      await db._pool.query('DELETE FROM certificate_templates WHERE id = $1', [id]);
      return res.status(500).json({ message: 'Template file upload failed', error: e.message });
    }

    await replaceFields(id, placeholders.map((p, i) => ({ field_key: p.key, display_name: p.display, field_type: 'text', required: true, sort_order: i })));
    const template = await loadTemplateDetail(id);
    await autosnapshotTemplate(template);
    return res.json({ message: 'Template created', template: await loadTemplateDetail(id), detected: placeholders });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

export const listTemplates = async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const ngoId = String(req.query.ngo_id || '').trim();
    const purpose = String(req.query.purpose || '').trim();
    const clauses = [];
    const params = [];
    if (status && status !== 'all') {
      params.push(status);
      clauses.push(`t.status = $${params.length}`);
    } else if (!status) {
      clauses.push(`t.status <> 'archived'`);
    }
    if (ngoId && ngoId !== 'all') {
      params.push(ngoId);
      clauses.push(`t.ngo_id::text = $${params.length}`);
    }
    if (purpose && purpose !== 'all') {
      params.push(purpose);
      clauses.push(`t.purpose = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await db._pool.query(
      `SELECT t.id, t.name, t.description, t.file_format, t.status, t.template_file, t.preview_image, t.placeholders, t.version, t.created_at, t.updated_at,
              t.ngo_id, n.name AS ngo_name, t.purpose,
              (SELECT COUNT(*)::int FROM certificate_template_fields f WHERE f.template_id = t.id) AS field_count,
              (SELECT COUNT(*)::int FROM certificates c WHERE c.template_id = t.id) AS certificate_count
         FROM certificate_templates t
         LEFT JOIN ngos n ON n.id = t.ngo_id
         ${where}
        ORDER BY t.updated_at DESC, t.created_at DESC`, params);
    return res.json(rows);
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

export const listNgoOptions = async (req, res) => {
  try {
    const { rows } = await db._pool.query(
      `SELECT id, name FROM ngos WHERE is_active = true ORDER BY name ASC`);
    return res.json(rows);
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

export const listPurposes = async (req, res) => {
  try {
    const { rows } = await db._pool.query(
      `SELECT p.id, p.name,
              (SELECT COUNT(*)::int FROM certificate_templates t WHERE t.purpose = p.name) AS template_count
         FROM certificate_purposes p
        WHERE p.is_active = true
        ORDER BY p.sort_order ASC, p.name ASC`);
    return res.json(rows);
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

export const addPurpose = async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ message: 'Purpose name is required' });
    const { rows: existing } = await db._pool.query(
      `SELECT id FROM certificate_purposes WHERE lower(name) = lower($1)`, [name]);
    if (existing.length) {
      await db._pool.query(`UPDATE certificate_purposes SET is_active = true WHERE id = $1`, [existing[0].id]);
    } else {
      const { rows } = await db._pool.query(
        `INSERT INTO certificate_purposes (name, sort_order) VALUES ($1,
           (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM certificate_purposes)) RETURNING id`,
        [name]);
      existing.push(rows[0]);
    }
    return res.json(await listToJson());
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

export const deletePurpose = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'Invalid purpose id' });
    await db._pool.query(`UPDATE certificate_purposes SET is_active = false WHERE id = $1`, [id]);
    return res.json(await listToJson());
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

async function listToJson() {
  const { rows } = await db._pool.query(
    `SELECT p.id, p.name,
            (SELECT COUNT(*)::int FROM certificate_templates t WHERE t.purpose = p.name) AS template_count
       FROM certificate_purposes p
      WHERE p.is_active = true
      ORDER BY p.sort_order ASC, p.name ASC`);
  return rows;
}

export const getTemplateFile = async (req, res) => {
  try {
    const { rows } = await db._pool.query(
      `SELECT template_file, template_key FROM certificate_templates WHERE id = $1`, [req.params.id]);
    if (!rows.length || !rows[0].template_file) return res.status(404).json({ message: 'Template file not found' });
    const buffer = await fetchFile(rows[0].template_file, rows[0].template_key);
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="template-${req.params.id}"`);
    return res.send(buffer);
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

export const getTemplate = async (req, res) => {
  try {
    const template = await loadTemplateDetail(req.params.id);
    if (!template) return res.status(404).json({ message: 'Template not found' });
    return res.json(template);
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

export const updateTemplate = async (req, res) => {
  try {
    const id = req.params.id;
    const template = await loadTemplateDetail(id);
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const { name, description, status, fields, ngo_id, purpose } = req.body || {};
    if (name !== undefined && String(name).trim()) {
      await db._pool.query(`UPDATE certificate_templates SET name = $1, updated_at = NOW() WHERE id = $2`,
        [String(name).trim().slice(0, 120), id]);
    }
    if (description !== undefined) {
      await db._pool.query(`UPDATE certificate_templates SET description = $1, updated_at = NOW() WHERE id = $2`,
        [String(description).slice(0, 500), id]);
    }
    if (purpose !== undefined) {
      await db._pool.query(`UPDATE certificate_templates SET purpose = $1, updated_at = NOW() WHERE id = $2`,
        [String(purpose).trim().slice(0, 120), id]);
    }
    if (ngo_id !== undefined) {
      const raw = String(ngo_id || '').trim();
      const next = raw && raw !== 'null' ? raw : null;
      await db._pool.query(`UPDATE certificate_templates SET ngo_id = $1, updated_at = NOW() WHERE id = $2`, [next, id]);
    }
    if (status !== undefined) {
      if (!VALID_STATUS.has(status)) return res.status(400).json({ message: 'Invalid status' });
      await db._pool.query(`UPDATE certificate_templates SET status = $1, updated_at = NOW() WHERE id = $2`, [status, id]);
    }
    if (fields !== undefined) {
      // All fields are mandatory per product rule.
      await replaceFields(id, (Array.isArray(fields) ? fields : []).map((f) => ({ ...f, required: true })));
      await syncFieldsWithPlaceholders(id, template.placeholders);
    } else {
      await syncFieldsWithPlaceholders(id, template.placeholders);
    }

    return res.json({ message: 'Template updated', template: await loadTemplateDetail(id) });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

export const reuploadTemplateFile = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Template file is required' });
    const id = req.params.id;
    const template = await loadTemplateDetail(id);
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const fmt = getPkgFormat(req.file.buffer);
    if (!fmt) return res.status(400).json({ message: 'Invalid file. Upload a valid .docx or .pptx template.' });
    if (fmt !== template.file_format) {
      return res.status(400).json({ message: `File format mismatch — current template is ${template.file_format.toUpperCase()}` });
    }

    const normalized = normalizePlaceholderWhitespace(req.file.buffer);
    const { placeholders } = detectPlaceholders(normalized);
    // A new file kills reproducibility of older certificates, so it becomes a
    // new immutable version. Old S3 objects are never overwritten.
    const version = (template.version || 1) + 1;
    const key = `templates/${id}-${slugify(template.name)}-v${version}.${fmt}`;
    const url = await uploadFile(key, normalized, req.file.mimetype);

    await db._pool.query(
      `UPDATE certificate_templates
          SET template_file = $1, template_key = $2, placeholders = $3, version = $4, updated_at = NOW()
        WHERE id = $5`,
      [url, key, JSON.stringify(placeholders), version, id]);
    await syncFieldsWithPlaceholders(id, placeholders);
    await autosnapshotTemplate(await loadTemplateDetail(id));

    return res.json({ message: 'Template file replaced', template: await loadTemplateDetail(id), detected: placeholders });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

export const setTemplatePreview = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Preview image is required' });
    const id = req.params.id;
    const template = await loadTemplateDetail(id);
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const ext = (() => {
      const m = /image\/(png|jpeg|jpg|webp|gif)/.exec(req.file.mimetype || '');
      return m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : 'png';
    })();
    if (!/^(png|jpg|webp|gif)$/.test(ext)) return res.status(400).json({ message: 'Only PNG, JPG, WEBP or GIF preview images are supported.' });

    await savePreviewImage(id, template, req.file.buffer, ext, req.file.mimetype || 'image/png');

    return res.json({ message: 'Preview image saved', template: await loadTemplateDetail(id) });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

export const snapshotAllTemplates = async (req, res) => {
  const { rows } = await db._pool.query(
    `SELECT id, name, file_format, template_file, template_key, preview_image, preview_key
       FROM certificate_templates`);
  const updated = [];
  let ok = 0;
  let skipped = 0;
  for (const r of rows) {
    try {
      const url = await autosnapshotTemplate(r);
      if (url) { updated.push({ id: r.id, name: r.name }); ok += 1; }
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return res.json({
    message: `Snapshot complete: ${ok} updated, ${skipped} skipped`,
    updated, ok, skipped,
  });
};

export const duplicateTemplate = async (req, res) => {
  try {
    const id = req.params.id;
    const template = await loadTemplateDetail(id);
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const storage = await fetchFile(template.template_file, template.template_key);
    const me = identity(req);
    const name = `${template.name} (copy)`;
    const { rows } = await db._pool.query(
      `INSERT INTO certificate_templates (name, description, file_format, template_file, template_key, placeholders, status, version, created_by, ngo_id, purpose)
       VALUES ($1, $2, $3, '', '', $4, 'draft', 1, $5, $6, $7) RETURNING id`,
      [name.slice(0, 120), template.description || '', template.file_format, JSON.stringify(template.placeholders), me.name || me.id, template.ngo_id || null, template.purpose || '']);
    const newId = rows[0].id;
    const fmt = template.file_format;
    const key = `templates/${newId}-${slugify(name)}-v1.${fmt}`;
    const url = await uploadFile(key, storage, `application/vnd.openxmlformats-officedocument.${fmt === 'pptx' ? 'presentationml.presentation' : 'wordprocessingml.document'}`);
    await db._pool.query(`UPDATE certificate_templates SET template_file = $1, template_key = $2 WHERE id = $3`, [url, key, newId]);

    await replaceFields(newId, template.fields.map((f, i) => ({
      field_key: f.field_key, display_name: f.display_name, field_type: f.field_type,
      required: f.required, default_value: f.default_value, sort_order: i,
    })));

    return res.json({ message: 'Template duplicated', template: await loadTemplateDetail(newId) });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

export const setTemplateStatus = async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!VALID_STATUS.has(status)) return res.status(400).json({ message: 'Invalid status' });
    const { rowCount } = await db._pool.query(
      `UPDATE certificate_templates SET status = $1, updated_at = NOW() WHERE id = $2`, [status, req.params.id]);
    if (!rowCount) return res.status(404).json({ message: 'Template not found' });
    return res.json({ message: `Template ${status === 'archived' ? 'archived' : status}` });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

export const deleteTemplate = async (req, res) => {
  try {
    const template = await loadTemplateDetail(req.params.id);
    if (!template) return res.status(404).json({ message: 'Template not found' });
    if (template.template_key) {
      await db.storage.from(BUCKET).remove(template.template_key).catch(() => {});
    }
    await db._pool.query('DELETE FROM certificate_templates WHERE id = $1', [req.params.id]);
    return res.json({ message: 'Template deleted. Generated certificates are kept in history.' });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

/* ------------------------------------- certificates ------------------------------------ */

export const previewCertificate = async (req, res) => {
  try {
    const { template_id, field_values, certificate_number } = req.body || {};
    if (!template_id) return res.status(400).json({ message: 'template_id is required' });
    const template = await loadTemplateDetail(template_id);
    if (!template) return res.status(404).json({ message: 'Template not found' });

    // Preview must never hard-block on missing required fields — render whatever
    // has been typed so far and leave the rest blank, so the preview updates as
    // the user fills each field. docxtemplater needs every tag present, so fill
    // every field with its typed value, default_value, or empty string.
    const raw = field_values || {};
    const values = {};
    for (const f of template.fields || []) {
      const v = raw[f.field_key];
      values[f.field_key] = v == null || String(v).trim() === ''
        ? String(f.default_value ?? '')
        : String(v);
    }
    for (const [k, v] of Object.entries(raw)) {
      if (v != null) values[k] = String(v);
    }
    if ((template.placeholders || []).some((p) => p.key === 'certificate_number')) {
      values.certificate_number = String(certificate_number ?? values.certificate_number ?? '');
    }

    const out = await renderFromTemplate(template, values);
    // Neither PowerPoint nor Word renders inline in a browser, so render the
    // filled first page/slide to PNG (LibreOffice headless) for a true
    // what-you-see-is-what-you-get live preview.
    if (out.ext === 'docx' || out.ext === 'pptx') {
      const png = await snapshotToPng(Buffer.from(out.buffer), out.ext);
      if (png) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', 'inline; filename="preview.png"');
        return res.send(Buffer.from(png));
      }
    }
    res.setHeader('Content-Type', out.mime);
    res.setHeader('Content-Disposition', `attachment; filename="preview.${out.ext}"`);
    return res.send(Buffer.from(out.buffer));
  } catch (e) {
    return res.status(400).json({ message: `Preview failed: ${e.message}` });
  }
};

async function generateOne(template, fieldValuesIn, certNumberIn, actorName) {
  const values = { ...(fieldValuesIn || {}) };
  const required = (template.fields || []).filter((f) => f.required);
  const missing = buildMissing(required, values);
  if (missing.length) return { error: `Missing required fields: ${missing.join(', ')}` };

  const number = String(certNumberIn || '').trim() || (await nextCertificateNumber());
  values.certificate_number = number;
  const recipient = String(values.recipient_name || values.name || values.recipient || '').trim().slice(0, 120);

  const out = await renderFromTemplate(template, values);
  const safeNum = slugify(number) || Date.now();
  const key = `generated/${template.id}-${slugify(template.name)}-${safeNum}.${out.ext}`;
  const url = await uploadFile(key, out.buffer, out.mime);

  const { rows } = await db._pool.query(
    `INSERT INTO certificates
       (template_id, template_name, template_version, template_file, certificate_number, recipient_name, field_values, generated_file, generated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [template.id, template.name, template.version, template.template_file, number, recipient,
     JSON.stringify(fieldValuesIn || {}), url, actorName]);
  return { certificate: rows[0] };
}

export const generateCertificate = async (req, res) => {
  try {
    const { template_id, field_values, certificate_number } = req.body || {};
    if (!template_id) return res.status(400).json({ message: 'template_id is required' });
    const template = await loadTemplateDetail(template_id);
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const me = identity(req);
    const result = await generateOne(template, field_values, certificate_number, me.name || me.id);
    if (result.error) return res.status(400).json({ message: result.error });
    return res.json({ message: 'Certificate generated', certificate: result.certificate });
  } catch (e) {
    return res.status(400).json({ message: `Generation failed: ${e.message}` });
  }
};

export const bulkGenerateCertificates = async (req, res) => {
  try {
    const { template_id, rows } = req.body || {};
    if (!template_id) return res.status(400).json({ message: 'template_id is required' });
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ message: 'rows must be a non-empty array' });
    if (rows.length > 200) return res.status(400).json({ message: 'Maximum 200 certificates per bulk run' });

    const template = await loadTemplateDetail(template_id);
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const me = identity(req);
    const results = [];
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i] || {};
      try {
        const result = await generateOne(template, row.field_values || {}, row.certificate_number, me.name || me.id);
        if (result.error) {
          failed += 1;
          results.push({ index: i, error: result.error, certificate_number: row.certificate_number || '' });
        } else {
          ok += 1;
          results.push({
            index: i,
            certificate: result.certificate,
            certificate_number: result.certificate.certificate_number,
            generated_file: result.certificate.generated_file,
          });
        }
      } catch (e) {
        failed += 1;
        results.push({ index: i, error: e.message, certificate_number: row.certificate_number || '' });
      }
    }

    return res.json({
      message: `Generated ${ok} of ${rows.length} certificate${rows.length === 1 ? '' : 's'}`,
      ok,
      failed,
      results,
    });
  } catch (e) {
    return res.status(400).json({ message: `Bulk generation failed: ${e.message}` });
  }
};

export const listCertificates = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`);
      where = `WHERE c.certificate_number ILIKE $1 OR c.recipient_name ILIKE $1 OR c.generated_file ILIKE $1`;
    }
    const { rows } = await db._pool.query(
      `SELECT c.id, c.template_id, c.template_name, c.template_version, c.template_file, c.certificate_number,
              c.recipient_name, c.field_values, c.generated_file, c.generated_by, c.generated_at
         FROM certificates c ${where}
        ORDER BY c.generated_at DESC
        LIMIT 300`, params);
    return res.json(rows);
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};

export const getCertificate = async (req, res) => {
  try {
    const { rows } = await db._pool.query(
      `SELECT id, template_id, template_name, template_version, template_file, certificate_number,
              recipient_name, field_values, generated_file, generated_by, generated_at
         FROM certificates WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Certificate not found' });
    return res.json(rows[0]);
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message });
  }
};
import { ZodError } from 'zod';
import { HttpError } from './HttpError.js';
import { WhatsAppApiError } from './whatsapp/client.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err, req, res, _next) {
  // body-parser rejects malformed JSON with a SyntaxError tagged as such
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  // Meta rejected our request. Surface the provider's own message, but keep the
  // HTTP status ours so callers never confuse 4xx-from-us with 5xx-from-them.
  if (err instanceof WhatsAppApiError) {
    console.error(
      'WhatsApp API error:',
      JSON.stringify({
        path: req.originalUrl,
        providerStatus: err.status ?? null,
        providerCode: err.code ?? null,
        providerType: err.type ?? null,
        message: err.message,
      })
    );
    return res.status(502).json({
      error: 'WhatsApp API error',
      details: {
        message: err.message,
        providerCode: err.code ?? null,
        providerType: err.type ?? null,
        providerStatus: err.status ?? null,
      },
    });
  }

  // Postgres unique violation is a conflict, not a server fault.
  if (err?.code === '23505') {
    return res.status(409).json({ error: err.message ?? 'Resource already exists' });
  }

  // Malformed id, or a foreign key pointing at a row that is gone.
  if (err?.code === '22P02' || err?.code === '23503') {
    return res.status(400).json({ error: err.message });
  }

  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) {
    console.error(err);
  }

  res.status(status).json({
    error: err.message ?? 'Internal server error',
    ...(err.details ? { details: err.details } : {}),
  });
}
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config, isLocalDevOrigin } from './config.js';
import { HttpError } from './lib/HttpError.js';
import { errorHandler, notFoundHandler } from './lib/error.middleware.js';
import { apiRouter } from './routes/index.js';
import { webhookRouter } from './webhooks/webhook.routes.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());

  // The webhook signature is computed over the exact bytes Meta sent, so the
  // raw body has to be captured before JSON parsing rewrites it.
  app.use(
    express.json({
      limit: '25mb',
      verify: (req, _res, buffer) => {
        req.rawBody = buffer;
      },
    })
  );

  // Meta's webhook calls come from outside the browser and carry no Origin, so
  // the allow-list must not reject header-less requests.
  //
  // In development a local Vite server may not be on the exact port listed in
  // CORS_ORIGIN (it moves when the port is busy), so any loopback origin is
  // accepted while NODE_ENV !== 'production'. Production stays strict: only the
  // configured CORS_ORIGIN list, no wildcard.
  const isProduction = config.env === 'production';

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (!isProduction && isLocalDevOrigin(origin)) return callback(null, true);
        if (config.corsOrigin.includes(origin)) return callback(null, true);
        return callback(new HttpError(403, `Origin not allowed: ${origin}`));
      },
    })
  );

  app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));

  app.use('/api', apiRouter);
  app.use('/webhooks', webhookRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
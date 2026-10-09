/**
 * Express 4 does not forward rejected promises to the error handler, so every
 * async handler has to be wrapped in this.
 */
export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
/**
 * @file Wrapper para handlers Express asíncronos.
 *
 * Express 4 no captura promesas rechazadas por defecto: hay que envolver los
 * handlers en un try/catch o pasar las excepciones a `next()`. Este helper
 * hace exactamente eso, manteniendo la firma estándar `(req, res, next)`.
 *
 * @module utils/async-handler
 *
 * @example
 *   router.get("/foo", asyncHandler(async (req, res) => {
 *     const items = await service.list();
 *     res.json({ items });
 *   }));
 */

/**
 * @template {import('express').RequestHandler} H
 * @param {H} fn
 * @returns {import('express').RequestHandler}
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;

/**
 * Extrae un mensaje legible del body de error de Business Central / OData.
 * Suele ser `error: { message: "..." }` (no un string en `error`).
 *
 * @param {unknown} json
 * @param {string} rawText
 * @param {number} httpStatus
 * @returns {string}
 */
function extractBcApiErrorMessage(json, rawText, httpStatus) {
  const fallbackRaw =
    typeof rawText === "string" && rawText.trim()
      ? rawText.trim().length > 600
        ? `${rawText.trim().slice(0, 600)}…`
        : rawText.trim()
      : "";

  if (json && typeof json === "object") {
    const top = /** @type {{ message?: unknown }} */ (json).message;
    if (typeof top === "string" && top.trim()) return top.trim().slice(0, 800);

    const rawOnly = /** @type {{ raw?: unknown }} */ (json).raw;
    if (typeof rawOnly === "string" && rawOnly.trim()) {
      const t = rawOnly.trim();
      return t.length > 600 ? `${t.slice(0, 600)}…` : t;
    }

    const errObj = /** @type {{ error?: unknown }} */ (json).error;

    if (typeof errObj === "string" && errObj.trim()) return errObj.trim().slice(0, 800);

    if (errObj && typeof errObj === "object") {
      const e = /** @type {{ message?: unknown; Message?: unknown; code?: unknown }} */ (
        errObj
      );
      if (typeof e.message === "string" && e.message.trim()) {
        return e.message.trim().slice(0, 800);
      }
      if (typeof e.Message === "string" && e.Message.trim()) {
        return e.Message.trim().slice(0, 800);
      }

      const inner = /** @type {{ innererror?: { message?: unknown; internalexception?: { message?: unknown } } }} */ (
        errObj
      );
      const innerMsg =
        inner.innererror?.internalexception &&
        typeof inner.innererror.internalexception.message === "string"
          ? inner.innererror.internalexception.message
          : inner.innererror &&
              typeof inner.innererror.message === "string"
            ? inner.innererror.message
            : null;
      if (innerMsg && String(innerMsg).trim()) return String(innerMsg).trim().slice(0, 800);

      if (typeof e.code === "string" && e.code.trim()) {
        return e.code.trim().slice(0, 800);
      }
    }
  }

  if (fallbackRaw) return fallbackRaw;

  return `Business Central respondió con HTTP ${httpStatus}`;
}

module.exports = {
  extractBcApiErrorMessage,
};

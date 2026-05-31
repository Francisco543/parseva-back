/**
 * Duración máxima de suscripción Microsoft Graph para mensajes de Outlook
 * sin `includeResourceData`. Graph devuelve ExtensionError si pedís más de
 * **10070 minutos** (~167,8 h): "Subscription expiration can only be 10070 minutes in the future."
 *
 * @see https://learn.microsoft.com/en-us/graph/api/resources/subscription
 *
 * @module constants/graph-subscription
 */
const OUTLOOK_MESSAGES_SUBSCRIPTION_MAX_MS = 10070 * 60 * 1000;

module.exports = {
  OUTLOOK_MESSAGES_SUBSCRIPTION_MAX_MS,
};

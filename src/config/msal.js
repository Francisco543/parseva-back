/**
 * @file Cliente MSAL singleton para el flujo de login de la app
 * (Authorization Code with PKCE).
 *
 * Es independiente del cliente de Graph (`lib/graph-client.js`) porque ese
 * usa client credentials por tenant del usuario final.
 *
 * @module config/msal
 */

const { ConfidentialClientApplication } = require("@azure/msal-node");
const env = require("./env");

const authority = `https://login.microsoftonline.com/${env.msalTenantId}`;

const msalClient = new ConfidentialClientApplication({
  auth: {
    clientId: env.msalClientId,
    authority,
    clientSecret: env.msalClientSecret,
  },
});

module.exports = {
  authority,
  msalClient,
};

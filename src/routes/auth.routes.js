/**
 * @file Endpoints de autenticación con Microsoft Identity (Authorization Code
 * with PKCE).
 *
 * Flujo:
 *  1. `GET  /auth/login`     → emite cookie con `state`/`verifier` y redirige a Azure.
 *  2. `GET  /auth/callback`  → recibe el `code`, lo intercambia por tokens,
 *                              hace upsert del usuario, asegura un workspace y
 *                              setea la cookie de sesión.
 *  3. `GET  /auth/me`        → devuelve el usuario y workspace actuales.
 *  4. `POST /auth/logout`    → limpia la cookie de sesión.
 *  5. `GET/POST /auth/workspaces` → listado y selección de workspace activo.
 *
 * @module routes/auth
 */

const express = require("express");
const crypto = require("node:crypto");
const { msalClient } = require("../config/msal");
const env = require("../config/env");
const { authenticateSession } = require("../middlewares/session-auth.middleware");
const { upsertUserFromToken } = require("../services/user.service");
const {
  ensureWorkspaceForUser,
  listWorkspacesForUser,
  getMembership,
} = require("../services/workspace.service");
const { createPkceCodes } = require("../utils/pkce");
const {
  getCookieOptions,
  signAuthFlow,
  readAuthFlow,
  signSession,
} = require("../lib/session");

const router = express.Router();

function buildSessionPayload(dbUser, claims, workspace, membership) {
  return {
    userId: dbUser.id,
    oid: claims.oid,
    tid: claims.tid,
    name: claims.name || "",
    email: claims.preferred_username || "",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceRole: membership.role,
  };
}

router.get("/auth/login", async (req, res, next) => {
  try {
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const { verifier, challenge } = createPkceCodes();

    const authUrl = await msalClient.getAuthCodeUrl({
      scopes: env.msalAuthScopes,
      redirectUri: env.msalRedirectUri,
      state,
      nonce,
      prompt: "select_account",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });

    const authFlowToken = signAuthFlow({ state, nonce, verifier });
    res.cookie(env.authFlowCookieName, authFlowToken, {
      ...getCookieOptions(),
      maxAge: 10 * 60 * 1000,
    });

    return res.redirect(authUrl);
  } catch (error) {
    return next(error);
  }
});

router.get("/auth/callback", async (req, res, next) => {
  try {
    const { code, state } = req.query;
    const flowToken = req.cookies?.[env.authFlowCookieName];

    if (!code || !state || !flowToken) {
      return res.status(400).json({ message: "Invalid auth callback request" });
    }

    const flow = readAuthFlow(flowToken);
    if (flow.state !== state) {
      return res.status(400).json({ message: "Invalid auth state" });
    }

    const tokenResult = await msalClient.acquireTokenByCode({
      code: String(code),
      scopes: env.msalAuthScopes,
      redirectUri: env.msalRedirectUri,
      codeVerifier: flow.verifier,
    });

    const claims = tokenResult?.idTokenClaims || {};
    const normalizedClaims = {
      oid: claims.oid || claims.sub,
      tid: claims.tid,
      name: claims.name,
      preferred_username: claims.preferred_username || claims.email,
      email: claims.email || claims.preferred_username,
    };

    if (!normalizedClaims.oid || !normalizedClaims.tid) {
      return res.status(400).json({ message: "Missing required token claims" });
    }

    const dbUser = await upsertUserFromToken(normalizedClaims);
    const { workspace, membership } = await ensureWorkspaceForUser({
      userId: dbUser.id,
      tid: normalizedClaims.tid,
      fallbackName:
        normalizedClaims.preferred_username?.split("@")[1] || normalizedClaims.tid,
    });
    const sessionToken = signSession(
      buildSessionPayload(dbUser, normalizedClaims, workspace, membership)
    );

    res.clearCookie(env.authFlowCookieName, getCookieOptions());
    res.cookie(env.sessionCookieName, sessionToken, {
      ...getCookieOptions(),
      maxAge: 8 * 60 * 60 * 1000,
    });

    return res.redirect(env.msalPostLoginRedirectUri);
  } catch (error) {
    return next(error);
  }
});

router.get("/auth/session", authenticateSession, (req, res) => {
  res.json({
    authenticated: true,
    user: req.user,
    dbUser: req.dbUser,
    workspace: req.workspace,
  });
});

router.get("/workspaces", authenticateSession, async (req, res, next) => {
  try {
    const memberships = await listWorkspacesForUser(req.dbUser.id);
    res.json({
      items: memberships.map((membership) => ({
        id: membership.workspace.id,
        name: membership.workspace.name,
        role: membership.role,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/auth/workspace/switch", authenticateSession, async (req, res, next) => {
  try {
    const workspaceId = req.body?.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ message: "workspaceId is required" });
    }

    const membership = await getMembership(req.dbUser.id, workspaceId);
    if (!membership) {
      return res.status(403).json({ message: "No membership for workspace" });
    }

    const sessionToken = signSession({
      userId: req.dbUser.id,
      oid: req.user.oid,
      tid: req.user.tid,
      name: req.user.name || "",
      email: req.user.preferred_username || "",
      workspaceId: membership.workspace.id,
      workspaceName: membership.workspace.name,
      workspaceRole: membership.role,
    });

    res.cookie(env.sessionCookieName, sessionToken, {
      ...getCookieOptions(),
      maxAge: 8 * 60 * 60 * 1000,
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

router.post("/auth/logout", (_req, res) => {
  res.clearCookie(env.sessionCookieName, getCookieOptions());
  res.clearCookie(env.authFlowCookieName, getCookieOptions());
  res.json({ ok: true });
});

module.exports = router;

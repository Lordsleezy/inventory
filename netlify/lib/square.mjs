/**
 * Square OAuth + token refresh (sandbox). Tokens stay in square_connections
 * via service role — never in the Capacitor app.
 *
 * Env (see .env.example):
 *   SQUARE_APPLICATION_ID, SQUARE_APPLICATION_SECRET
 *   SQUARE_ENVIRONMENT=sandbox|production
 *   SQUARE_REDIRECT_URL=https://<functions>/.netlify/functions/square-oauth-callback
 */
import { Client, Environment } from "square";

function env() {
  return (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase() === "production"
    ? Environment.Production
    : Environment.Sandbox;
}

export function squareClient(accessToken) {
  return new Client({ accessToken, environment: env() });
}

export function squareOAuthClient() {
  return new Client({
    environment: env(),
    // OAuth uses client credentials on obtainToken
  });
}

export async function exchangeSquareCode(code) {
  const client = new Client({ environment: env() });
  const { result } = await client.oAuthApi.obtainToken({
    clientId: process.env.SQUARE_APPLICATION_ID,
    clientSecret: process.env.SQUARE_APPLICATION_SECRET,
    code,
    grantType: "authorization_code",
    redirectUri: process.env.SQUARE_REDIRECT_URL,
  });
  return result;
}

export async function refreshSquareToken(refreshToken) {
  const client = new Client({ environment: env() });
  const { result } = await client.oAuthApi.obtainToken({
    clientId: process.env.SQUARE_APPLICATION_ID,
    clientSecret: process.env.SQUARE_APPLICATION_SECRET,
    refreshToken,
    grantType: "refresh_token",
  });
  return result;
}

import { serviceClient } from "../lib/server.mjs";
import { deliverOrderEmails } from "../lib/web-order-email.mjs";
// Netlify scheduled functions cannot be invoked through their public URL.
export const handler = async () => ({ statusCode: 200, body: JSON.stringify(await deliverOrderEmails(serviceClient())) });

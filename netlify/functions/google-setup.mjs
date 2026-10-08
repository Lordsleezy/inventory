import { timingSafeEqual } from 'node:crypto';
import { json, serviceClient } from '../lib/server.mjs';
import { merchantAccessToken, merchantRequest } from '../lib/google-merchant.mjs';
import { wrapHandler } from '../lib/floor-log.mjs';
import { handler as googleReconcileHandler } from './google-reconcile.mjs';
import { handler as googleSyncHandler } from './google-sync.mjs';

const siteUrl = 'https://openboxindustries.com';
const accountId = () => process.env.GOOGLE_MERCHANT_ACCOUNT_ID;

function authorized(event) {
  const expected = process.env.GOOGLE_MERCHANT_SETUP_KEY;
  const actual = event.headers?.authorization || event.headers?.Authorization || '';
  if (!expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function siteRequest(path, method, body) {
  const token = await merchantAccessToken();
  const response = await fetch(`https://www.googleapis.com/siteVerification/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Site Verification API ${response.status}: ${data.error?.message || "request_failed"}`);
  return data;
}

async function handle(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!authorized(event)) return json(404, { error: 'not_found' });
  try {
    const { action } = JSON.parse(event.body || '{}');
    const account = accountId();
    if (!account) return json(503, { error: 'merchant_account_not_configured' });

    if (action === 'sync-reconcile' || action === 'sync-now') {
      const fn = action === 'sync-reconcile' ? googleReconcileHandler : googleSyncHandler;
      const result = await fn({ httpMethod: 'POST', body: '{}' }, {});
      return json(result.statusCode || 200, JSON.parse(result.body || '{}'));
    }

    if (action === 'product-statuses') {
      const products = [];
      let pageToken = '';
      do {
        const query = new URLSearchParams({ pageSize: '250', ...(pageToken ? { pageToken } : {}) });
        const page = await merchantRequest(`products/v1/accounts/${account}/products?${query}`);
        products.push(...(page.products || []));
        pageToken = page.nextPageToken || '';
      } while (pageToken);
      return json(200, { products: products.map((product) => ({
        offerId: product.offerId, title: product.title,
        destinationStatuses: product.productStatus?.destinationStatuses || [],
        itemLevelIssues: product.productStatus?.itemLevelIssues || [],
      })) });
    }

    if (action === 'queue-errors') {
      const { data, error } = await serviceClient()
        .from('google_sync_queue').select('sku,action,attempts,last_error,queued_at').order('queued_at').limit(100);
      if (error) throw error;
      return json(200, { queued: data || [] });
    }

    if (action === 'site-token') {
      const result = await siteRequest('token', 'POST', {
        site: { type: 'SITE', identifier: siteUrl }, verificationMethod: 'META',
      });
      return json(200, { token: result.token });
    }

    if (action === 'site-verify') {
      const result = await siteRequest('webResource?verificationMethod=META', 'POST', {
        site: { type: 'SITE', identifier: siteUrl }, owners: ['pgg124@gmail.com'],
      });
      return json(200, { verified: true, site: result.site?.identifier || siteUrl });
    }

    if (action === 'merchant-setup') {
      try {
        await merchantRequest(`accounts/v1alpha/accounts/${account}/developerRegistration:registerGcp`, 'POST', {
          developerEmail: 'pgg124@gmail.com',
        });
      } catch (error) {
        if (!String(error).includes('already registered')) throw error;
      }

      await merchantRequest(`accounts/v1/accounts/${account}?updateMask=accountName`, 'PATCH', {
        name: `accounts/${account}`, accountName: 'Open Box Industries',
      });
      await merchantRequest(`accounts/v1/accounts/${account}/businessInfo?updateMask=address,customerService`, 'PATCH', {
        name: `accounts/${account}/businessInfo`,
        address: {
          regionCode: 'US', addressLines: ['3121 Penryn Rd'], locality: 'Penryn',
          administrativeArea: 'CA', postalCode: '95663',
        },
        customerService: {
          uri: `${siteUrl}/contact`, email: 'sales@openboxindustries.com',
          phone: { e164Number: '+12799770722' },
        },
      });

      const homePath = `accounts/v1/accounts/${account}/homepage`;
      let homepage;
      try { homepage = await merchantRequest(homePath); }
      catch (error) {
        if (!String(error).includes('404')) throw error;
      }
      if (homepage?.claimed) {
        if (homepage.uri !== siteUrl) homepage = await merchantRequest(`${homePath}?updateMask=uri`, 'PATCH', { name: `accounts/${account}/homepage`, uri: siteUrl });
      } else {
        homepage = await merchantRequest(`${homePath}?updateMask=uri`, 'PATCH', { name: `accounts/${account}/homepage`, uri: siteUrl });
      }
      await merchantRequest(`${homePath}:claim`, 'POST', {});

      const dsPath = `datasources/v1/accounts/${account}/dataSources`;
      const dsList = await merchantRequest(dsPath);
      let dataSource = (dsList.dataSources || []).find((item) => item.displayName === 'Open Box Industries API Products' && item.input === 'API');
      if (!dataSource) dataSource = await merchantRequest(dsPath, 'POST', {
        displayName: 'Open Box Industries API Products',
        primaryProductDataSource: { feedLabel: 'US', contentLanguage: 'en', countries: ['US'] },
      });

      const rpPath = `accounts/v1/accounts/${account}/onlineReturnPolicies`;
      const rpList = await merchantRequest(rpPath);
      const usPolicies = (rpList.onlineReturnPolicies || []).filter((item) => (item.countries || []).includes('US'));
      const defaultPolicy = usPolicies.find((item) => !item.label);
      let returnPolicy = defaultPolicy;
      if (!defaultPolicy || defaultPolicy.policy?.type !== 'NO_RETURNS' || defaultPolicy.returnPolicyUri !== `${siteUrl}/returns`) {
        if (defaultPolicy) await merchantRequest(`${rpPath}/${encodeURIComponent(defaultPolicy.returnPolicyId)}`, 'DELETE');
        returnPolicy = await merchantRequest(rpPath, 'POST', {
          countries: ['US'], policy: { type: 'NO_RETURNS' }, returnPolicyUri: `${siteUrl}/returns`,
        });
      }

      const freeListings = await merchantRequest(`accounts/v1/accounts/${account}/programs/free-listings:enable`, 'POST', {});

      return json(200, {
        accountId: account, accountName: 'Open Box Industries',
        homepageClaimed: true, businessInfoUpdated: true,
        dataSourceId: dataSource.dataSourceId,
        returnPolicyId: returnPolicy.returnPolicyId,
        freeListingsState: freeListings.state,
        freeListingsUnmetRequirements: (freeListings.unmetRequirements || []).map((item) => item.title),
      });
    }

    return json(400, { error: 'unknown_action' });
  } catch (error) {
    return json(502, { error: String(error?.message || 'setup_failed').slice(0, 160) });
  }
}

export const handler = wrapHandler('google-setup', handle);

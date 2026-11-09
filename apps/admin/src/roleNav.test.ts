import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESK_GROUPS, deskAllowedPages, deskNavGroups, phoneTabIds, resolveDeskAccess } from './deskNav.ts';

const root = path.dirname(fileURLToPath(import.meta.url));

function labelsIn(src: string): string[] {
  return [...src.matchAll(/<Icon[^/]*\/>\s*([^<]+)/g)].map((m) => m[1].trim());
}

test('phone tab bar: catch-all last; admin and owner share register + locations', () => {
  assert.deepEqual(phoneTabIds('admin'), ['inventory', 'receive', 'register', 'orders', 'locations', 'more']);
  assert.deepEqual(phoneTabIds('owner'), ['inventory', 'receive', 'register', 'orders', 'locations', 'more']);
  assert.deepEqual(phoneTabIds('staff'), ['inventory', 'receive', 'register', 'orders', 'locations', 'settings']);
});

test('desktop nav: admin keeps channels and money, owner and staff do not', () => {
  const admin = deskNavGroups('admin').flatMap((g) => g.links.map((l) => l.label));
  const owner = deskNavGroups('owner').flatMap((g) => g.links.map((l) => l.label));
  const staff = deskNavGroups('staff').flatMap((g) => g.links.map((l) => l.label));
  for (const label of ['Live Sales', 'Returns', 'Receipts', 'eBay', 'Depop', 'Amazon', 'TikTok', 'Dropship', 'Connections', 'Insights', 'Logs']) {
    assert.ok(admin.includes(label), label);
    assert.equal(owner.includes(label), false, `owner leaked ${label}`);
    assert.equal(staff.includes(label), false, `staff leaked ${label}`);
  }
  assert.ok(admin.includes('Cameras'));
  assert.ok(owner.includes('Cameras'));
  assert.equal(staff.includes('Cameras'), false);
  assert.deepEqual(owner, ['Register', 'Orders', 'Inventory', 'Receive', 'Manifests', 'Locations', 'Reports', 'Books', 'Safe', 'Cameras', 'Settings']);
  assert.deepEqual(staff, ['Register', 'Inventory', 'Receive', 'Orders', 'Locations', 'Settings']);
  assert.equal(deskNavGroups('admin'), DESK_GROUPS);
  assert.equal(deskAllowedPages('admin'), null);
  assert.equal(deskAllowedPages('owner')?.includes('ebay'), false);
  assert.equal(deskAllowedPages('owner')?.includes('cameras'), true);
  assert.equal(deskAllowedPages('staff')?.includes('reports'), false);
});

test('an account with no role never gets the admin desk', () => {
  for (const role of [null, undefined, '', 'clerk', 'associate', 'unknown']) {
    assert.equal(resolveDeskAccess(role, false), 'staff', String(role));
  }
  assert.equal(resolveDeskAccess('owner', true), 'admin');
  assert.equal(resolveDeskAccess('owner', false), 'owner');
  assert.equal(resolveDeskAccess('staff', false), 'staff');
});

test('phone More, inventory, orders, and item pages follow the same three desks', async () => {
  const more = await readFile(path.join(root, 'appMode', 'AppMore.tsx'), 'utf8');
  const home = more.slice(more.indexOf('export function AppMoreHome'), more.indexOf('export function AppMoreOther'));
  const adminMore = labelsIn(home.slice(home.indexOf('fullAccess ? ('), home.indexOf('ownerAccess ? (')));
  const ownerBlock = more.slice(more.indexOf('function OwnerMoreHome'), more.indexOf('export function AppMoreHome'));
  const ownerMore = [...ownerBlock.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  const other = labelsIn(more.slice(more.indexOf('export function AppMoreOther'), more.indexOf('Rows from')));
  assert.deepEqual(adminMore, ['Live sales', 'Receipts', 'Register', 'Safe', 'Reports', 'Books', 'Locations', 'Other']);
  assert.deepEqual(ownerMore, ['Manifests', 'Locations', 'Reports', 'Books', 'Safe', 'Cameras', 'Settings']);
  for (const label of ['eBay', 'Amazon', 'TikTok', 'Depop', 'Connections & sync', 'Dropship', 'Insights']) {
    assert.ok(other.includes(label), label);
    assert.equal(ownerMore.includes(label), false, `owner More leaked ${label}`);
  }

  const inventory = await readFile(path.join(root, 'appMode', 'AppInventory.tsx'), 'utf8');
  const adminFilters = inventory.slice(inventory.indexOf("] : ["), inventory.indexOf(']) as [Filter'));
  const staffFilters = inventory.slice(inventory.indexOf('staffMode ? ['), inventory.indexOf('] : ['));
  for (const label of ['Listed', 'Not ready', 'Sold', 'Needs check', 'No location', 'Never list']) {
    assert.match(adminFilters, new RegExp(label));
    assert.doesNotMatch(staffFilters, new RegExp(label === 'Sold' ? 'Listed' : label));
  }
  assert.match(staffFilters, /In stock/);
  assert.match(staffFilters, /Sold/);
  assert.match(inventory, /fullAccess && <span className="app-row-price">\{u\.sold_price_cents/);
  assert.match(inventory, /staffMode && filter === 'sold'/);

  const orders = await readFile(path.join(root, 'appMode', 'AppOrders.tsx'), 'utf8');
  const adminOrders = orders.slice(orders.indexOf('isAdmin ? ['), orders.indexOf('] : ['));
  const staffOrders = orders.slice(orders.indexOf('] : ['), orders.indexOf(']) as [Seg'));
  for (const label of ['Needs label', 'Shipped', 'Delivered', 'Canceled']) {
    assert.match(adminOrders, new RegExp(label));
    assert.doesNotMatch(staffOrders, new RegExp(label));
  }
  assert.match(staffOrders, /To ship/);
  assert.match(staffOrders, /Packaged/);
  assert.match(orders, /hideMoney=\{!isAdmin\}/);

  const item = await readFile(path.join(root, 'appMode', 'AppItemDetail.tsx'), 'utf8');
  assert.match(item, /staffMode \? 'staff_inventory_detail' : 'portal_inventory_detail'/);
  assert.match(item, /const cost = !staffMode && unit\?\.acquisition_cost_cents/);
  assert.match(item, /const profit = !moneyHidden && !staffMode \? profitAfterFeesCents/);

  const shell = await readFile(path.join(root, 'appMode', 'AppModeShell.tsx'), 'utf8');
  assert.match(shell, /staffMode=\{!fullAccess\}/);
  assert.match(shell, /isAdmin=\{fullAccess\}/);
  assert.match(shell, /phoneTabIds\(deskKind\)/);
});

test('admin membership is an explicit portal_admins row, and Steve is not one', async () => {
  const dir = path.join(root, '..', '..', '..', 'supabase', 'migrations');
  const names = (await readFile(path.join(dir, '20261228150000_restore_admin_desk.sql'), 'utf8'));
  assert.match(names, /f17e6163-b10a-4fe1-a373-75c0094e5363/);
  assert.match(names, /steve@steve\.com/);
  assert.match(names, /delete from public\.portal_admins/);
  assert.doesNotMatch(names, /portal_is_admin/);
});

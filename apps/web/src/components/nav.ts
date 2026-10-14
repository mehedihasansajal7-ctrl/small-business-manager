import type { MessageKey } from '../i18n';
import { hasAnyPermission, hasPermission } from '../api/permissions';

/** Navigation model, gated by the permissions the business API returned. */

export interface NavItem {
  readonly path: string;
  readonly key: MessageKey;
  readonly icon: string;
  /** Any one of these permissions makes the item visible. */
  readonly permissions?: readonly string[];
  /** Shown in the mobile bottom bar. */
  readonly primary?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = Object.freeze([
  { path: '/', key: 'nav.dashboard', icon: '📊', permissions: ['report.view', 'finance.view'], primary: true },
  { path: '/sales', key: 'nav.sales', icon: '🧾', permissions: ['sale.view', 'sale.create'], primary: true },
  { path: '/inventory', key: 'nav.inventory', icon: '📦', permissions: ['inventory.view'], primary: true },
  { path: '/purchases', key: 'nav.purchases', icon: '🚚', permissions: ['purchase.view', 'purchase.manage'] },
  { path: '/finance', key: 'nav.finance', icon: '💰', permissions: ['finance.view', 'finance.manage'], primary: true },
  { path: '/catalog', key: 'nav.catalog', icon: '🗂', permissions: ['product.view', 'customer.view', 'supplier.view'] },
  { path: '/reports', key: 'nav.reports', icon: '📈', permissions: ['report.view'] },
  { path: '/farming', key: 'nav.farming', icon: '🌾', permissions: ['farming.view'], primary: true },
  { path: '/team', key: 'nav.team', icon: '👥', permissions: ['member.view'] },
  { path: '/settings', key: 'nav.settings', icon: '⚙️', permissions: ['business.view'] },
  { path: '/ai', key: 'nav.ai', icon: '🤖', permissions: ['ai.use'] },
  { path: '/sync', key: 'nav.sync', icon: '🔄' },
]);

export function visibleNavItems(permissions: readonly string[]): NavItem[] {
  return NAV_ITEMS.filter((item) => {
    if (!item.permissions) return true;
    if (item.permissions.length === 1) return hasPermission(permissions, item.permissions[0] as string);
    return hasAnyPermission(permissions, item.permissions);
  });
}

/** Which nav item is active for a route path. */
export function isActive(path: string, itemPath: string): boolean {
  if (itemPath === '/') return path === '/' || path === '';
  return path === itemPath || path.startsWith(`${itemPath}/`);
}

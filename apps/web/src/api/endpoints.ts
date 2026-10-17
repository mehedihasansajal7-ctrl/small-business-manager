import { apiDownload, apiRequest } from './client';
import type {
  AuditRow,
  BusinessCurrent,
  ConflictRow,
  CreatedInvite,
  CustomerRow,
  InventoryRow,
  InviteRow,
  LocationRow,
  MeResponse,
  MemberRow,
  MovementRow,
  ProductRow,
  PushResultRow,
  SupplierRow,
  UnitRow,
  VisibilitySettings,
} from './types';

/** Auth, tenancy, catalog and inventory endpoints. */

export const auth = {
  register: (body: { email: string; password: string; displayName: string; businessName?: string }) =>
    apiRequest<{ user: MeResponse['user']; businessId: string | null; expiresAt: string }>('/api/auth/register', { method: 'POST', body }),
  login: (body: { email: string; password: string; businessId?: string }) =>
    apiRequest<{ user: MeResponse['user']; businesses: MeResponse['businesses']; businessId: string | null }>('/api/auth/login', {
      method: 'POST',
      body,
      anonymous: true,
    }),
  logout: () => apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST', body: {} }),
  me: () => apiRequest<MeResponse>('/api/auth/me'),
  acceptInvite: (code: string) => apiRequest<{ businessId: string; role: string }>('/api/invites/accept', { method: 'POST', body: { code } }),
  /** Redeem a one-time reset code (anonymous - the person cannot sign in yet). */
  resetPassword: (body: { email: string; code: string; newPassword: string }) =>
    apiRequest<{ ok: boolean; email: string }>('/api/auth/password/reset', { method: 'POST', body, anonymous: true }),
  /** Change your own password while signed in. */
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    apiRequest<{ ok: boolean }>('/api/auth/password/change', { method: 'POST', body }),
};

export const businesses = {
  current: () => apiRequest<BusinessCurrent>('/api/businesses/current'),
  create: (body: { name: string; currency?: string; timezone?: string; locale?: string }) =>
    apiRequest<{ id: string; name: string; slug: string; role: string }>('/api/businesses', { method: 'POST', body }),
  switch: (businessId: string) => apiRequest<{ ok: boolean; businessId: string }>('/api/businesses/switch', { method: 'POST', body: { businessId } }),
  patch: (body: Record<string, unknown>) => apiRequest<Record<string, unknown>>('/api/businesses/current', { method: 'PATCH', body }),
  settings: () => apiRequest<VisibilitySettings>('/api/businesses/settings'),
  updateSettings: (body: VisibilitySettings) => apiRequest<VisibilitySettings>('/api/businesses/settings', { method: 'PUT', body }),
};

export const members = {
  list: () => apiRequest<MemberRow[]>('/api/members'),
  createInvite: (body: { role: string; email?: string; ttlHours?: number }) => apiRequest<CreatedInvite>('/api/members/invites', { method: 'POST', body }),
  invites: () => apiRequest<InviteRow[]>('/api/members/invites'),
  revokeInvite: (id: string) => apiRequest<{ ok: boolean }>(`/api/members/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  update: (id: string, body: { role?: string; status?: string; grants?: string[]; denials?: string[] }) =>
    apiRequest<{ ok: boolean }>(`/api/members/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  /** Issue a one-time password reset code. The code is returned exactly once. */
  resetCode: (id: string) =>
    apiRequest<{ email: string; displayName: string; code: string; expiresAt: string; note: string }>(
      `/api/members/${encodeURIComponent(id)}/reset-code`,
      { method: 'POST', body: {} },
    ),
  audit: (limit = 100) => apiRequest<AuditRow[]>('/api/audit', { query: { limit } }),
};

export const catalog = {
  units: (dimension?: string) => apiRequest<UnitRow[]>('/api/units', { query: { dimension } }),
  createConversion: (body: { from: string; to: string; factor: string; note: string; itemId?: string; id?: string }) =>
    apiRequest<{ id: string }>('/api/units/conversions', { method: 'POST', body }),
  locations: () => apiRequest<LocationRow[]>('/api/locations'),
  createLocation: (body: { name: string; kind?: string; address?: string }) => apiRequest<{ id: string }>('/api/locations', { method: 'POST', body }),
  products: (query: { search?: string; kind?: string } = {}) => apiRequest<ProductRow[]>('/api/products', { query }),
  createProduct: (body: Record<string, unknown>) => apiRequest<ProductRow>('/api/products', { method: 'POST', body }),
  updateProduct: (id: string, body: Record<string, unknown>) => apiRequest<ProductRow>(`/api/products/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  customers: (search?: string) => apiRequest<CustomerRow[]>('/api/customers', { query: { search } }),
  createCustomer: (body: { name: string; phone?: string; email?: string; address?: string; openingBalance?: string; creditLimit?: string }) =>
    apiRequest<{ id: string }>('/api/customers', { method: 'POST', body }),
  suppliers: (search?: string) => apiRequest<SupplierRow[]>('/api/suppliers', { query: { search } }),
  createSupplier: (body: { name: string; phone?: string; email?: string; address?: string; openingBalance?: string }) =>
    apiRequest<{ id: string }>('/api/suppliers', { method: 'POST', body }),
};

export const inventory = {
  list: () => apiRequest<InventoryRow[]>('/api/inventory'),
  movements: (itemId?: string) => apiRequest<MovementRow[]>('/api/inventory/movements', { query: { itemId } }),
  adjust: (body: { itemId: string; direction: 'IN' | 'OUT'; quantity: string; unit: string; reason: string; unitCost?: string; allowNegative?: boolean }) =>
    apiRequest<{ id: string }>('/api/inventory/adjust', { method: 'POST', body }),
};

export const sync = {
  push: (events: readonly unknown[]) => apiRequest<{ results: PushResultRow[] }>('/api/sync/push', { method: 'POST', body: { events } }),
  /** The raw pull payload; cached by `src/offline/merge.ts`. */
  pull: (since: string) => apiRequest<Record<string, unknown>>('/api/sync/pull', { query: { since } }),
  conflicts: () => apiRequest<ConflictRow[]>('/api/sync/conflicts'),
  resolveConflict: (id: string, resolution: 'LOCAL_WINS' | 'SERVER_WINS') =>
    apiRequest<{ ok: boolean }>(`/api/sync/conflicts/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: { resolution } }),
};

export const health = {
  ping: () => apiRequest<{ status: string; time: string }>('/api/health'),
};

export const reports = {
  exportCsv: (table: string) => apiDownload(`/api/reports/export/${encodeURIComponent(table)}`),
  backup: () => apiDownload('/api/reports/backup'),
};

export const attachments = {
  list: (entityType: string, entityId: string) =>
    apiRequest<readonly { id: string; fileName: string; mime: string; sizeBytes: number; checksum: string; createdAt: string }[]>(
      `/api/attachments/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
    ),
  upload: async (entityType: string, entityId: string, file: File) => {
    const response = await fetch(`/api/attachments/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}?fileName=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) throw new Error(`Upload failed (${response.status})`);
    return (await response.json()) as { id: string; fileName: string; sizeBytes: number; checksum: string };
  },
};

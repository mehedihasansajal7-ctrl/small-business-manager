import type { Permission } from '@sbm/domain';
import type { ReactNode } from 'react';

import { useAuth } from '../auth/AuthProvider';
import { useI18n } from '../i18n';
import { RestrictedBlock } from './Notice';

/**
 * UI permission gate.
 *
 * IMPORTANT: this is a convenience, not a security boundary. The server enforces
 * every permission with `assertPermission` and the sync service re-checks on
 * apply, so a gate can only hide or explain — it can never grant access. That is
 * exactly why a denied action shows *why* it is denied instead of vanishing.
 */
export function PermissionGate({
  permission,
  permissions,
  mode = 'block',
  children,
}: {
  permission?: Permission;
  permissions?: readonly Permission[];
  /** `hide` renders nothing, `block` renders the restricted explanation. */
  mode?: 'hide' | 'block';
  children: ReactNode;
}) {
  const { can, canAll } = useAuth();
  const { t } = useI18n();

  const allowed = permissions ? canAll(permissions) : permission ? can(permission) : true;
  if (allowed) return <>{children}</>;
  if (mode === 'hide') return null;

  return <RestrictedBlock title={t('common.restricted')} body={t('common.restrictedBody')} />;
}

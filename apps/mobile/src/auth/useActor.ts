import { useMemo } from 'react';

import { useAuth } from './AuthProvider';
import type { Actor } from '../offline/repository';

/**
 * The identity a local write is attributed to.
 *
 * Outbox events carry `actorId` (the user) and `deviceId` (the phone). The server
 * uses them for audit and for reporting who changed what, so they must come from
 * the signed-in session and never from anything the UI can type.
 *
 * Returns `null` while the session is still loading, which is why every writer
 * guards on it.
 */
export function useActor(): Actor | null {
  const { businessId, user } = useAuth();
  return useMemo(() => (businessId && user ? { businessId, actorId: user.id } : null), [businessId, user]);
}

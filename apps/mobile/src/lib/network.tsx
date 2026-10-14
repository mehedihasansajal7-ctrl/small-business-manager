import NetInfo from '@react-native-community/netinfo';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Connectivity.
 *
 * Needed because the app must *say* when it is offline rather than silently
 * queueing — the spec is explicit that a partner must always know whether a
 * record has been shared. `ACCESS_NETWORK_STATE` is the only network permission
 * the manifest requests; no location, no background tracking.
 *
 * `isConnected === null` happens briefly on Android before the first callback
 * resolves, and `isInternetReachable` can stay `null` on some devices: we treat
 * "unknown" as online so the UI does not flash an offline banner, and rely on
 * the actual request failing (which the API client reports as `offline: true`)
 * if there really is no connectivity.
 */

export interface NetworkValue {
  readonly online: boolean;
  readonly connectionType: string | null;
}

const NetworkContext = createContext<NetworkValue>({ online: true, connectionType: null });

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(true);
  const [connectionType, setConnectionType] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    NetInfo.fetch()
      .then((state) => {
        if (cancelled) return;
        setConnectionType(state.type ?? null);
        if (state.isConnected === false || state.isInternetReachable === false) setOnline(false);
      })
      .catch(() => undefined);

    const unsubscribe = NetInfo.addEventListener((state) => {
      setConnectionType(state.type ?? null);
      const reachable = state.isInternetReachable;
      if (state.isConnected === false || reachable === false) setOnline(false);
      else if (state.isConnected === true) setOnline(true);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const value = useMemo<NetworkValue>(() => ({ online, connectionType }), [online, connectionType]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkValue {
  return useContext(NetworkContext);
}

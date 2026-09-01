import { useEffect, useSyncExternalStore } from 'react';
import type { ApplicationStore } from './store';
import type { ApplicationState } from './state';

export function useApplicationStore(store: ApplicationStore): ApplicationState {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  useEffect(() => {
    void store.initialize();
    return () => { void store.dispose(); };
  }, [store]);
  return state;
}

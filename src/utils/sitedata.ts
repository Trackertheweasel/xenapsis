// Every site opened in Persec shares Persec's origin, so cookies and storage saved by one
// site can be read by others. This wipes everything sites have saved, but keeps Persec's
// own settings and the proxy engines' configuration.

const KEEP_DATABASES = new Set(['PersecDB', '$scramjet', '__op', 'localforage']);
// Object stores holding site data inside the proxy engines' own databases.
const SITE_STORES: Record<string, string[]> = {
  $scramjet: ['cookies', 'redirectTrackers', 'referrerPolicies'],
  __op: ['cookies'],
};

function clearStores(dbName: string, stores: string[]): Promise<void> {
  return new Promise(resolve => {
    const req = indexedDB.open(dbName);
    req.onerror = () => resolve();
    req.onsuccess = () => {
      const db = req.result;
      const present = stores.filter(s => db.objectStoreNames.contains(s));
      if (!present.length) {
        db.close();
        return resolve();
      }
      const tx = db.transaction(present, 'readwrite');
      present.forEach(s => tx.objectStore(s).clear());
      const done = () => {
        db.close();
        resolve();
      };
      tx.oncomplete = done;
      tx.onerror = done;
      tx.onabort = done;
    };
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise(resolve => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

// The service worker keeps Scramjet's cookies in memory too, so reset those first.
async function clearServiceWorkerCookies(): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration();
  const sw = reg?.active;
  if (!sw) return;
  await new Promise<void>(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    sw.postMessage({ type: 'CLEAR_SITE_DATA' }, [channel.port2]);
    setTimeout(resolve, 2000);
  });
}

export async function clearSiteData(): Promise<void> {
  await clearServiceWorkerCookies();

  await Promise.all(Object.entries(SITE_STORES).map(([db, stores]) => clearStores(db, stores)));

  const dbs = (await indexedDB.databases?.()) ?? [];
  await Promise.all(
    dbs
      .map(d => d.name)
      .filter((name): name is string => !!name && !KEEP_DATABASES.has(name))
      .map(deleteDatabase),
  );

  localStorage.clear();
  sessionStorage.clear();
  if ('caches' in self) {
    await Promise.all((await caches.keys()).map(k => caches.delete(k)));
  }
}

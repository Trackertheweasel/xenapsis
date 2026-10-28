// Sends a message to Persec's service worker (src/sw.js): to the one controlling this page, or,
// before one does (a first visit), to the registration's once it is ready. Without a service
// worker there is nothing to tell.
export function postToServiceWorker(msg: unknown) {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  if (sw.controller) sw.controller.postMessage(msg);
  else sw.ready.then(reg => reg.active?.postMessage(msg));
}

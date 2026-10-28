import ConfigAPI from './config';

// about:blank cloaking: reopens Persec inside a blank-looking tab, then sends this tab to the panic
// address, so the browser's history shows neither. Used by Menu → AB Cloak and by Settings.
export async function openInAboutBlank(): Promise<void> {
  if (top?.location.href === 'about:blank') return;

  // A blocked pop-up leaves Persec where it is, rather than sending it away with nowhere to go.
  const win = window.open();
  if (!win) return;

  if (top?.window) {
    let panicLoc = 'https://google.com';
    try {
      panicLoc = String((await ConfigAPI.get('panicLoc')) ?? panicLoc);
    } catch {}
    top.window.location.href = panicLoc;
  }

  const viewport = win.document.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1';
  win.document.head.appendChild(viewport);
  const iframe = win.document.createElement('iframe');
  iframe.style.cssText =
    'width:100%;height:100vh;height:100dvh;border:0;margin:0;padding:0;display:block';
  iframe.src = `${location.origin}/`;
  win.document.body.style.margin = '0';
  win.document.title = 'about:blank';
  win.document.body.appendChild(iframe);
}

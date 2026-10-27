import type { IncomingMessage, ServerResponse } from 'node:http';

// Search suggestions for the address bar. A plain Node handler so the production server and the
// dev server (astro.config.ts) run the same code. Only the typed words go to DuckDuckGo.
export async function handleQuery(req: IncomingMessage, res: ServerResponse) {
  const urlObj = new URL(req.url ?? '', 'http://localhost');
  const search = urlObj.searchParams.get('q');
  if (!search) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Query parameter "q" is required.' }));
    return;
  }
  try {
    const response = await fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(search)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      // Without a timeout, a slow DuckDuckGo leaves requests hanging until the client gives up.
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      res.statusCode = response.status;
      res.end(JSON.stringify({ error: 'Failed to fetch suggestions.' }));
      return;
    }
    const data = await response.json();
    const suggestions = Array.isArray(data) ? data.map((d: any) => d.phrase).filter(Boolean) : [];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ suggestions }));
  } catch (err) {
    console.error('Backend suggestion error:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Internal server error.' }));
  }
}

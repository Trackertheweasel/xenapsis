// The sites a server-side browser session may be pointed at, by Persec itself. The client's Web AI
// page lists the same two (src/utils/webai.ts; tests/webai.test.ts keeps them in step). These are
// the sites' ordinary public addresses: nothing here names an API endpoint.
//
// This only limits where Persec's own API sends a session. Once a site is open, its pages navigate
// wherever they need to (sign-in providers, CDNs) like in any browser; the runtime still refuses
// non-web schemes and internal addresses for every request (see url.ts and camoufox.ts).

export interface BrowserSite {
  id: 'chatgpt' | 'claude';
  name: string;
  start: string;
  // The site's own hosts, and their subdomains, that the navigate API accepts.
  hosts: string[];
}

export const BROWSER_SITES: readonly BrowserSite[] = [
  { id: 'chatgpt', name: 'ChatGPT', start: 'https://chatgpt.com/', hosts: ['chatgpt.com'] },
  { id: 'claude', name: 'Claude', start: 'https://claude.ai/', hosts: ['claude.ai'] },
];

export const siteById = (id: unknown): BrowserSite | undefined =>
  BROWSER_SITES.find(s => s.id === id);

// The site whose hosts include this hostname (exactly, or as a subdomain), if any.
export function siteForHost(hostname: string): BrowserSite | undefined {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return BROWSER_SITES.find(s => s.hosts.some(h => host === h || host.endsWith(`.${h}`)));
}

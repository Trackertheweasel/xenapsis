import ConfigAPI from './config';

// "example.com", "example.com:8080/path" -- but not searches like "node.js tutorial".
export function looksLikeDomain(value: string): boolean {
  return /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/.test(value);
}

export async function validateUrl(input: string): Promise<string> {
  const engine = ((await ConfigAPI.get('engine')) as string) || 'https://duckduckgo.com/?q=';
  const value = input.trim();
  if (!value) return engine;

  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString();
    }
  } catch {}

  if (looksLikeDomain(value)) {
    return `https://${value}`;
  }

  return engine + encodeURIComponent(value);
}

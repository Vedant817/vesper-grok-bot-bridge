/** Remote Connect endpoints are explicit resources, never local discovery guesses. */
export function connectEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Connect requires an explicit HTTPS /mcp endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || value.includes('#') || url.search || url.pathname !== '/mcp') {
    throw new Error('Connect requires an explicit HTTPS /mcp endpoint without credentials, query or fragment');
  }
  return url;
}

/** Discovery, registration, token exchange and transport cannot leave the approved origin. */
export function sameOriginFetch(endpoint: URL, signal?: AbortSignal): typeof fetch {
  return async (input, init) => {
    const value = input instanceof Request ? input.url : String(input);
    const url = new URL(value);
    if (url.origin !== endpoint.origin || url.protocol !== 'https:' || url.username || url.password || value.includes('#')) {
      throw new Error('Connect refused an endpoint outside the approved HTTPS origin');
    }
    try {
      return await fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([
        AbortSignal.timeout(15000), ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])
      ]) });
    } catch { throw new Error('Connect HTTPS request failed (redirects are refused)'); }
  };
}

export class ConnectReauthorizationRequired extends Error {
  constructor() { super('T3 Connect approval expired or was rejected; run Connect enrollment again'); this.name = 'ConnectReauthorizationRequired'; }
}

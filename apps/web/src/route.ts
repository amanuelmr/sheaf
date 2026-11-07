import { useEffect, useState } from 'react';

export type Route =
  | { readonly page: 'search' }
  | { readonly page: 'document'; readonly sha256: string }
  | { readonly page: 'inbox' }
  | { readonly page: 'devices' }
  | { readonly page: 'trash' }
  | { readonly page: 'fields' }
  | { readonly page: 'system' };

/**
 * Hash routes: `#/search`, `#/doc/<sha256>`, `#/inbox`, `#/devices`, `#/trash`,
 * `#/fields`, `#/system`. A handful of pages do not need a router library, and a hash works when the app is served
 * from any path or opened as a file.
 */
export function parse(hash: string): Route {
  const [, page, param] = hash.replace(/^#/, '').split('/');
  if (page === 'doc' && param !== undefined && /^[0-9a-f]{64}$/.test(param)) {
    return { page: 'document', sha256: param };
  }
  if (
    page === 'inbox' ||
    page === 'devices' ||
    page === 'trash' ||
    page === 'fields' ||
    page === 'system'
  ) {
    return { page };
  }
  return { page: 'search' };
}

export function href(route: Route): string {
  return route.page === 'document' ? `#/doc/${route.sha256}` : `#/${route.page}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

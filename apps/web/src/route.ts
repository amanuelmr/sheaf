import { useEffect, useState } from 'react';
import { filterFromParams, filterToParams, type DocumentFilter } from '@sheaf/protocol';

export type Route =
  | { readonly page: 'search'; readonly filter?: DocumentFilter }
  | { readonly page: 'document'; readonly sha256: string }
  | { readonly page: 'inbox' }
  | { readonly page: 'devices' }
  | { readonly page: 'trash' }
  | { readonly page: 'fields' }
  | { readonly page: 'labels' }
  | { readonly page: 'workflows' }
  | { readonly page: 'users' }
  | { readonly page: 'system' };

/**
 * Hash routes: `#/search`, `#/doc/<sha256>`, `#/inbox`, `#/devices`, `#/trash`,
 * `#/fields`, `#/labels`, `#/workflows`, `#/users`, `#/system`. Ten pages do not
 * need a router library, and a hash works when the app is served from any path or
 * opened as a file.
 */
export function parse(hash: string): Route {
  const [path = '', query] = hash.replace(/^#/, '').split('?', 2);
  const [, page, param] = path.split('/');
  if (page === 'search' && param === undefined && query !== undefined) {
    // A filter in the address, as `GET /v1/search` reads it. One it cannot read is dropped.
    const read = filterFromParams(new URLSearchParams(query));
    if (read.ok && Object.keys(read.filter).length > 0)
      return { page: 'search', filter: read.filter };
  }
  if (page === 'doc' && param !== undefined && /^[0-9a-f]{64}$/.test(param)) {
    return { page: 'document', sha256: param };
  }
  if (
    page === 'inbox' ||
    page === 'devices' ||
    page === 'trash' ||
    page === 'fields' ||
    page === 'labels' ||
    page === 'workflows' ||
    page === 'users' ||
    page === 'system'
  ) {
    return { page };
  }
  return { page: 'search' };
}

export function href(route: Route): string {
  if (route.page === 'document') return `#/doc/${route.sha256}`;
  if (route.page === 'search' && route.filter !== undefined) {
    const query = filterToParams(route.filter).toString();
    if (query !== '') return `#/search?${query}`;
  }
  return `#/${route.page}`;
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

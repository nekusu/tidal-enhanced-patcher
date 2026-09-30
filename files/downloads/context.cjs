// Shared with the sandboxed preload: no Node APIs or React internals are needed.
function reference(type, id) {
  type = String(type || '').toLowerCase();
  id = String(id || '');
  if (!['track', 'album', 'playlist', 'artist', 'video'].includes(type)) return null;
  if (
    type === 'playlist'
      ? !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id)
      : !/^\d{1,20}$/.test(id)
  )
    return null;
  return { type, id };
}

function fromLink(value) {
  try {
    const url = new URL(value, 'https://desktop.tidal.com');
    if (
      url.protocol !== 'https:' ||
      !['tidal.com', 'www.tidal.com', 'desktop.tidal.com', 'listen.tidal.com'].includes(
        url.hostname,
      )
    )
      return null;
    const match = url.pathname.match(
      /^\/(?:browse\/)?(track|album|playlist|artist|video)\/([^/]+)\/?$/,
    );
    return match ? reference(match[1], match[2]) : null;
  } catch {
    return null;
  }
}

function metadata(element) {
  return reference(
    element.getAttribute('data-track--content-type') || element.getAttribute('data-item-type'),
    element.getAttribute('data-track--content-id') || element.getAttribute('data-item-id'),
  );
}

function resolveTarget(element, pageUrl, allowPage = false) {
  if (!element?.closest) return null;
  const trackRow = element.closest(
    '[data-test="tracklist-row"], [data-type="media-table__row"], [data-track-id]',
  );
  if (trackRow) {
    const own = metadata(trackRow);
    if (own && ['track', 'video'].includes(own.type)) return own;
    // Current playlist rows expose the ID on the row, title, and More button,
    // without the content-type/content-id telemetry used by album cards.
    const type = trackRow.querySelector('[data-test="video-badge"]') ? 'video' : 'track';
    const direct = reference(type, trackRow.getAttribute('data-track-id'));
    if (direct) return direct;
    for (const child of trackRow.querySelectorAll(
      '[data-test="table-cell-title"][data-id], [data-test="context-menu-button"][data-id], [data-track--content-id], [data-item-id]',
    )) {
      const item = metadata(child) || reference(type, child.getAttribute('data-id'));
      if (item && ['track', 'video'].includes(item.type)) return item;
    }
    const link = trackRow.querySelector('a[href*="/track/"], a[href*="/video/"]');
    // An unresolved song must never become its album, artist, or entire playlist.
    return link ? fromLink(link.getAttribute('href')) : null;
  }
  const row = element.closest(
    '[data-type="mediaItem"], [data-type="cell"], [data-type="sidebar__playlist"], [data-type="search-result"]',
  );
  let current = element;
  while (current && current !== element.ownerDocument.body) {
    // Unsupported entities (especially profile links) are boundaries, not an
    // invitation to use the containing playlist or the current page instead.
    if (current.matches('a[href]')) return fromLink(current.getAttribute('href'));
    if (current.hasAttribute('data-track--content-type') || current.hasAttribute('data-item-type'))
      return metadata(current);
    current = current.parentElement;
  }
  const headerMore = element.closest('[data-test="show-context-menu-button"]');
  return allowPage &&
    !row &&
    headerMore?.closest('[data-test="header-controls"], [data-test="header-controls-scrolled"]')
    ? fromLink(pageUrl)
    : null;
}

module.exports = { reference, fromLink, resolveTarget };

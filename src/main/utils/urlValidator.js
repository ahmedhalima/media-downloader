'use strict';

// Only these hosts are recognized. This keeps the app scoped to the
// providers it actually implements instead of silently attempting
// arbitrary sites through the underlying extractor.
const HOST_PATTERNS = [
  { provider: 'youtube', pattern: /(^|\.)youtube\.com$/i },
  { provider: 'youtube', pattern: /^youtu\.be$/i },
  { provider: 'youtube', pattern: /(^|\.)music\.youtube\.com$/i },
  { provider: 'facebook', pattern: /(^|\.)facebook\.com$/i },
  { provider: 'facebook', pattern: /(^|\.)fb\.watch$/i }
];

function isValidUrl(raw) {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/**
 * Returns the provider id ('youtube' | 'facebook') for a URL, or null
 * if it isn't a host this app supports.
 */
function detectProvider(raw) {
  if (!isValidUrl(raw)) return null;
  const host = new URL(raw.trim()).hostname.toLowerCase();
  const match = HOST_PATTERNS.find((h) => h.pattern.test(host));
  return match ? match.provider : null;
}

function isLikelyPlaylist(raw) {
  if (!isValidUrl(raw)) return false;
  const u = new URL(raw.trim());
  return u.searchParams.has('list') || /\/playlist/i.test(u.pathname);
}

module.exports = { isValidUrl, detectProvider, isLikelyPlaylist };

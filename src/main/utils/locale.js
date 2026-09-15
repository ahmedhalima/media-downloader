'use strict';

// yt-dlp's `youtube:lang` extractor-arg accepts YouTube's own language
// codes for translated titles/descriptions. This is a pragmatic subset
// covering YouTube's commonly supported translation locales — not
// every possible BCP-47 tag needs an entry, just enough to map a
// Windows display language to something YouTube recognizes.
const SUPPORTED = new Set([
  'ar', 'en', 'es', 'pt', 'fr', 'de', 'it', 'ru', 'tr', 'hi',
  'ja', 'ko', 'id', 'th', 'vi', 'zh-CN', 'zh-TW', 'nl', 'pl', 'sv'
]);

/**
 * Resolves the app's "metadataLanguage" setting to a concrete code to
 * hand yt-dlp. 'auto' (the default) derives it from the OS/Electron
 * display language so the app matches YouTube's own "original
 * language" behavior for most users without any manual setup: asking
 * for metadata in the viewer's own language is what makes YouTube
 * return a video's un-translated title when that IS the video's
 * language, instead of silently falling back to an English default.
 */
function resolveMetadataLanguage(setting, osLocale) {
  if (setting && setting !== 'auto') return setting;

  const tag = (osLocale || 'en').trim();
  if (SUPPORTED.has(tag)) return tag;

  const primary = tag.split(/[-_]/)[0].toLowerCase();
  if (SUPPORTED.has(primary)) return primary;

  // Common region variants that need their full tag preserved.
  if (/^zh/i.test(tag)) return /tw|hk|hant/i.test(tag) ? 'zh-TW' : 'zh-CN';

  return primary && primary.length === 2 ? primary : 'en';
}

module.exports = { resolveMetadataLanguage, SUPPORTED_METADATA_LANGUAGES: SUPPORTED };

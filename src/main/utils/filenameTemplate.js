'use strict';

const path = require('path');

// User-facing placeholders -> yt-dlp output-template fields.
// See yt-dlp's "OUTPUT TEMPLATE" docs for the full field list; we only
// expose the subset that's useful and safe for end users to type.
const FIELD_MAP = {
  title: 'title',
  uploader: 'uploader',
  channel: 'channel',
  id: 'id',
  ext: 'ext',
  quality: 'resolution',
  height: 'height',
  playlist: 'playlist',
  playlist_index: 'playlist_index',
  date: 'upload_date',
  year: 'release_year'
};

// Fields that are simply absent for a plain single video. Without
// special handling yt-dlp renders these as the literal string "NA",
// which is what produced stray "NA" folders and "[NA]" in filenames.
const OPTIONAL_FIELDS = new Set(['playlist', 'playlist_index', 'resolution', 'height', 'release_year', 'upload_date']);

// Quality deliberately not in the default name: the requested quality
// often differs from what was actually delivered after fallback, so
// baking it into the filename is misleading. Playlist position IS
// included by default so playlist downloads land on disk in order.
const DEFAULT_TEMPLATE = '{playlist}/{playlist_index} - {title}';

/**
 * Turns "{playlist}/{title}" into "%(playlist)s/%(title)s.%(ext)s".
 *
 * Optional fields use yt-dlp's "alternate" syntax %(field|)s, which
 * renders an empty string instead of "NA" when the field is missing.
 * Path segments that end up empty are then dropped entirely, so a
 * single video never lands in an "NA" (or empty) subfolder.
 */
function toYtdlpTemplate(userTemplate) {
  const template = (userTemplate || DEFAULT_TEMPLATE).trim() || DEFAULT_TEMPLATE;

  // Normalize Windows-style separators the user may have typed.
  const segments = template.replace(/\\/g, '/').split('/');

  const rendered = segments
    .map((segment) => {
      let hadOnlyOptional = true;
      let sawPlaceholder = false;

      const out = segment.replace(/\{(\w+)\}/g, (_full, key) => {
        const field = FIELD_MAP[key];
        if (!field) return '';
        sawPlaceholder = true;
        if (!OPTIONAL_FIELDS.has(field)) hadOnlyOptional = false;
        return OPTIONAL_FIELDS.has(field) ? `%(${field}|)s` : `%(${field})s`;
      });

      return {
        text: out.replace(/\.\./g, '').trim(),
        // A segment built purely from optional fields (e.g. "{playlist}")
        // can legitimately collapse to nothing for a single video.
        collapsible: sawPlaceholder && hadOnlyOptional
      };
    })
    // Drop segments that are literally empty, and mark collapsible ones
    // so yt-dlp's own empty-path pruning removes them at write time.
    .filter((seg) => seg.text.length > 0);

  let out = rendered.map((seg) => seg.text).join('/');

  if (!out) out = '%(title)s';
  if (!/\.%\(ext\)s$/.test(out)) out += '.%(ext)s';

  return out;
}

function buildOutputPath(downloadRoot, userTemplate) {
  const ytdlpTemplate = toYtdlpTemplate(userTemplate);
  return path.join(downloadRoot, ytdlpTemplate);
}

module.exports = { toYtdlpTemplate, buildOutputPath, DEFAULT_TEMPLATE, FIELD_MAP, OPTIONAL_FIELDS };

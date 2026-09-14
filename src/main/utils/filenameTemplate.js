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

const DEFAULT_TEMPLATE = '{playlist}/{title} [{quality}]';

/**
 * Turns "{playlist}/{title} [{quality}]" into
 * "%(playlist)s/%(title)s [%(resolution)s].%(ext)s", sanitizing path
 * separators so the template can't escape the chosen download folder.
 */
function toYtdlpTemplate(userTemplate) {
  const template = (userTemplate || DEFAULT_TEMPLATE).trim() || DEFAULT_TEMPLATE;

  let out = template.replace(/\{(\w+)\}/g, (full, key) => {
    const field = FIELD_MAP[key];
    return field ? `%(${field})s` : '';
  });

  // Guard against directory traversal in a user-edited template.
  out = out.split('/').map((seg) => seg.replace(/\.\./g, '')).join('/');

  if (!out.endsWith('s)') && !/\.%\(ext\)s$/.test(out)) {
    out += '.%(ext)s';
  }
  return out;
}

function buildOutputPath(downloadRoot, userTemplate) {
  const ytdlpTemplate = toYtdlpTemplate(userTemplate);
  return path.join(downloadRoot, ytdlpTemplate);
}

module.exports = { toYtdlpTemplate, buildOutputPath, DEFAULT_TEMPLATE, FIELD_MAP };

'use strict';

const STANDARD_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240, 144];

/**
 * Collapses yt-dlp's raw `formats` array (often dozens of entries,
 * many audio-only or video-only fragments) into one entry per
 * standard resolution, plus a synthetic "Best available" entry.
 */
function summarizeQualities(rawFormats = []) {
  const byHeight = new Map();

  for (const f of rawFormats) {
    if (!f.height) continue; // skip audio-only / storyboard formats here
    const height = STANDARD_HEIGHTS.find((h) => f.height >= h * 0.9 && f.height <= h * 1.15) || f.height;
    const existing = byHeight.get(height);
    const score = (f.tbr || 0) + (f.vcodec && f.vcodec !== 'none' ? 1000 : 0);
    if (!existing || score > existing.score) {
      byHeight.set(height, {
        id: String(height),
        label: `${height}p`,
        height,
        hasVideo: f.vcodec && f.vcodec !== 'none',
        hasAudio: f.acodec && f.acodec !== 'none',
        note: f.format_note || '',
        approxBitrateKbps: f.tbr || null,
        score
      });
    }
  }

  const qualities = Array.from(byHeight.values())
    .sort((a, b) => b.height - a.height)
    .map(({ score, ...rest }) => rest);

  qualities.unshift({
    id: 'best',
    label: 'Best available',
    height: null,
    hasVideo: true,
    hasAudio: true,
    note: 'Automatically picks the highest quality video+audio and merges them'
  });

  return qualities;
}

function toEntryMetadata(info) {
  return {
    id: info.id,
    url: info.webpage_url || info.original_url || info.url,
    title: info.title || 'Untitled',
    thumbnail: pickThumbnail(info),
    durationSeconds: info.duration || null,
    uploader: info.uploader || info.channel || null
  };
}

function pickThumbnail(info) {
  if (info.thumbnail) return info.thumbnail;
  if (Array.isArray(info.thumbnails) && info.thumbnails.length) {
    return info.thumbnails[info.thumbnails.length - 1].url;
  }
  return null;
}

function isLiveInfo(info) {
  return Boolean(
    info.is_live === true ||
      info.live_status === 'is_live' ||
      info.live_status === 'is_upcoming' ||
      info.live_status === 'post_live'
  );
}

function normalizeAnalysis(info) {
  if (Array.isArray(info.entries)) {
    // Playlist
    const entries = info.entries.filter(Boolean).map(toEntryMetadata);
    return {
      isPlaylist: true,
      isLive: false,
      title: info.title || 'Untitled playlist',
      thumbnail: pickThumbnail(info) || (entries[0] && entries[0].thumbnail) || null,
      uploader: info.uploader || info.channel || null,
      entryCount: entries.length,
      entries,
      qualities: summarizeQualities(info.formats || (info.entries[0] && info.entries[0].formats) || [])
    };
  }

  return {
    isPlaylist: false,
    isLive: isLiveInfo(info),
    liveStatus: info.live_status || null,
    title: info.title || 'Untitled',
    thumbnail: pickThumbnail(info),
    durationSeconds: info.duration || null,
    uploader: info.uploader || info.channel || null,
    qualities: summarizeQualities(info.formats || [])
  };
}

module.exports = { summarizeQualities, normalizeAnalysis, toEntryMetadata, STANDARD_HEIGHTS };

'use strict';

/**
 * UI model
 * --------
 * One list holds two kinds of rows:
 *   - "pending": an analyzed URL awaiting a decision (playlist entry
 *     selection, or live video/.m3u8 choice). Renderer-only.
 *   - "task": a real download owned by the main process.
 *
 * Tabs filter that single list. Pages (downloads / settings) are
 * separate top-level containers, so switching never blanks the app.
 */
const state = {
  filter: 'all',
  page: 'downloads',
  pending: new Map(),
  tasks: new Map(),
  history: [],
  settings: null,
  clipboardTimer: null,
  lastClipboardValue: '',
  shownWarnings: new Set()
};

let localIdCounter = 0;
const nextLocalId = () => `pending-${++localIdCounter}`;

/* ---------------- Toasts ---------------- */
function toast(message, kind = 'default') {
  const stack = document.getElementById('toastStack');
  const node = el(
    'div',
    { class: `toast${kind === 'error' ? ' toast-error' : kind === 'success' ? ' toast-success' : ''}` },
    message
  );
  stack.appendChild(node);
  setTimeout(() => node.remove(), 5000);
}

/* ---------------- Pages ---------------- */
function showPage(page) {
  state.page = page;
  document.getElementById('page-downloads').hidden = page !== 'downloads';
  document.getElementById('page-history').hidden = page !== 'history';
  document.getElementById('page-settings').hidden = page !== 'settings';
  if (page === 'settings') updateHistoryCount();
  if (page === 'history') refreshAndRenderHistoryPage();
}

document.getElementById('openHistoryBtn').addEventListener('click', () => showPage('history'));
document.getElementById('historyBackBtn').addEventListener('click', () => showPage('downloads'));
document.getElementById('openSettingsBtn').addEventListener('click', () => showPage('settings'));
document.getElementById('settingsBackBtn').addEventListener('click', () => showPage('downloads'));

/* ---------------- Tabs (downloads page only: no History tab here — it's its own page) ---------------- */
document.querySelectorAll('.tab[data-filter]').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.filter = tab.dataset.filter;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    renderList();
  });
});

/* ---------------- URL field ---------------- */
const urlInput = document.getElementById('urlInput');
const pasteLinkBtn = document.getElementById('pasteLinkBtn');

// Electron gives inputs no right-click menu by default; wire up a real
// cut/copy/paste menu via the main process.
urlInput.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  const hasSelection = urlInput.selectionStart !== urlInput.selectionEnd;
  let canPaste = false;
  try {
    canPaste = !!(await api.readClipboard());
  } catch (_) {
    /* clipboard unavailable */
  }
  api.showInputContextMenu({ hasSelection, canPaste });
});

pasteLinkBtn.addEventListener('click', () => pasteAndAnalyze());

async function pasteAndAnalyze() {
  let url = urlInput.value.trim();
  if (!url) {
    try {
      url = (await api.readClipboard()).trim();
      urlInput.value = url;
    } catch (_) {
      /* fall through to validation */
    }
  }
  analyzeAndAdd(url);
}

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') analyzeAndAdd(urlInput.value.trim());
});

async function analyzeAndAdd(url, opts = {}) {
  if (!url) {
    toast('Paste a YouTube or Facebook link first.', 'error');
    return;
  }

  const localId = nextLocalId();
  state.pending.set(localId, { localId, status: 'analyzing', url, title: url });
  renderList();

  pasteLinkBtn.disabled = true;
  try {
    const result = await api.analyzeUrl(url, { forcePlaylist: !!opts.forcePlaylist });
    if (result.warning) toast(result.warning);
    state.pending.set(localId, {
      localId,
      status: 'ready',
      url,
      analysis: result,
      title: result.title,
      thumbnail: result.thumbnail,
      selection: new Set((result.entries || []).map((e) => e.url))
    });
    renderList();

    // Only a real playlist or a live stream needs further input. A
    // single video (even one whose URL carries &list=) is queued
    // immediately, and the URL field is cleared either way.
    if (!result.isPlaylist && !result.isLive) {
      await confirmPending(localId);
    } else {
      urlInput.value = '';
    }
  } catch (err) {
    state.pending.delete(localId);
    renderList();
    toast(err.message || String(err), 'error');
  } finally {
    pasteLinkBtn.disabled = false;
  }
}

/* ---------------- Queueing ---------------- */
function toolbarChoices() {
  return {
    qualityId: document.getElementById('toolbarQualitySelect').value,
    audioOnly: document.getElementById('downloadTypeSelect').value === 'audio'
  };
}

async function confirmPending(localId, opts = {}) {
  const entry = state.pending.get(localId);
  if (!entry || !entry.analysis) return;
  const a = entry.analysis;
  const { qualityId, audioOnly } = toolbarChoices();

  try {
    if (opts.liveManifest) {
      await api.enqueueLiveManifest({
        url: entry.url,
        provider: a.provider,
        title: a.title,
        thumbnail: a.thumbnail,
        qualityId
      });
      toast('Resolving live stream manifest…', 'success');
    } else if (a.isPlaylist) {
      const entries = (a.entries || []).filter((e) => entry.selection.has(e.url));
      if (!entries.length) {
        toast('Select at least one video from the playlist.', 'error');
        return;
      }
      const result = await api.enqueuePlaylist(entries, {
        provider: a.provider,
        qualityId,
        audioOnly,
        playlistTitle: a.title
      });
      const { queued = [], skipped = [] } = result || {};

      if (queued.length) {
        toast(`Queued ${queued.length} video${queued.length === 1 ? '' : 's'}.`, 'success');
      }
      if (skipped.length) {
        toast(
          `Skipped ${skipped.length} already-downloaded video${skipped.length === 1 ? '' : 's'} in this quality.`,
          queued.length ? 'default' : 'error'
        );
      }
      if (!queued.length && !skipped.length) {
        toast('Nothing was queued.', 'error');
      }
    } else {
      const payload = {
        url: entry.url,
        provider: a.provider,
        title: a.title,
        thumbnail: a.thumbnail,
        durationSeconds: a.durationSeconds,
        qualityId,
        audioOnly,
        isLive: !!a.isLive
      };
      const res = await api.enqueueDownload(payload);
      if (res && res.duplicate) {
        const again = confirm('You already downloaded this in this quality. Download again anyway?');
        if (!again) {
          clearPending(localId);
          return;
        }
        await api.enqueueDownload({ ...payload, allowDuplicate: true });
      }
      toast('Added to queue.', 'success');
    }
  } catch (err) {
    toast(err.message || String(err), 'error');
  } finally {
    // Always tear down the pending row and reset the input, even on
    // failure — leaving a stale card and a filled URL box behind was
    // confusing and made it look like nothing happened.
    clearPending(localId);
  }
}

function clearPending(localId) {
  state.pending.delete(localId);
  urlInput.value = '';
  renderList();
}

/* ---------------- Rendering ---------------- */
const itemList = document.getElementById('itemList');
const emptyState = document.getElementById('emptyState');
const itemCount = document.getElementById('itemCount');

function taskKind(t) {
  if (t.mode === 'm3u8') return 'live';
  return t.audioOnly ? 'audio' : 'video';
}

function pendingKind(p) {
  if (!p.analysis) return 'video';
  if (p.analysis.isLive) return 'live';
  if (p.analysis.isPlaylist) return 'playlist';
  return 'video';
}

function renderList() {
  itemList.innerHTML = '';
  const rows = [];

  Array.from(state.pending.values()).forEach((p) => {
    if (state.filter === 'all' || state.filter === pendingKind(p)) rows.push(renderPendingRow(p));
  });
  Array.from(state.tasks.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .forEach((t) => {
      if (state.filter === 'all' || state.filter === taskKind(t)) rows.push(renderTaskRow(t));
    });

  rows.forEach((r) => itemList.appendChild(r));
  emptyState.hidden = rows.length > 0;
  itemList.hidden = rows.length === 0;
  itemCount.textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}`;
}

function thumbNode(src) {
  return src ? el('img', { class: 'item-thumb', src, alt: '' }) : el('div', { class: 'item-thumb-placeholder' }, '▶');
}

function chip(label, cls) {
  return el('span', { class: `status-chip ${cls}` }, label);
}

function iconBtn(glyph, title, handler) {
  return el('button', { class: 'icon-btn', title, onclick: handler }, glyph);
}

/** Wraps an openPath/showInFolder call so a missing/moved file surfaces as a toast instead of silently doing nothing. */
function safeFileAction(promise) {
  Promise.resolve(promise).catch((err) => toast(err.message || String(err), 'error'));
}

/* ----- Pending row ----- */
function renderPendingRow(p) {
  if (p.status === 'analyzing') {
    return el('li', { class: 'item-row', dataset: { status: 'queued' } }, [
      thumbNode(null),
      el('div', { class: 'item-main' }, [
        el('div', { class: 'item-title' }, p.title),
        el('div', { class: 'item-sub' }, [chip('Analyzing', 'st-pending')])
      ]),
      el('div', { class: 'item-actions' }, [])
    ]);
  }

  const a = p.analysis;
  const sub = el('div', { class: 'item-sub' }, [
    a.isLive ? chip('Live', 'st-live') : chip('Ready', 'st-pending'),
    el('span', {}, a.uploader || (a.provider === 'youtube' ? 'YouTube' : 'Facebook')),
    el('span', { class: 'dot' }, '·'),
    el('span', {}, a.isPlaylist ? `${a.entryCount} videos` : fmtDuration(a.durationSeconds) || '—')
  ]);

  const actions = el('div', { class: 'item-actions' }, [
    el('button', { class: 'btn btn-accent btn-sm', onclick: () => confirmPending(p.localId) }, 'Download'),
    ...(a.isLive
      ? [
          el(
            'button',
            { class: 'btn btn-secondary btn-sm', onclick: () => confirmPending(p.localId, { liveManifest: true }) },
            'Save .m3u8'
          )
        ]
      : []),
    iconBtn('✕', 'Dismiss', () => clearPending(p.localId))
  ]);

  const row = el('li', { class: 'item-row', dataset: { status: 'queued' } }, [
    thumbNode(a.thumbnail),
    el('div', { class: 'item-main' }, [el('div', { class: 'item-title' }, a.title), sub]),
    actions
  ]);

  if (a.isPlaylist) row.appendChild(renderPlaylistPanel(p));
  return row;
}

function renderPlaylistPanel(p) {
  const a = p.analysis;
  const entriesList = el('ul', { class: 'inline-entries' });
  const countLabel = el('span', {}, `${p.selection.size} of ${a.entryCount} selected`);
  const updateCount = () => {
    countLabel.textContent = `${p.selection.size} of ${a.entryCount} selected`;
  };

  // Pad the displayed number to the width of the largest index so the
  // column stays aligned (1..9 vs 10..99 vs 100+).
  const width = String(a.entryCount).length;

  a.entries.forEach((entry, i) => {
    const cb = el('input', {
      type: 'checkbox',
      ...(p.selection.has(entry.url) ? { checked: 'checked' } : {}),
      onchange: (e) => {
        if (e.target.checked) p.selection.add(entry.url);
        else p.selection.delete(entry.url);
        updateCount();
      }
    });
    const number = String(entry.index || i + 1).padStart(width, '0');
    entriesList.appendChild(
      el('li', {}, [
        cb,
        el('span', { class: 'idx' }, `${number}.`),
        el('span', { class: 'ptitle' }, entry.title),
        ...(entry.durationSeconds ? [el('span', { class: 'pdur' }, fmtDuration(entry.durationSeconds))] : [])
      ])
    );
  });

  const selectAll = el('input', {
    type: 'checkbox',
    checked: 'checked',
    onchange: (e) => {
      const on = e.target.checked;
      p.selection = new Set(on ? a.entries.map((x) => x.url) : []);
      entriesList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.checked = on;
      });
      updateCount();
    }
  });

  return el('div', { class: 'inline-panel' }, [
    el('div', { class: 'inline-panel-header' }, [
      countLabel,
      el('label', { class: 'monitor-toggle' }, [selectAll, el('span', { class: 'monitor-label' }, 'Select all')])
    ]),
    entriesList,
    ...(a.truncated
      ? [el('div', { class: 'inline-note' }, `Showing the first ${a.entryCount} videos of this playlist.`)]
      : [])
  ]);
}

/* ----- Task row ----- */
function statusChipFor(t) {
  switch (t.status) {
    case 'downloading':
      return chip(t.mode === 'm3u8' ? 'Resolving' : 'Downloading', 'st-downloading');
    case 'queued':
      return chip('Queued', 'st-queued');
    case 'paused':
      return chip('Paused', 'st-paused');
    case 'completed':
      return chip(t.mode === 'm3u8' ? 'Saved .m3u8' : 'Completed', 'st-completed');
    case 'error':
      return chip('Failed', 'st-error');
    case 'canceled':
      return chip('Canceled', 'st-canceled');
    default:
      return chip(t.status, 'st-queued');
  }
}

/**
 * Progress line, e.g. "8% · 7.6 MB of 95.1 MB · 30s left · 26 Mbps".
 */
function taskDetailText(t) {
  if (t.status === 'downloading' && t.mode !== 'm3u8') {
    const pct = Math.round(t.progressPercent || 0);
    const bits = [`${pct}%`];
    if (t.totalSizeText) {
      const done = estimateDownloaded(pct, t.totalSizeText);
      bits.push(done ? `${done} of ${t.totalSizeText}` : `of ${t.totalSizeText}`);
    }
    if (t.eta) bits.push(`${t.eta} left`);
    if (t.speed) bits.push(t.speed);
    return bits.join(' · ');
  }
  if (t.status === 'error') return t.error || 'Unknown error';
  if (t.status === 'completed' && t.filePath) return t.filePath;
  if (t.warning) return t.warning;
  return t.audioOnly ? 'Audio' : t.qualityId === 'best' ? 'Best quality' : `${t.qualityId}p`;
}

/** yt-dlp reports total size + percent; derive the downloaded amount. */
function estimateDownloaded(pct, totalText) {
  const m = /([\d.]+)\s*([KMGT]?i?B)/i.exec(totalText || '');
  if (!m) return null;
  const value = parseFloat(m[1]) * (pct / 100);
  if (!isFinite(value)) return null;
  return `${value.toFixed(1)} ${m[2]}`;
}

function renderTaskRow(t) {
  const sub = el('div', { class: 'item-sub' }, [statusChipFor(t), el('span', {}, taskDetailText(t))]);

  // Prefix playlist items with their position, e.g. "07/24".
  const titleText = t.playlistIndex
    ? `${String(t.playlistIndex).padStart(String(t.playlistTotal || t.playlistIndex).length, '0')}${
        t.playlistTotal ? `/${t.playlistTotal}` : ''
      }  ·  ${t.title}`
    : t.title;

  const main = el('div', { class: 'item-main' }, [
    el('div', { class: 'item-title' }, titleText),
    sub,
    ...(t.status === 'downloading' || t.status === 'paused'
      ? [
          el(
            'div',
            { class: 'progress-track' },
            el('div', { class: 'progress-fill', style: `width:${t.progressPercent || 0}%` })
          )
        ]
      : [])
  ]);

  const actions = el('div', { class: 'item-actions' });
  if (t.status === 'downloading') actions.appendChild(iconBtn('⏸', 'Pause', () => api.pauseDownload(t.id)));
  if (t.status === 'paused') actions.appendChild(iconBtn('▶', 'Resume', () => api.resumeDownload(t.id)));
  if (t.status === 'error') actions.appendChild(iconBtn('↻', 'Retry', () => api.retryDownload(t.id)));
  if (t.status === 'completed' && t.filePath) {
    actions.appendChild(iconBtn('⤢', 'Show in folder', () => safeFileAction(api.showInFolder(t.filePath))));
    actions.appendChild(iconBtn('▶', 'Open file', () => safeFileAction(api.openPath(t.filePath))));
  }
  if (['downloading', 'queued', 'paused'].includes(t.status)) {
    actions.appendChild(iconBtn('✕', 'Cancel', () => api.cancelDownload(t.id)));
  } else {
    actions.appendChild(iconBtn('🗑', 'Remove from list', () => api.removeDownload(t.id)));
  }

  return el(
    'li',
    {
      class: 'item-row',
      dataset: { status: t.status },
      oncontextmenu: (e) => {
        e.preventDefault();
        api.showItemContextMenu({ url: t.url, filePath: t.filePath, hasFile: t.status === 'completed' && !!t.filePath });
      }
    },
    [thumbNode(t.thumbnail), main, actions]
  );
}

/* ----- History row ----- */
function renderHistoryRow(h) {
  const isManifest = h.filePath && h.filePath.endsWith('.m3u8');
  const sub = el('div', { class: 'item-sub' }, [
    chip(isManifest ? 'Saved .m3u8' : 'Completed', 'st-completed'),
    el('span', {}, h.filePath || '')
  ]);

  const actions = el('div', { class: 'item-actions' }, [
    ...(h.filePath
      ? [
          iconBtn('⤢', 'Show in folder', () => safeFileAction(api.showInFolder(h.filePath))),
          iconBtn('▶', 'Open file', () => safeFileAction(api.openPath(h.filePath)))
        ]
      : []),
    iconBtn('🗑', 'Delete from history', async () => {
      await api.removeHistory(h.id);
      await refreshHistory();
      renderHistoryPage();
      updateHistoryCount();
    })
  ]);

  return el(
    'li',
    {
      class: 'item-row',
      dataset: { status: 'completed' },
      oncontextmenu: (e) => {
        e.preventDefault();
        api.showItemContextMenu({ url: h.url, filePath: h.filePath, hasFile: !!h.filePath });
      }
    },
    [thumbNode(h.thumbnail), el('div', { class: 'item-main' }, [el('div', { class: 'item-title' }, h.title), sub]), actions]
  );
}

async function refreshHistory() {
  state.history = await api.listHistory();
}

/** Renders the standalone History page's list. */
function renderHistoryPage() {
  const list = document.getElementById('historyItemList');
  const empty = document.getElementById('historyEmptyState');
  const count = document.getElementById('historyItemCount');

  list.innerHTML = '';
  state.history.forEach((h) => list.appendChild(renderHistoryRow(h)));

  empty.hidden = state.history.length > 0;
  list.hidden = state.history.length === 0;
  count.textContent = `${state.history.length} download${state.history.length === 1 ? '' : 's'}`;
}

async function refreshAndRenderHistoryPage() {
  await refreshHistory();
  renderHistoryPage();
  updateHistoryCount();
}

function updateHistoryCount() {
  const node = document.getElementById('historyCountValue');
  const n = state.history.length;
  node.textContent = n === 0 ? 'No downloads recorded yet.' : `${n} download${n === 1 ? '' : 's'} recorded.`;
}

async function clearAllHistory() {
  if (!confirm('Clear all download history?\n\nThis only clears the list — your downloaded files are not deleted.')) {
    return;
  }
  await api.clearHistory();
  await refreshHistory();
  renderHistoryPage();
  updateHistoryCount();
  toast('History cleared.', 'success');
}

document.getElementById('clearHistoryBtn').addEventListener('click', clearAllHistory);
document.getElementById('clearHistorySettingsBtn').addEventListener('click', clearAllHistory);

document.getElementById('clearCompletedBtn').addEventListener('click', async () => {
  const done = Array.from(state.tasks.values()).filter((t) => ['completed', 'canceled'].includes(t.status));
  const failedCount = Array.from(state.tasks.values()).filter((t) => t.status === 'error').length;
  if (!done.length) {
    toast(failedCount ? `No finished items to clear (${failedCount} failed item${failedCount === 1 ? '' : 's'} kept).` : 'No finished items to clear.');
    return;
  }
  for (const t of done) await api.removeDownload(t.id);
  toast(
    `Cleared ${done.length} item${done.length === 1 ? '' : 's'}.` +
      (failedCount ? ` Kept ${failedCount} failed item${failedCount === 1 ? '' : 's'}.` : ''),
    'success'
  );
});

/* ---------------- Clipboard auto-detect ---------------- */
document.getElementById('clipboardMonitorToggle').addEventListener('change', (e) => {
  if (e.target.checked) startClipboardMonitor();
  else stopClipboardMonitor();
});

function startClipboardMonitor() {
  stopClipboardMonitor();
  state.clipboardTimer = setInterval(async () => {
    try {
      const text = (await api.readClipboard()).trim();
      if (!text || text === state.lastClipboardValue) return;
      state.lastClipboardValue = text;
      if (!/^https?:\/\//i.test(text)) return;
      if (!/(youtube\.com|youtu\.be|facebook\.com|fb\.watch)/i.test(text)) return;
      const known =
        Array.from(state.pending.values()).some((p) => p.url === text) ||
        Array.from(state.tasks.values()).some((t) => t.url === text);
      if (known) return;
      urlInput.value = text;
      analyzeAndAdd(text);
    } catch (_) {
      /* ignore clipboard read failures */
    }
  }, 1200);
}

function stopClipboardMonitor() {
  if (state.clipboardTimer) clearInterval(state.clipboardTimer);
  state.clipboardTimer = null;
}

/* ---------------- Settings ---------------- */
function applySettingsToUi(s) {
  state.settings = s;
  document.getElementById('downloadFolderValue').textContent = s.downloadFolder;
  document.getElementById('saveToPathText').textContent = shortenPath(s.downloadFolder);
  document.getElementById('saveToPathBtn').title = s.downloadFolder;
  document.getElementById('filenameTemplateInput').value = s.filenameTemplate;
  document.getElementById('organizeByProviderToggle').checked = s.organizeByProvider;
  document.getElementById('deletePartialToggle').checked = s.deletePartialOnCancel;
  document.getElementById('defaultQualitySelect').value = s.defaultQuality;
  document.getElementById('preferOriginalAudioToggle').checked = s.preferOriginalAudio;
  document.getElementById('audioFormatSelect').value = s.preferredAudioFormat;
  document.getElementById('metadataLanguageSelect').value = s.metadataLanguage || 'auto';
  document.getElementById('concurrencyInput').value = s.maxConcurrentDownloads;
  document.getElementById('maxRetriesInput').value = s.maxRetries;
  document.getElementById('notificationsToggle').checked = s.notificationsEnabled;
  document.getElementById('closeToTrayToggle').checked = s.closeToTray;
  document.getElementById('toolbarQualitySelect').value = s.defaultQuality;
}

function shortenPath(p) {
  if (!p) return '…';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

function bindSetting(elId, key, transform = (v) => v) {
  const node = document.getElementById(elId);
  const evt = node.type === 'checkbox' || node.tagName === 'SELECT' ? 'change' : 'blur';
  node.addEventListener(evt, async () => {
    const raw = node.type === 'checkbox' ? node.checked : node.value;
    state.settings = await api.setSettings({ [key]: transform(raw) });
  });
}

bindSetting('filenameTemplateInput', 'filenameTemplate');
bindSetting('organizeByProviderToggle', 'organizeByProvider');
bindSetting('deletePartialToggle', 'deletePartialOnCancel');
bindSetting('preferOriginalAudioToggle', 'preferOriginalAudio');
bindSetting('audioFormatSelect', 'preferredAudioFormat');
bindSetting('metadataLanguageSelect', 'metadataLanguage');
bindSetting('concurrencyInput', 'maxConcurrentDownloads', (v) => parseInt(v, 10) || 1);
bindSetting('maxRetriesInput', 'maxRetries', (v) => parseInt(v, 10) || 0);
bindSetting('notificationsToggle', 'notificationsEnabled');
bindSetting('closeToTrayToggle', 'closeToTray');

// Default quality is editable from both the toolbar and Settings; keep
// the two controls in sync.
async function setDefaultQuality(value) {
  state.settings = await api.setSettings({ defaultQuality: value });
  document.getElementById('toolbarQualitySelect').value = value;
  document.getElementById('defaultQualitySelect').value = value;
}
document.getElementById('toolbarQualitySelect').addEventListener('change', (e) => setDefaultQuality(e.target.value));
document.getElementById('defaultQualitySelect').addEventListener('change', (e) => setDefaultQuality(e.target.value));

async function chooseFolder() {
  const folder = await api.chooseFolder();
  if (!folder) return;
  applySettingsToUi(await api.setSettings({ downloadFolder: folder }));
}

document.getElementById('chooseFolderBtn').addEventListener('click', chooseFolder);
document.getElementById('saveToPathBtn').addEventListener('click', chooseFolder);

document.getElementById('resetSettingsBtn').addEventListener('click', async () => {
  if (!confirm('Reset all settings to their defaults?')) return;
  applySettingsToUi(await api.resetSettings());
  toast('Settings reset.', 'success');
});

/* ---------------- Events from main ---------------- */
api.onDownloadUpdate(async (task) => {
  state.tasks.set(task.id, task);
  if (task.warning && !state.shownWarnings.has(task.warning)) {
    state.shownWarnings.add(task.warning);
    toast(task.warning);
  }
  if (task.status === 'completed') {
    await refreshHistory();
    updateHistoryCount();
    if (state.page === 'history') renderHistoryPage();
  }
  renderList();
});

api.onDownloadRemoved((id) => {
  state.tasks.delete(id);
  renderList();
});

api.onAppStatus((status) => {
  const node = document.getElementById('engineStatus');
  if (status.stage === 'preparing-tools') node.textContent = 'Preparing engine…';
  else if (status.stage === 'ready') node.textContent = 'Engine ready';
  else if (status.stage === 'error') {
    node.textContent = 'Engine error';
    toast(status.message || 'Something went wrong preparing the download engine.', 'error');
  }
});

api.onMenuCommand(async (command) => {
  switch (command) {
    case 'pasteLink':
      showPage('downloads');
      pasteAndAnalyze();
      break;
    case 'openSettings':
      showPage('settings');
      break;
    case 'pauseAll':
      for (const t of state.tasks.values()) {
        if (t.status === 'downloading') await api.pauseDownload(t.id);
      }
      break;
    case 'resumeAll':
      for (const t of state.tasks.values()) {
        if (t.status === 'paused') await api.resumeDownload(t.id);
      }
      break;
    case 'clearCompleted':
      document.getElementById('clearCompletedBtn').click();
      break;
    default:
      break;
  }
});

/* ---------------- Boot ---------------- */
(async function init() {
  applySettingsToUi(await api.getSettings());
  const existing = await api.listDownloads();
  existing.forEach((t) => state.tasks.set(t.id, t));
  await refreshHistory();
  updateHistoryCount();
  renderList();
})();

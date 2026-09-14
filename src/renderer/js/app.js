'use strict';

const state = {
  view: 'analyze',
  lastAnalysis: null,
  playlistSelection: new Set(),
  tasks: new Map(),
  settings: null
};

/* ---------------- Navigation ---------------- */
function switchView(view) {
  state.view = view;
  document.querySelectorAll('.rail-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => {
    v.hidden = v.id !== `view-${view}`;
  });
  if (view === 'history') renderHistory();
}

document.querySelectorAll('.rail-item[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

/* ---------------- Toasts ---------------- */
function toast(message, kind = 'default') {
  const stack = document.getElementById('toastStack');
  const node = el('div', { class: `toast${kind === 'error' ? ' toast-error' : kind === 'success' ? ' toast-success' : ''}` }, message);
  stack.appendChild(node);
  setTimeout(() => node.remove(), 4500);
}

/* ---------------- Analyze ---------------- */
const urlInput = document.getElementById('urlInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const urlError = document.getElementById('urlError');
const analyzeResult = document.getElementById('analyzeResult');

analyzeBtn.addEventListener('click', runAnalyze);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runAnalyze();
});

async function runAnalyze() {
  const url = urlInput.value.trim();
  urlError.hidden = true;
  if (!url) return;

  analyzeBtn.disabled = true;
  analyzeBtn.textContent = 'Analyzing…';
  try {
    const result = await api.analyzeUrl(url);
    state.lastAnalysis = { ...result, sourceUrl: url };
    renderAnalysis(state.lastAnalysis);
  } catch (err) {
    analyzeResult.hidden = true;
    urlError.textContent = err.message || String(err);
    urlError.hidden = false;
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = 'Analyze';
  }
}

function renderAnalysis(a) {
  analyzeResult.hidden = false;

  document.getElementById('resultThumb').src = a.thumbnail || '';
  document.getElementById('resultTitle').textContent = a.title;

  const metaBits = [];
  if (a.uploader) metaBits.push(a.uploader);
  if (a.isPlaylist) metaBits.push(`${a.entryCount} videos`);
  else if (a.durationSeconds) metaBits.push(fmtDuration(a.durationSeconds));
  document.getElementById('resultMeta').textContent = metaBits.join('  ·  ');

  const badges = document.getElementById('resultBadges');
  badges.innerHTML = '';
  if (a.isLive) badges.appendChild(el('span', { class: 'badge badge-live' }, 'Live'));
  if (a.isPlaylist) badges.appendChild(el('span', { class: 'badge badge-playlist' }, 'Playlist'));
  badges.appendChild(el('span', { class: 'badge' }, a.provider === 'youtube' ? 'YouTube' : 'Facebook'));

  const qualitySelect = document.getElementById('qualitySelect');
  qualitySelect.innerHTML = '';
  (a.qualities || []).forEach((q) => {
    qualitySelect.appendChild(el('option', { value: q.id }, q.label));
  });
  if (state.settings && [...qualitySelect.options].some((o) => o.value === state.settings.defaultQuality)) {
    qualitySelect.value = state.settings.defaultQuality;
  }

  const playlistPanel = document.getElementById('playlistPanel');
  const playlistEntries = document.getElementById('playlistEntries');
  state.playlistSelection = new Set();

  if (a.isPlaylist) {
    playlistPanel.hidden = false;
    document.getElementById('playlistCount').textContent = `${a.entryCount} videos in this playlist`;
    playlistEntries.innerHTML = '';
    a.entries.forEach((entry, i) => {
      state.playlistSelection.add(entry.url);
      const checkbox = el('input', {
        type: 'checkbox',
        checked: 'checked',
        onchange: (e) => {
          if (e.target.checked) state.playlistSelection.add(entry.url);
          else state.playlistSelection.delete(entry.url);
        }
      });
      playlistEntries.appendChild(
        el('li', {}, [
          checkbox,
          el('span', { class: 'idx' }, String(i + 1)),
          el('span', { class: 'ptitle' }, entry.title)
        ])
      );
    });
  } else {
    playlistPanel.hidden = true;
  }

  document.getElementById('playlistSelectAll').checked = true;
  document.getElementById('liveManifestBtn').hidden = !a.isLive;
}

document.getElementById('playlistSelectAll').addEventListener('change', (e) => {
  const checked = e.target.checked;
  document.querySelectorAll('#playlistEntries input[type="checkbox"]').forEach((cb) => {
    cb.checked = checked;
  });
  const a = state.lastAnalysis;
  state.playlistSelection = new Set(checked ? a.entries.map((x) => x.url) : []);
});

document.getElementById('downloadBtn').addEventListener('click', async () => {
  const a = state.lastAnalysis;
  if (!a) return;
  const qualityId = document.getElementById('qualitySelect').value;
  const audioOnly = document.getElementById('audioOnlyToggle').checked;

  try {
    if (a.isPlaylist) {
      const entries = a.entries.filter((e) => state.playlistSelection.has(e.url));
      if (!entries.length) {
        toast('Select at least one video from the playlist.', 'error');
        return;
      }
      await api.enqueuePlaylist(entries, { provider: a.provider, qualityId, audioOnly });
      toast(`Queued ${entries.length} videos.`, 'success');
      document.getElementById('queueList').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      const res = await api.enqueueDownload({
        url: a.sourceUrl,
        provider: a.provider,
        title: a.title,
        thumbnail: a.thumbnail,
        durationSeconds: a.durationSeconds,
        qualityId,
        audioOnly
      });
      if (res && res.duplicate) {
        const proceed = confirm('You already downloaded this in this quality. Download again anyway?');
        if (proceed) {
          await api.enqueueDownload({
            url: a.sourceUrl,
            provider: a.provider,
            title: a.title,
            thumbnail: a.thumbnail,
            durationSeconds: a.durationSeconds,
            qualityId,
            audioOnly,
            allowDuplicate: true
          });
        } else {
          return;
        }
      }
      toast('Added to queue.', 'success');
    }
    switchView('queue');
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
});

document.getElementById('liveManifestBtn').addEventListener('click', async () => {
  const a = state.lastAnalysis;
  if (!a) return;
  const qualityId = document.getElementById('qualitySelect').value;
  try {
    await api.enqueueLiveManifest({
      url: a.sourceUrl,
      provider: a.provider,
      title: a.title,
      thumbnail: a.thumbnail,
      qualityId
    });
    toast('Resolving live stream manifest…', 'success');
    document.getElementById('queueList').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
});

/* ---------------- Queue ---------------- */
const queueList = document.getElementById('queueList');
const queueEmpty = document.getElementById('queueEmpty');
const queueBadge = document.getElementById('queueBadge');

function statusLabel(t) {
  switch (t.status) {
    case 'downloading': return t.mode === 'm3u8' ? 'Resolving stream…' : `Downloading — ${Math.round(t.progressPercent)}%`;
    case 'queued': return 'Queued';
    case 'paused': return 'Paused';
    case 'completed': return t.mode === 'm3u8' ? 'Saved (.m3u8)' : 'Completed';
    case 'error': return `Failed — ${t.error || 'unknown error'}`;
    case 'canceled': return 'Canceled';
    default: return t.status;
  }
}

function renderQueue() {
  const tasks = Array.from(state.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  queueList.innerHTML = '';
  queueEmpty.hidden = tasks.length > 0;

  const activeCount = tasks.filter((t) => t.status === 'downloading' || t.status === 'queued').length;
  queueBadge.hidden = activeCount === 0;
  queueBadge.textContent = String(activeCount);

  tasks.forEach((t) => queueList.appendChild(renderTaskRow(t, { queueContext: true })));
}

function renderTaskRow(t, { queueContext }) {
  const sub = el('div', { class: 'task-sub' }, statusLabel(t));
  const progress = el('div', { class: 'progress-track' }, el('div', { class: 'progress-fill', style: `width:${t.progressPercent || 0}%` }));

  const main = el('div', { class: 'task-main' }, [
    el('div', { class: 'task-title' }, t.title),
    sub,
    ...(t.status === 'downloading' || t.status === 'paused' ? [progress] : [])
  ]);

  const actions = el('div', { class: 'task-actions' });

  if (queueContext) {
    if (t.status === 'downloading') {
      actions.appendChild(iconBtn('⏸', 'Pause', () => api.pauseDownload(t.id)));
    }
    if (t.status === 'paused') {
      actions.appendChild(iconBtn('▶', 'Resume', () => api.resumeDownload(t.id)));
    }
    if (t.status === 'error') {
      actions.appendChild(iconBtn('↻', 'Retry', () => api.retryDownload(t.id)));
    }
    if (t.status === 'completed' && t.filePath) {
      actions.appendChild(iconBtn('⤢', 'Show in folder', () => api.showInFolder(t.filePath)));
    }
    if (t.status === 'downloading' || t.status === 'queued' || t.status === 'paused') {
      actions.appendChild(iconBtn('✕', 'Cancel', () => api.cancelDownload(t.id)));
    } else {
      actions.appendChild(iconBtn('🗑', 'Remove', () => api.removeDownload(t.id)));
    }
  } else if (t.filePath) {
    actions.appendChild(iconBtn('⤢', 'Show in folder', () => api.showInFolder(t.filePath)));
    actions.appendChild(iconBtn('▶', 'Open', () => api.openPath(t.filePath)));
  }

  return el('li', { class: 'task-row', dataset: { status: t.status } }, [
    el('img', { class: 'task-thumb', src: t.thumbnail || '' }),
    main,
    actions
  ]);
}

function iconBtn(glyph, title, handler) {
  return el('button', { class: 'icon-btn', title, onclick: handler }, glyph);
}

/* ---------------- History ---------------- */
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');

async function renderHistory() {
  const items = await api.listHistory();
  historyList.innerHTML = '';
  historyEmpty.hidden = items.length > 0;
  items.forEach((h) => {
    historyList.appendChild(
      renderTaskRow(
        {
          id: h.id,
          title: h.title,
          thumbnail: h.thumbnail,
          status: 'completed',
          progressPercent: 100,
          filePath: h.filePath,
          mode: h.filePath && h.filePath.endsWith('.m3u8') ? 'm3u8' : 'video'
        },
        { queueContext: false }
      )
    );
  });
}

document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
  if (!confirm('Clear all download history? This does not delete your files.')) return;
  await api.clearHistory();
  renderHistory();
});

/* ---------------- Settings ---------------- */
async function loadSettings() {
  state.settings = await api.getSettings();
  const s = state.settings;
  document.getElementById('downloadFolderValue').textContent = s.downloadFolder;
  document.getElementById('filenameTemplateInput').value = s.filenameTemplate;
  document.getElementById('organizeByProviderToggle').checked = s.organizeByProvider;
  document.getElementById('defaultQualitySelect').value = s.defaultQuality;
  document.getElementById('preferOriginalAudioToggle').checked = s.preferOriginalAudio;
  document.getElementById('audioFormatSelect').value = s.preferredAudioFormat;
  document.getElementById('concurrencyInput').value = s.maxConcurrentDownloads;
  document.getElementById('maxRetriesInput').value = s.maxRetries;
  document.getElementById('notificationsToggle').checked = s.notificationsEnabled;
  document.getElementById('closeToTrayToggle').checked = s.closeToTray;
  document.getElementById('deletePartialToggle').checked = s.deletePartialOnCancel;
}

function bindSetting(elId, key, transform = (v) => v) {
  const node = document.getElementById(elId);
  const evt = node.type === 'checkbox' ? 'change' : node.tagName === 'SELECT' ? 'change' : 'blur';
  node.addEventListener(evt, async () => {
    const raw = node.type === 'checkbox' ? node.checked : node.value;
    await api.setSettings({ [key]: transform(raw) });
  });
}

bindSetting('filenameTemplateInput', 'filenameTemplate');
bindSetting('organizeByProviderToggle', 'organizeByProvider');
bindSetting('defaultQualitySelect', 'defaultQuality');
bindSetting('preferOriginalAudioToggle', 'preferOriginalAudio');
bindSetting('audioFormatSelect', 'preferredAudioFormat');
bindSetting('concurrencyInput', 'maxConcurrentDownloads', (v) => parseInt(v, 10) || 1);
bindSetting('maxRetriesInput', 'maxRetries', (v) => parseInt(v, 10) || 0);
bindSetting('notificationsToggle', 'notificationsEnabled');
bindSetting('closeToTrayToggle', 'closeToTray');
bindSetting('deletePartialToggle', 'deletePartialOnCancel');

document.getElementById('chooseFolderBtn').addEventListener('click', async () => {
  const folder = await api.chooseFolder();
  if (folder) {
    await api.setSettings({ downloadFolder: folder });
    document.getElementById('downloadFolderValue').textContent = folder;
  }
});

document.getElementById('resetSettingsBtn').addEventListener('click', async () => {
  if (!confirm('Reset all settings to their defaults?')) return;
  await loadSettingsFrom(await api.resetSettings());
});

async function loadSettingsFrom(s) {
  state.settings = s;
  await loadSettings();
}

/* ---------------- Live download updates ---------------- */
api.onDownloadUpdate((task) => {
  state.tasks.set(task.id, task);
  renderQueue();
  if (task.status === 'completed' && state.view === 'history') renderHistory();
});

api.onDownloadRemoved((id) => {
  state.tasks.delete(id);
  renderQueue();
});

/* ---------------- Engine status ---------------- */
api.onAppStatus((status) => {
  const node = document.getElementById('engineStatus');
  if (status.stage === 'preparing-tools') node.textContent = 'Preparing engine…';
  else if (status.stage === 'ready') node.textContent = 'Ready';
  else if (status.stage === 'error') {
    node.textContent = 'Engine error';
    toast(status.message || 'Something went wrong preparing the download engine.', 'error');
  }
});

/* ---------------- Boot ---------------- */
(async function init() {
  await loadSettings();
  const existing = await api.listDownloads();
  existing.forEach((t) => state.tasks.set(t.id, t));
  renderQueue();
  document.getElementById('engineStatus').textContent = 'Ready';
})();

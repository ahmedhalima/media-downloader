'use strict';

const { spawn, execFile } = require('child_process');

/**
 * Runs yt-dlp directly and captures BOTH stdout and stderr.
 *
 * yt-dlp-wrap's execPromise rejects with only "Command failed: <the
 * whole command line>" and throws away stderr, which is where yt-dlp
 * actually explains what went wrong. That made every failure look
 * identical and undiagnosable. This helper keeps the real output.
 */
function runYtDlp(binaryPath, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let finished = false;

    const child = spawn(binaryPath, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    });

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      killProcessTree(child.pid);
      reject(buildError('Timed out waiting for yt-dlp.', args, stderr, stdout));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(buildError(err.message, args, stderr, stdout));
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(buildError(`yt-dlp exited with code ${code}`, args, stderr, stdout));
    });
  });
}

/**
 * Spawns yt-dlp as a long-running, event-driven process for downloads,
 * where the caller needs to react to stdout/stderr as it streams in
 * (for live progress) rather than wait for a single resolved promise.
 *
 * On POSIX the child becomes its own process group leader (`detached:
 * true`) so `killProcessTree` can kill the whole group at once — this
 * matters because yt-dlp spawns ffmpeg as a child of its own process
 * for merging/remuxing, and killing only the yt-dlp process leaves
 * that ffmpeg child running (which is exactly what caused cancelled
 * downloads to keep going in the background).
 */
function spawnManaged(binaryPath, args) {
  return spawn(binaryPath, args, {
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
  });
}

/**
 * Kills a spawned yt-dlp process AND any children it spawned (chiefly
 * ffmpeg). A plain `child.kill()` only signals the immediate process;
 * on Windows especially, a child's children are not automatically
 * terminated when it dies, so ffmpeg would keep merging/downloading
 * in the background after "Cancel" was clicked.
 */
function killProcessTree(pid) {
  if (!pid) return Promise.resolve();
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // /T = kill the whole tree, /F = force. Errors are expected and
      // ignored if the process already exited on its own.
      execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => resolve());
    } else {
      try {
        process.kill(-pid, 'SIGKILL'); // negative pid = whole process group
      } catch (_) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (_) {
          /* already gone */
        }
      }
      resolve();
    }
  });
}

function buildError(summary, args, stderr, stdout) {
  // Prefer yt-dlp's own ERROR: line; it is the useful part.
  const errorLine = String(stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .find((l) => /^ERROR[:\s]/i.test(l));

  const detail = errorLine || String(stderr || '').split('\n').filter(Boolean).pop() || summary;

  const err = new Error(detail);
  err.summary = summary;
  err.stderr = stderr;
  err.stdout = stdout;
  err.args = args;
  return err;
}

module.exports = { runYtDlp, spawnManaged, killProcessTree, buildError };

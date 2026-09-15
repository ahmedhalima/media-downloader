'use strict';

const { spawn } = require('child_process');

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
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    });

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill();
      } catch (_) {
        /* already gone */
      }
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

module.exports = { runYtDlp };

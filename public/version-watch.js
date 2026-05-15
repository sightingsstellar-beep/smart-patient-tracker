/*
 * version-watch.js — lightweight client-side deploy freshness check.
 *
 * Watches /api/version for commit changes. Auto-refreshes read-only display pages;
 * prompts first on pages where a caregiver may be typing or editing.
 */

'use strict';

(() => {
  const CHECK_INTERVAL_MS = 5 * 60 * 1000;
  const VERSION_URL = '/api/version';
  const STORAGE_KEY = 'glide-bedside-seen-commit';
  const PROMPT_PATHS = new Set(['/chat', '/settings']);
  let currentCommit = null;
  let checking = false;
  let prompted = false;

  function normalizePath() {
    return window.location.pathname.replace(/\/$/, '') || '/';
  }

  function shouldPromptBeforeReload() {
    const path = normalizePath();
    if (PROMPT_PATHS.has(path)) return true;
    if (document.querySelector('.amount-modal:not([style*="display:none"]), .sheet-backdrop:not([style*="display:none"])')) return true;
    const active = document.activeElement;
    return Boolean(active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName));
  }

  async function fetchVersion() {
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`version check failed: ${res.status}`);
    return res.json();
  }

  function injectBannerStyles() {
    if (document.getElementById('version-watch-styles')) return;
    const style = document.createElement('style');
    style.id = 'version-watch-styles';
    style.textContent = `
      .version-watch-banner {
        position: fixed;
        left: 12px;
        right: 12px;
        bottom: calc(86px + env(safe-area-inset-bottom, 0px));
        z-index: 1000;
        max-width: 620px;
        margin: 0 auto;
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(24, 36, 52, 0.96);
        color: #fff;
        box-shadow: 0 16px 36px rgba(23, 47, 69, 0.28);
        display: flex;
        align-items: center;
        gap: 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .version-watch-banner-text {
        flex: 1;
        min-width: 0;
        font-size: 0.9rem;
        line-height: 1.35;
      }
      .version-watch-banner button {
        border: none;
        border-radius: 999px;
        padding: 8px 12px;
        font: inherit;
        font-size: 0.84rem;
        font-weight: 750;
        cursor: pointer;
      }
      .version-watch-refresh {
        background: #5fc7bd;
        color: #08252b;
      }
      .version-watch-later {
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
      }
      @media (max-width: 380px) {
        .version-watch-banner {
          flex-direction: column;
          align-items: stretch;
        }
        .version-watch-banner-actions {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function showRefreshPrompt() {
    if (prompted || document.getElementById('version-watch-banner')) return;
    prompted = true;
    injectBannerStyles();

    const banner = document.createElement('div');
    banner.id = 'version-watch-banner';
    banner.className = 'version-watch-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.innerHTML = `
      <div class="version-watch-banner-text">A fresh Glide Bedside update is ready.</div>
      <div class="version-watch-banner-actions">
        <button class="version-watch-refresh" type="button">Refresh</button>
        <button class="version-watch-later" type="button">Later</button>
      </div>
    `;
    banner.querySelector('.version-watch-refresh').addEventListener('click', () => {
      window.location.reload();
    });
    banner.querySelector('.version-watch-later').addEventListener('click', () => {
      banner.remove();
      prompted = false;
    });
    document.body.appendChild(banner);
  }

  function handleChangedCommit(nextCommit) {
    if (!nextCommit || nextCommit === currentCommit) return;
    currentCommit = nextCommit;
    try { sessionStorage.setItem(STORAGE_KEY, nextCommit); } catch (_) {}

    if (shouldPromptBeforeReload()) {
      showRefreshPrompt();
      return;
    }

    window.location.reload();
  }

  async function checkForUpdate({ initial = false } = {}) {
    if (checking) return;
    checking = true;
    try {
      const info = await fetchVersion();
      const nextCommit = info.commit || info.version || null;
      if (!nextCommit) return;

      if (initial) {
        currentCommit = nextCommit;
        try { sessionStorage.setItem(STORAGE_KEY, nextCommit); } catch (_) {}
        return;
      }

      handleChangedCommit(nextCommit);
    } catch (err) {
      // Stay quiet: this is a convenience check, not a user-facing failure.
      console.debug('[version-watch]', err.message);
    } finally {
      checking = false;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
  window.addEventListener('focus', () => checkForUpdate());

  checkForUpdate({ initial: true });
  window.setInterval(() => checkForUpdate(), CHECK_INTERVAL_MS);
})();

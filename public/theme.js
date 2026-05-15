/*
 * theme.js — shared Glide Bedside color palette loader.
 *
 * Applies a stored palette immediately, then syncs with /api/settings when the
 * app is available. Keep this tiny so it can run in <head> before CSS loads.
 */

'use strict';

(() => {
  const STORAGE_KEY = 'glide-bedside-ui-palette';
  const VALID = new Set(['calm', 'contrast', 'dark']);
  const META_COLORS = {
    calm: '#2f7f9f',
    contrast: '#005f73',
    dark: '#0f172a',
  };

  function normalize(value) {
    return VALID.has(value) ? value : 'calm';
  }

  function updateThemeColor(palette) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', META_COLORS[palette] || META_COLORS.calm);
  }

  function applyPalette(value) {
    const palette = normalize(value);
    document.documentElement.dataset.theme = palette;
    document.documentElement.style.colorScheme = palette === 'dark' ? 'dark' : 'light';
    updateThemeColor(palette);
    try { localStorage.setItem(STORAGE_KEY, palette); } catch (_) {}
    window.GlideThemePalette = palette;
    return palette;
  }

  function storedPalette() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
  }

  async function syncFromSettings() {
    try {
      const res = await fetch('/api/settings', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const settings = await res.json();
      applyPalette(settings.ui_palette || settings.theme_palette || 'calm');
    } catch (_) {
      // Theme sync is best-effort; keep the immediate local palette.
    }
  }

  applyPalette(storedPalette() || 'calm');

  window.GlideTheme = {
    apply: applyPalette,
    current: () => normalize(window.GlideThemePalette),
    sync: syncFromSettings,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncFromSettings, { once: true });
  } else {
    syncFromSettings();
  }
})();

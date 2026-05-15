/**
 * settings.js — Settings page logic
 *
 * Loads /api/settings on page load and populates all form fields.
 * On save: POSTs to /api/settings, shows success/error inline.
 */

'use strict';

const SAVE_BUTTON_HTML = '<i class="ph ph-floppy-disk" aria-hidden="true"></i> Save Settings';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

function updateClock() {
  const now = new Date();
  const timeEl = document.getElementById('current-time');
  const dateEl = document.getElementById('current-date');
  if (timeEl) {
    timeEl.textContent = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  }
}
setInterval(updateClock, 1000);
updateClock();

// ---------------------------------------------------------------------------
// Field list
// ---------------------------------------------------------------------------

const FIELD_IDS = [
  'child_name',
  'daily_limit_ml',
  'day_start_hour',
  'warn_threshold_yellow',
  'warn_threshold_red',
  'report_time_1',
  'report_time_2',
  'wellness_check_1',
  'wellness_check_2',
  'timezone',
  'ui_palette',
];

// ---------------------------------------------------------------------------
// Load settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const settings = await res.json();

    // Populate child name in header
    const nameEl = document.getElementById('child-name');
    if (nameEl && settings.child_name) {
      nameEl.textContent = settings.child_name;
    }

    // Populate each field
    for (const key of FIELD_IDS) {
      const value = settings[key];
      if (value === undefined || value === null) continue;

      const el = document.getElementById(key);
      if (!el) continue;

      if (el.tagName === 'SELECT') {
        el.value = String(value);
      } else if (el.type === 'radio') {
        // handled separately
      } else {
        el.value = String(value);
      }
    }

    // Units radio
    const unitsValue = settings.units || 'ml';
    const radios = document.querySelectorAll('input[name="units"]');
    radios.forEach((r) => { r.checked = r.value === unitsValue; });

    if (window.GlideTheme) {
      window.GlideTheme.apply(settings.ui_palette || 'calm');
    }

  } catch (err) {
    console.error('[settings] Load error:', err);
    showStatus('Failed to load settings: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Save settings
// ---------------------------------------------------------------------------

async function saveSettings() {
  const btn = document.getElementById('save-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ph ph-circle-notch" aria-hidden="true"></i> Saving…';
  showStatus('', '');

  const payload = {};
  for (const key of FIELD_IDS) {
    const el = document.getElementById(key);
    if (el) {
      payload[key] = el.value.trim();
    }
  }

  // Units radio
  const selectedUnit = document.querySelector('input[name="units"]:checked');
  if (selectedUnit) {
    payload.units = selectedUnit.value;
  }

  if (!['calm', 'contrast', 'dark'].includes(payload.ui_palette)) {
    payload.ui_palette = 'calm';
  }
  if (window.GlideTheme) {
    window.GlideTheme.apply(payload.ui_palette);
  }

  // Basic validation
  const limit = parseInt(payload.daily_limit_ml, 10);
  if (isNaN(limit) || limit < 100 || limit > 5000) {
    showStatus('Daily limit must be between 100 and 5000 ml', 'error');
    btn.disabled = false;
    btn.innerHTML = SAVE_BUTTON_HTML;
    return;
  }

  const yellow = parseInt(payload.warn_threshold_yellow, 10);
  const red = parseInt(payload.warn_threshold_red, 10);
  if (isNaN(yellow) || yellow < 10 || yellow > 100 || isNaN(red) || red < 10 || red > 100) {
    showStatus('Warning thresholds must be between 10% and 100%', 'error');
    btn.disabled = false;
    btn.innerHTML = SAVE_BUTTON_HTML;
    return;
  }

  if (yellow >= red) {
    showStatus('Yellow threshold must be less than red threshold', 'error');
    btn.disabled = false;
    btn.innerHTML = SAVE_BUTTON_HTML;
    return;
  }

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    showStatus('Saved!', 'success');

    // Update child name in header
    const nameEl = document.getElementById('child-name');
    if (nameEl && data.child_name) {
      nameEl.textContent = data.child_name;
    }
    if (window.GlideTheme) {
      window.GlideTheme.apply(data.ui_palette || payload.ui_palette);
    }

  } catch (err) {
    console.error('[settings] Save error:', err);
    showStatus('Error saving: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = SAVE_BUTTON_HTML;
  }
}

// ---------------------------------------------------------------------------
// Caregiver access
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[char]));
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderFamilyMembers(members) {
  const container = document.getElementById('family-members');
  if (!container) return;

  if (!Array.isArray(members) || members.length === 0) {
    container.innerHTML = '<div class="family-members-empty">No family access has been added yet.</div>';
    return;
  }

  container.innerHTML = members.map((member) => {
    const isActive = member.status === 'active';
    const statusLabel = isActive ? 'Accepted' : 'Invite pending';
    const statusClass = isActive ? 'active' : 'pending';
    const name = member.display_name || member.email || 'Caregiver';
    const dateText = isActive
      ? formatDateTime(member.accepted_at || member.joined_at)
      : formatDateTime(member.invited_at);
    const metaText = isActive
      ? (dateText ? `Accepted ${dateText}` : 'Registered and active')
      : (dateText ? `Invited ${dateText}` : 'Waiting for signup');

    return `
      <div class="family-member-row">
        <div class="family-member-main">
          <div class="family-member-name">${escapeHtml(name)}</div>
          <div class="family-member-email">${escapeHtml(member.email || '')}</div>
          <div class="family-member-meta">${escapeHtml(member.role || 'caregiver')} · ${escapeHtml(metaText)}</div>
        </div>
        <span class="family-member-status ${statusClass}">${statusLabel}</span>
      </div>
    `;
  }).join('');
}

async function loadFamilyMembers() {
  const container = document.getElementById('family-members');
  if (!container) return;

  try {
    const res = await fetch('/api/family/members');
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderFamilyMembers(data.members || []);
  } catch (err) {
    console.error('[settings] Family access load error:', err);
    container.innerHTML = `<div class="family-members-error">Could not load family access: ${escapeHtml(err.message)}</div>`;
  }
}

async function sendCaregiverInvite() {
  const btn = document.getElementById('invite-btn');
  const emailEl = document.getElementById('invite_email');
  const roleEl = document.getElementById('invite_role');
  const statusEl = document.getElementById('invite-status');
  if (!btn || !emailEl || !roleEl || !statusEl) return;

  const email = emailEl.value.trim().toLowerCase();
  const role = roleEl.value || 'caregiver';
  if (!email) {
    statusEl.textContent = 'Enter an email address.';
    statusEl.className = 'settings-status error';
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="ph ph-circle-notch" aria-hidden="true"></i> Sending…';
  statusEl.textContent = '';
  statusEl.className = 'settings-status';

  try {
    const res = await fetch('/api/family/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    statusEl.textContent = data.email?.sent
      ? `Invite email sent to ${email}.`
      : `${email} can sign in and access this tracker. Invite email is not configured yet.`;
    statusEl.className = 'settings-status success';
    emailEl.value = '';
    loadFamilyMembers();
  } catch (err) {
    console.error('[settings] Invite error:', err);
    statusEl.textContent = 'Invite failed: ' + err.message;
    statusEl.className = 'settings-status error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Invite';
  }
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

function showStatus(message, type) {
  const el = document.getElementById('settings-status');
  if (!el) return;
  el.textContent = message;
  el.className = 'settings-status ' + (type || '');

  // Auto-clear success after 3 seconds
  if (type === 'success') {
    setTimeout(() => {
      if (el.textContent === message) {
        el.textContent = '';
        el.className = 'settings-status';
      }
    }, 3000);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadSettings();
loadFamilyMembers();

document.getElementById('save-btn').addEventListener('click', saveSettings);
const paletteSelect = document.getElementById('ui_palette');
if (paletteSelect) {
  paletteSelect.addEventListener('change', () => {
    if (window.GlideTheme) window.GlideTheme.apply(paletteSelect.value);
  });
}
const inviteBtn = document.getElementById('invite-btn');
if (inviteBtn) inviteBtn.addEventListener('click', sendCaregiverInvite);

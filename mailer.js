'use strict';

const nodemailer = require('nodemailer');

const truthy = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());

const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || process.env.PUBLIC_APP_URL || 'https://bedside.glidechart.com').replace(/\/$/, '');
const MAIL_FROM = process.env.MAIL_FROM || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_SECURE = truthy(process.env.SMTP_SECURE);
const INVITE_EMAIL_ENABLED = truthy(process.env.INVITE_EMAIL_ENABLED);

function configured() {
  return Boolean(INVITE_EMAIL_ENABLED && MAIL_FROM && SMTP_HOST && SMTP_USER && SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!configured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendCaregiverInviteEmail({ to, familyName, patientName, inviterName, role }) {
  if (!to) throw new Error('Invite recipient email is required');
  const tx = getTransporter();
  if (!tx) return { sent: false, reason: 'mail_not_configured' };

  const appUrl = APP_PUBLIC_URL;
  const safeFamily = familyName || 'a family';
  const safePatient = patientName || 'their patient';
  const safeInviter = inviterName || 'A caregiver';
  const safeRole = role || 'caregiver';
  const subject = `You're invited to Glide Bedside`;
  const text = `${safeInviter} invited you to join ${safeFamily} on Glide Bedside as a ${safeRole}.\n\nSign in with this email address to access ${safePatient}'s tracker:\n${appUrl}/login\n\nIf you were not expecting this invitation, you can ignore this email.`;
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.5;color:#202124;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <h1 style="font-size:22px;margin:0 0 12px;color:#1a73e8;">You're invited to Glide Bedside</h1>
    <p>${escapeHtml(safeInviter)} invited you to join <strong>${escapeHtml(safeFamily)}</strong> as a ${escapeHtml(safeRole)}.</p>
    <p>Sign in with this email address to access ${escapeHtml(safePatient)}'s tracker.</p>
    <p><a href="${escapeHtml(appUrl)}/login" style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">Open Glide Bedside</a></p>
    <p style="color:#5f6368;font-size:14px;">If you were not expecting this invitation, you can ignore this email.</p>
  </div>
</body></html>`;

  const info = await tx.sendMail({ from: MAIL_FROM, to, subject, text, html });
  return { sent: true, messageId: info.messageId || null };
}

module.exports = {
  configured,
  sendCaregiverInviteEmail,
};

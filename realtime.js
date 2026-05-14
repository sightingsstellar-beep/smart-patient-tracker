/*
 * realtime.js — lightweight in-process Server-Sent Events fanout.
 *
 * Used to notify already-authenticated family dashboard sessions that care data
 * changed so each tab/device can refresh immediately instead of waiting for the
 * periodic polling fallback.
 */

'use strict';

const db = require('./db');

const clients = new Map();
let nextClientId = 1;
let nextEventId = Date.now();

function scopeKey(scope = {}) {
  const familyId = scope.familyId || scope.family_id || db.DEFAULT_FAMILY_ID;
  const patientId = scope.patientId || scope.patient_id || db.DEFAULT_PATIENT_ID;
  return `${familyId}:${patientId}`;
}

function send(client, event, payload) {
  try {
    client.res.write(`id: ${nextEventId++}\n`);
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch (_) {
    return false;
  }
}

function addClient(scope, req, res) {
  const id = nextClientId++;
  const key = scopeKey(scope);
  const client = { id, key, res };
  clients.set(id, client);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  send(client, 'connected', { ok: true, ts: Date.now() });

  const heartbeat = setInterval(() => {
    if (!send(client, 'ping', { ts: Date.now() })) {
      clearInterval(heartbeat);
      clients.delete(id);
    }
  }, 25000);
  heartbeat.unref?.();

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(id);
  });
}

function publishCareChange(scope = {}, detail = {}) {
  const key = scopeKey(scope);
  const payload = {
    type: 'care-log-changed',
    ts: Date.now(),
    ...detail,
  };

  for (const [id, client] of clients) {
    if (client.key !== key) continue;
    if (!send(client, 'care-log-changed', payload)) clients.delete(id);
  }
}

module.exports = {
  addClient,
  publishCareChange,
};

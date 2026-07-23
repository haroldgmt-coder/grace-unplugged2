// netlify/edge-functions/log.js
// Receives client-side failure reports. Browser errors — a dropped stream, a
// rendering crash, a proxy page — leave no trace in server logs on their own,
// so the two halves of a failure would otherwise never appear together.

const MAX_BODY_BYTES = 16000;
const MAX_FIELD_CHARS = 4000;

// A denylist, not an allowlist. An allowlist silently discards any field the
// client starts sending later, which is exactly the failure you can't see:
// the log looks fine, it's just missing the thing you needed. These specific
// keys are dropped because they carry conversation text.
const CONTENT_KEYS = new Set([
  'messages', 'message_content', 'system', 'content', 'reply', 'text', 'prompt', 'conversation'
]);

export default async (request, context) => {
  const log = (fields) => console.log(JSON.stringify({
    event: 'client.report',
    reportId: context.requestId,
    at: new Date().toISOString(),
    ...fields
  }));

  if (request.method !== 'POST') {
    return new Response(null, { status: 405 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    log({ cause: 'body_too_large', bodyChars: raw.length });
    return new Response(null, { status: 413 });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    // A malformed report is itself a signal — something is wrong with the
    // client. Record it rather than returning 400 into the void.
    log({ cause: 'report_parse_failed', parseError: err.message, bodyChars: raw.length });
    return new Response(null, { status: 400 });
  }

  const entry = {};
  const dropped = [];
  for (const [key, value] of Object.entries(payload)) {
    if (CONTENT_KEYS.has(key)) {
      dropped.push(key);
      continue;
    }
    entry[key] = typeof value === 'string'
      ? value.slice(0, MAX_FIELD_CHARS)
      : JSON.stringify(value)?.slice(0, MAX_FIELD_CHARS);
  }

  // Say so when something was withheld, so an engineer reading this never
  // wonders whether a field was absent or removed.
  if (dropped.length) entry.droppedContentKeys = dropped.join(',');

  log(entry);

  // The client uses sendBeacon and never reads this.
  return new Response(null, { status: 204 });
};

export const config = { path: '/api/log' };

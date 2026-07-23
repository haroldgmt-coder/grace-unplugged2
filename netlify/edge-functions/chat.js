// netlify/edge-functions/chat.js
// Streams the Anthropic response straight through to the browser as SSE.
// Runs on Deno at the edge — no 10s serverless cap, and bytes start flowing
// within a second or two, which keeps proxies from timing the request out.

const MODEL = 'claude-sonnet-4-6'; // change here if your account uses a different model
const MAX_TOKENS = 1500;

export default async (request) => {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return Response.json(
      { error: 'ANTHROPIC_API_KEY is not set on the server.' },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body was not valid JSON.' }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return Response.json({ error: 'No messages were sent.' }, { status: 400 });
  }

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        system: body.system || '',
        messages
      })
    });
  } catch (err) {
    return Response.json(
      { error: `Could not reach the Anthropic API: ${err.message}` },
      { status: 502 }
    );
  }

  // Errors arrive before the stream opens, so surface them as plain JSON.
  if (!upstream.ok) {
    const detail = await upstream.text();
    let message = `The Anthropic API returned HTTP ${upstream.status}.`;
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      if (detail) message = detail.slice(0, 300);
    }
    return Response.json({ error: message }, { status: upstream.status });
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no' // asks intermediaries not to buffer the stream
    }
  });
};

export const config = { path: '/api/chat' };

// netlify/edge-functions/chat.js
// Streams the Anthropic response straight through to the browser as SSE.
//
// LOGGING POLICY
// Two separate rules, often confused:
//   1. The user sees a short, plain-language message. No stack traces, no
//      internal identifiers beyond the reference code.
//   2. The log gets everything — raw upstream bodies, stacks, error types.
// Sanitizing (1) is not a reason to do (2). The only thing withheld from the
// log is conversation content, because Pastoral Care sessions contain
// confidential details about named people and logs are broadly readable.

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8000;
const MAX_TOKENS_CEILING = 16000;
const MALFORMED_LINE_LOG_LIMIT = 5; // then count silently, so a broken stream can't flood the log

export default async (request, context) => {
  const startedAt = Date.now();
  const requestId = context.requestId;
  const elapsed = () => Date.now() - startedAt;

  const log = (event, fields = {}) => {
    console.log(JSON.stringify({
      event,
      requestId,
      deploy: context.deploy?.id,
      at: new Date().toISOString(),
      ...fields
    }));
  };

  // `userMessage` goes in the response; `logFields` goes in the log. Callers
  // are expected to pass more to the second than the first.
  const fail = (status, userMessage, logFields = {}) => {
    log('chat.failed', { status, userMessage, ms: elapsed(), ...logFields });
    return Response.json({ error: userMessage, requestId }, {
      status,
      headers: { 'x-request-id': requestId }
    });
  };

  try {
    if (request.method !== 'POST') {
      return fail(405, 'Method not allowed.', { method: request.method });
    }

    const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      return fail(500, 'ANTHROPIC_API_KEY is not set on the server.', { cause: 'missing_api_key' });
    }

    const rawBody = await request.text();
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (err) {
      // The body may contain conversation text, so log its shape and the
      // parser's complaint — which includes a character offset — but not the
      // body itself.
      return fail(400, 'Request body was not valid JSON.', {
        cause: 'body_parse_failed',
        parseError: err.message,
        bodyChars: rawBody.length
      });
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) {
      return fail(400, 'No messages were sent.', {
        cause: 'empty_messages',
        receivedKeys: Object.keys(body).join(',')
      });
    }

    const requested = Number(body.maxTokens);
    const maxTokens = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 256), MAX_TOKENS_CEILING)
      : MAX_TOKENS;
    if (Number.isFinite(requested) && requested !== maxTokens) {
      log('chat.max_tokens_clamped', { requested, applied: maxTokens });
    }

    const historyChars = messages.reduce((n, m) => n + String(m.content || '').length, 0);

    log('chat.request', {
      tool: body.tool || 'unknown',
      sessionId: body.sessionId,
      model: MODEL,
      maxTokens,
      turns: messages.length,
      systemChars: String(body.system || '').length,
      historyChars,
      country: context.geo?.country?.code
    });

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
          max_tokens: maxTokens,
          stream: true,
          system: body.system || '',
          messages
        })
      });
    } catch (err) {
      return fail(502, 'Could not reach the Anthropic API.', {
        cause: 'fetch_threw',
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack
      });
    }

    if (!upstream.ok) {
      const detail = await upstream.text();
      let userMessage = `The Anthropic API returned HTTP ${upstream.status}.`;
      let errorType = null;
      let parseError = null;

      try {
        const parsed = JSON.parse(detail);
        errorType = parsed?.error?.type ?? null;
        if (parsed?.error?.message) userMessage = parsed.error.message;
      } catch (err) {
        parseError = err.message;
      }

      // The raw body goes to the log whether or not it parsed. This is
      // Anthropic's error text, not the congregant's words. Worth knowing:
      // validation errors can name a request field path (messages.1.content),
      // so it identifies structure, not content.
      return fail(upstream.status, userMessage, {
        cause: 'upstream_error',
        errorType,
        parseError,
        rawBody: detail.slice(0, 2000),
        upstreamRequestId: upstream.headers.get('request-id'),
        retryAfter: upstream.headers.get('retry-after')
      });
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let firstTokenMs = null;
    let stopReason = null;
    let inputTokens = null;
    let outputTokens = null;
    let streamErrorType = null;
    let malformedLines = 0;

    const monitor = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);

        // Monitoring must never take the stream down with it. If the code
        // below throws, the user still gets their sermon — but the reason is
        // recorded rather than lost.
        try {
          buffer += decoder.decode(chunk, { stream: true });
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith('data:')) continue;

            let evt;
            try {
              evt = JSON.parse(line.slice(5));
            } catch (err) {
              malformedLines += 1;
              if (malformedLines <= MALFORMED_LINE_LOG_LIMIT) {
                log('chat.malformed_sse_line', {
                  parseError: err.message,
                  line: line.slice(0, 200)
                });
              }
              continue;
            }

            if (evt.type === 'content_block_delta' && firstTokenMs === null) {
              firstTokenMs = elapsed();
              log('chat.first_token', { ms: firstTokenMs });
            } else if (evt.type === 'message_start') {
              inputTokens = evt.message?.usage?.input_tokens ?? null;
            } else if (evt.type === 'message_delta') {
              if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
              if (evt.usage?.output_tokens != null) outputTokens = evt.usage.output_tokens;
            } else if (evt.type === 'error') {
              streamErrorType = evt.error?.type ?? 'unknown';
              // Mid-stream errors are the ones that look like "it just stopped"
              // from the user's side, so log the whole event.
              log('chat.stream_error', {
                errorType: streamErrorType,
                errorMessage: evt.error?.message,
                raw: JSON.stringify(evt).slice(0, 1000),
                charsBefore: firstTokenMs === null ? 0 : undefined,
                ms: elapsed()
              });
            }
          }
        } catch (err) {
          log('chat.monitor_threw', {
            errorName: err.name,
            errorMessage: err.message,
            stack: err.stack
          });
        }
      },

      flush() {
        log('chat.complete', {
          tool: body.tool || 'unknown',
          stopReason,          // 'end_turn' is healthy; 'max_tokens' means truncated
          inputTokens,
          outputTokens,
          firstTokenMs,
          totalMs: elapsed(),
          streamErrorType,
          malformedLines
        });
      }
    });

    return new Response(upstream.body.pipeThrough(monitor), {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
        'x-request-id': requestId
      }
    });
  } catch (err) {
    // Without this, an unexpected throw becomes an opaque platform 500 with no
    // reference code and nothing tying it to what the user was doing.
    return fail(500, 'The server hit an unexpected error.', {
      cause: 'handler_threw',
      errorName: err.name,
      errorMessage: err.message,
      stack: err.stack
    });
  }
};

export const config = { path: '/api/chat' };

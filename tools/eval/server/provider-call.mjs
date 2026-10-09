// A direct call of an OpenAI-compatible model provider for diagnostics, outside the gateway: the gateway (@wizard/llm
// providers.ts) reduces a provider error to a code and keeps no provider text (data boundary), so `diagnose`
// (tools/deploy/infra.mjs LLM_SHAPE_PROBE) and the shape probe of v3 (probe-shape.mjs, on a failed variant only) send
// the request themselves and print the HTTP status and the start of the provider's answer. Only synthetic content goes
// this way. Both functions are self-contained: the scripts that run in the worker pod embed their source.

/**
 * The chat body @ai-sdk/openai-compatible sends for these messages (before @wizard/llm transformBody): a user message
 * with attachments as text + image_url parts (data URL), an assistant tool call with JSON arguments, a tool result as
 * JSON text. A test keeps it equal to the gateway's request.
 */
export function openAiBody({ model, messages, tools, toolChoice, temperature, maxTokens }) {
  const out = [];
  for (const m of messages) {
    if (m.role === "system") out.push({ role: "system", content: m.content });
    else if (m.role === "user")
      out.push(
        m.attachments?.length
          ? {
              role: "user",
              content: [
                { type: "text", text: m.content },
                ...m.attachments.map((a) => ({
                  type: "image_url",
                  image_url: { url: `data:${a.mime};base64,${a.data}` },
                })),
              ],
            }
          : { role: "user", content: m.content },
      );
    else if (m.role === "assistant")
      out.push(
        m.toolCalls?.length
          ? {
              role: "assistant",
              content: m.content || null,
              tool_calls: m.toolCalls.map((t) => ({
                id: t.id,
                type: "function",
                function: { name: t.name, arguments: JSON.stringify(t.args) },
              })),
            }
          : { role: "assistant", content: m.content },
      );
    else
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? null),
      });
  }
  return {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: out,
    ...(tools?.length
      ? {
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          tool_choice: toolChoice,
        }
      : {}),
  };
}

/**
 * POST `body` to `url` with the key as a bearer token. Returns {status, ms, ok, note, json?, error?, timeout?}: on an
 * HTTP error the provider's text, whitespace collapsed, key-like parts masked, ≤ 300 chars; on success
 * «finish=… tool_calls=… text=…» and the parsed answer; without an answer (network, timeout) status 0 and the error
 * code ≤ 160 chars. The key and `secrets` never appear in what it returns.
 */
export async function providerCall({
  url,
  key,
  headers = {},
  body,
  timeoutMs = 60000,
  fetch: f = globalThis.fetch,
  secrets = [],
}) {
  const mask = (s) => {
    let t = String(s ?? "");
    for (const k of [key, ...secrets]) if (k && String(k).length >= 6) t = t.split(String(k)).join("***");
    return t
      .replace(/\bbearer\s+[^\s"',;}]+/gi, "Bearer ***")
      .replace(
        /\b(api[_-]?key|access[_-]?token|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
        "$1$2***",
      )
      .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-***")
      .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "***");
  };
  const t0 = Date.now();
  try {
    const r = await f(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const txt = await r.text();
    const ms = Date.now() - t0;
    if (!r.ok) return { status: r.status, ms, ok: false, note: mask(txt.replace(/\s+/g, " ")).slice(0, 300) };
    let j = null;
    try {
      j = JSON.parse(txt);
    } catch {}
    if (!j) return { status: r.status, ms, ok: true, note: mask(txt.slice(0, 120)) };
    const c = j.choices?.[0];
    const note = `finish=${c?.finish_reason}${c?.message?.tool_calls?.length ? ` tool_calls=${c.message.tool_calls.length}` : ""} text=${JSON.stringify(String(c?.message?.content ?? "").slice(0, 40))}`;
    return { status: r.status, ms, ok: true, note, json: j };
  } catch (e) {
    const timeout = e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError";
    return {
      status: 0,
      ms: Date.now() - t0,
      ok: false,
      timeout,
      error: mask(String(e?.cause?.code ?? e?.message ?? e)).slice(0, 160),
    };
  }
}

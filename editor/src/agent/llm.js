// OpenAI-compatible chat completions client (Ollama, llama.cpp server, LM Studio, vLLM, OpenRouter,
// OpenAI, and anything else that speaks /v1/chat/completions). Streams when the server allows it.

export class LLMError extends Error {}

export function endpoint(settings) {
  const base = settings.useProxy ? '/llm-proxy' : (settings.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new LLMError('Set an endpoint in Agent settings, for example http://localhost:11434/v1 for Ollama.');
  return `${base}/chat/completions`;
}

export function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();
}

export async function chat({ settings, messages, onDelta = () => {}, signal, temperature }) {
  const url = endpoint(settings);
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: temperature ?? settings.temperature ?? 0.2,
        stream: true,
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new LLMError(
      `Could not reach ${url}. If the server is running, it may be blocking browser requests (CORS). ` +
      'For Ollama start it with OLLAMA_ORIGINS="*", or turn on "Route through the dev server" in Agent settings.',
    );
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new LLMError(`${res.status} ${res.statusText} from the model server. ${detail}`);
  }

  const type = res.headers.get('content-type') || '';
  if (!type.includes('event-stream') || !res.body) {
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content ?? '';
    onDelta(text, text);
    return stripThinking(text);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? '';
        if (delta) {
          full += delta;
          onDelta(delta, full);
        }
      } catch { /* partial or non-JSON keepalive line */ }
    }
  }
  return stripThinking(full);
}

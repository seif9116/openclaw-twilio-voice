export async function* streamChat({ messages, sessionKey, apiUrl, apiToken, model, signal }) {
  const fetchStart = Date.now();
  console.error(`[llm] fetch start → ${apiUrl}`);
  const res = await fetch(`${apiUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiToken}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      thinking: { type: "disabled" },
      messages,
    }),
    signal,
  });

  console.error(`[llm] fetch responded: ${res.status} in ${Date.now() - fetchStart}ms`);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM API error: ${res.status} ${res.statusText} ${body}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstChunkTime = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) { console.error(`[llm] stream done, total ${Date.now() - fetchStart}ms`); break; }
    if (!firstChunkTime) { firstChunkTime = Date.now(); console.error(`[llm] first chunk in ${firstChunkTime - fetchStart}ms, ${value.length} bytes`); }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {}
    }
  }
}

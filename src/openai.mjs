import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { config } from "./config.mjs";
import { broker } from "./broker.mjs";
import { ollama, OllamaError } from "./ollama.mjs";
import { providers } from "./providers.mjs";
import { sendJson, sendError, readJson, ndjson } from "./http.mjs";

const now = () => Math.floor(Date.now() / 1000);

/**
 * Ollama option names differ from the OpenAI field names, and the ones callers
 * actually reach for are worth translating so existing tooling works unchanged.
 */
function toOllamaOptions(body) {
  const options = {};
  if (body.temperature != null) options.temperature = body.temperature;
  if (body.top_p != null) options.top_p = body.top_p;
  if (body.top_k != null) options.top_k = body.top_k;
  if (body.seed != null) options.seed = body.seed;
  if (body.presence_penalty != null) options.presence_penalty = body.presence_penalty;
  if (body.frequency_penalty != null) options.repeat_penalty = 1 + body.frequency_penalty;
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null) options.num_predict = maxTokens;
  if (body.stop != null) options.stop = Array.isArray(body.stop) ? body.stop : [body.stop];
  // Context length has no OpenAI equivalent, but agent loops accumulate long
  // tool outputs and are the first thing to overflow it. Allow an explicit
  // override, and otherwise let the server default stand.
  const ctx = body.num_ctx ?? body.context_length ?? config.contextTokens;
  if (ctx) options.num_ctx = Number(ctx);
  return options;
}

/**
 * Let callers turn reasoning off (or down) without knowing Ollama's spelling.
 * OpenAI's reasoning_effort maps onto it, and `think` passes straight through.
 */
function thinkSetting(body) {
  if (typeof body.think === "boolean" || typeof body.think === "string") return body.think;
  const effort = body.reasoning_effort;
  if (effort === "none" || effort === "minimal") return false;
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  return undefined;
}

/**
 * Ollama and OpenAI disagree about tool calls in three ways that each break a
 * real client:
 *   - arguments: Ollama uses an object, the OpenAI spec a JSON-encoded string,
 *     and every SDK calls JSON.parse on it;
 *   - the call needs an explicit type: "function";
 *   - index belongs on the call, not inside function.
 * Agent loops are the main consumer of this endpoint, so the translation has to
 * be exact rather than approximately right.
 */
function toOpenAiToolCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return null;
  return calls.map((call, index) => {
    const fn = call.function ?? {};
    const args = fn.arguments;
    return {
      index: call.index ?? fn.index ?? index,
      id: call.id ?? `call_${Math.random().toString(36).slice(2, 12)}`,
      type: "function",
      function: {
        name: fn.name ?? call.name ?? "",
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      },
    };
  });
}

/**
 * The OpenAI schema allows `content` to be either a string or an array of typed
 * parts, and real clients use both -- the pi harness sends arrays. Ollama only
 * accepts a string, plus a separate `images` array for vision. Flatten here so
 * the difference never reaches the runner.
 */
export function flattenContent(content) {
  if (typeof content === "string") return { text: content, images: [] };
  if (content == null) return { text: "", images: [] };
  if (!Array.isArray(content)) return { text: String(content), images: [] };

  const text = [];
  const images = [];
  for (const part of content) {
    if (typeof part === "string") {
      text.push(part);
    } else if (part?.type === "text" && typeof part.text === "string") {
      text.push(part.text);
    } else if (part?.type === "input_text" && typeof part.text === "string") {
      text.push(part.text);
    } else if (part?.type === "image_url") {
      // Ollama takes bare base64, not a data: URL.
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      const match = typeof url === "string" ? url.match(/^data:[^;]+;base64,(.+)$/) : null;
      if (match) images.push(match[1]);
    }
  }
  return { text: text.join("\n"), images };
}

/**
 * The inbound direction of the same mismatch: a client replaying an assistant
 * turn sends arguments as a string, which Ollama will not parse.
 */
function toUpstreamMessages(messages) {
  return messages.map((original) => {
    const { text, images } = flattenContent(original.content);
    const message = { ...original, content: text };
    if (images.length > 0) message.images = images;

    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call) => {
        const fn = call.function ?? {};
        let args = fn.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        return { ...call, function: { ...fn, arguments: args ?? {} } };
      }),
    };
  });
}

const finishReason = (reason) => {
  if (!reason) return "stop";
  if (reason === "length") return "length";
  return "stop";
};

function usageFrom(chunk) {
  const prompt = chunk.prompt_eval_count ?? 0;
  const completion = chunk.eval_count ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

/** Resolve the model a request should run against. */
function resolveModel(body) {
  const requested = typeof body.model === "string" ? body.model.trim() : "";
  if (requested && requested !== "default" && requested !== "auto") return requested;
  const fallback = broker.pinnedModel;
  if (fallback) return fallback;
  const err = new Error("no model specified and no model is pinned on the server");
  err.status = 400;
  throw err;
}

export async function listModels(req, res) {
  const federated = providers.catalogue();
  const models = federated.length > 0 ? federated : await ollama.models();
  sendJson(res, 200, {
    object: "list",
    data: models.map((m) => ({
      id: m.name,
      object: "model",
      created: m.modifiedAt ? Math.floor(new Date(m.modifiedAt).getTime() / 1000) : now(),
      owned_by: "sharegpu",
      // Non-standard but useful: clients can see the cost of asking for a swap.
      sharegpu: {
        size_mb: m.sizeMb,
        parameter_size: m.parameterSize,
        quantization: m.quantization,
        pinned: m.name === broker.pinnedModel,
        // Which machines can serve this, and whether one already holds it.
        providers: m.providers ?? ["local"],
        resident: m.resident ?? false,
      },
    })),
  });
}

/**
 * Run one LLM request under a broker slot. `build` turns the resolved model
 * into an upstream request; the slot is held for the whole response, streaming
 * included, so concurrency accounting matches real GPU occupancy.
 */
async function withSlot(req, res, client, model, fn) {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  req.on("close", onClose);

  let slot;
  try {
    slot = await broker.acquireLlm({ model, clientId: client.label, signal: controller.signal });
  } catch (err) {
    req.off("close", onClose);
    if (err.status === 499) return;
    sendError(res, err.status ?? 503, err.message, { retryAfter: err.retryAfter });
    return;
  }

  try {
    await fn(slot, controller.signal);
  } finally {
    slot.release();
    req.off("close", onClose);
  }
}

export async function chatCompletions(req, res, client) {
  const body = await readJson(req);
  const model = resolveModel(body);
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    sendError(res, 400, "messages must be a non-empty array");
    return;
  }

  const stream = body.stream !== false && body.stream !== undefined ? Boolean(body.stream) : false;
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  await withSlot(req, res, client, model, async (slot, signal) => {
    const buildBody = (withThink) => ({
      model,
      messages: toUpstreamMessages(messages),
      stream,
      keep_alive: config.keepAlive,
      options: toOllamaOptions(body),
      ...(body.tools ? { tools: body.tools } : {}),
      ...(withThink && thinkSetting(body) !== undefined ? { think: thinkSetting(body) } : {}),
      ...(body.response_format?.type === "json_object" ? { format: "json" } : {}),
    });

    // Route to a backend that actually has this model. Falls back to the local
    // one so a single-machine install behaves exactly as before.
    const backend = providers.pickFor(model);
    const baseUrl = backend?.url;

    const call = (withThink) =>
      ollama.raw("/api/chat", {
        method: "POST",
        signal,
        timeoutMs: config.requestTimeoutMs,
        baseUrl,
        body: buildBody(withThink),
      });

    let upstream = await call(true);

    // Whether a model supports a thinking mode is a property of its template,
    // not something the caller can know. A client that always asks for one --
    // as most agent harnesses do -- should not get a hard 400 for a model that
    // simply has no scratchpad. Drop the flag and retry once.
    if (!upstream.ok) {
      const detail = await upstream.text();
      if (/does not support thinking/i.test(detail)) {
        upstream = await call(false);
      } else {
        sendError(res, upstream.status, detail || "upstream error", { queued_ms: slot.waitedMs });
        return;
      }
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      sendError(res, upstream.status, text || "upstream error", { queued_ms: slot.waitedMs });
      return;
    }

    if (!stream) {
      const data = await upstream.json();
      sendJson(res, 200, {
        id,
        object: "chat.completion",
        created: now(),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: data.message?.content ?? "",
              // Reasoning models return their scratchpad separately. Dropping it
              // would make a thinking-heavy reply look like an empty response.
              ...(data.message?.thinking ? { reasoning_content: data.message.thinking } : {}),
              ...(toOpenAiToolCalls(data.message?.tool_calls)
                ? { tool_calls: toOpenAiToolCalls(data.message.tool_calls) }
                : {}),
            },
            // A loop that branches on finish_reason must see tool_calls, or it
            // will treat a tool request as a finished answer.
            finish_reason: data.message?.tool_calls?.length ? "tool_calls" : finishReason(data.done_reason),
          },
        ],
        usage: usageFrom(data),
        sharegpu: { queued_ms: slot.waitedMs, model, provider: backend?.id ?? "local" },
      });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-sharegpu-queued-ms": String(slot.waitedMs),
      "x-sharegpu-provider": backend?.id ?? "local",
    });
    res.flushHeaders?.();

    const write = (payload) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    let sentRole = false;
    let sawToolCall = false;
    try {
      for await (const chunk of ndjson(Readable.fromWeb(upstream.body))) {
        if (res.writableEnded) break;
        if (chunk.error) {
          write({ error: { message: chunk.error } });
          break;
        }
        const delta = {};
        if (!sentRole) {
          delta.role = "assistant";
          sentRole = true;
        }
        if (chunk.message?.content) delta.content = chunk.message.content;
        if (chunk.message?.thinking) delta.reasoning_content = chunk.message.thinking;
        const calls = toOpenAiToolCalls(chunk.message?.tool_calls);
        if (calls) {
          delta.tool_calls = calls;
          sawToolCall = true;
        }

        if (chunk.done) {
          if (Object.keys(delta).length > 0) {
            write({ id, object: "chat.completion.chunk", created: now(), model, choices: [{ index: 0, delta, finish_reason: null }] });
          }
          write({
            id,
            object: "chat.completion.chunk",
            created: now(),
            model,
            choices: [
              { index: 0, delta: {}, finish_reason: sawToolCall ? "tool_calls" : finishReason(chunk.done_reason) },
            ],
            usage: usageFrom(chunk),
          });
        } else if (Object.keys(delta).length > 0) {
          write({ id, object: "chat.completion.chunk", created: now(), model, choices: [{ index: 0, delta, finish_reason: null }] });
        }
      }
      if (!res.writableEnded) res.write("data: [DONE]\n\n");
    } catch (err) {
      if (!res.writableEnded && err.name !== "AbortError") {
        write({ error: { message: err.message } });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  });
}

export async function completions(req, res, client) {
  const body = await readJson(req);
  const model = resolveModel(body);
  const prompt = Array.isArray(body.prompt) ? body.prompt.join("\n") : body.prompt;
  if (typeof prompt !== "string" || !prompt) {
    sendError(res, 400, "prompt is required");
    return;
  }

  await withSlot(req, res, client, model, async (slot, signal) => {
    const upstream = await ollama.raw("/api/generate", {
      method: "POST",
      signal,
      timeoutMs: config.requestTimeoutMs,
      body: { model, prompt, stream: false, keep_alive: config.keepAlive, options: toOllamaOptions(body) },
    });
    if (!upstream.ok) {
      sendError(res, upstream.status, (await upstream.text()) || "upstream error");
      return;
    }
    const data = await upstream.json();
    sendJson(res, 200, {
      id: `cmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      object: "text_completion",
      created: now(),
      model,
      choices: [{ index: 0, text: data.response ?? "", finish_reason: finishReason(data.done_reason), logprobs: null }],
      usage: usageFrom(data),
      sharegpu: { queued_ms: slot.waitedMs },
    });
  });
}

export async function embeddings(req, res, client) {
  const body = await readJson(req);
  const model = resolveModel(body);
  const raw = body.input;
  const inputs = Array.isArray(raw) ? raw : [raw];
  if (inputs.length === 0 || inputs.some((i) => typeof i !== "string")) {
    sendError(res, 400, "input must be a string or an array of strings");
    return;
  }

  await withSlot(req, res, client, model, async (slot, signal) => {
    const upstream = await ollama.raw("/api/embed", {
      method: "POST",
      signal,
      timeoutMs: config.requestTimeoutMs,
      body: { model, input: inputs, keep_alive: config.keepAlive },
    });
    if (!upstream.ok) {
      sendError(res, upstream.status, (await upstream.text()) || "upstream error");
      return;
    }
    const data = await upstream.json();
    const vectors = data.embeddings ?? [];
    sendJson(res, 200, {
      object: "list",
      data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
      model,
      usage: { prompt_tokens: data.prompt_eval_count ?? 0, total_tokens: data.prompt_eval_count ?? 0 },
      sharegpu: { queued_ms: slot.waitedMs },
    });
  });
}

export { OllamaError };

export function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

export function sendError(res, status, message, extra = {}) {
  const headers = {};
  if (extra.retryAfter) headers["retry-after"] = String(extra.retryAfter);
  sendJson(res, status, { error: { message, type: extra.type ?? "sharegpu_error", ...extra } }, headers);
}

export function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(text);
}

export async function readJson(req, { limitBytes = 32 * 1024 * 1024 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      const err = new Error("request body too large");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("request body is not valid JSON");
    err.status = 400;
    throw err;
  }
}

export function openSse(res, extraHeaders = {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...extraHeaders,
  });
  res.flushHeaders?.();
  return {
    send(data, event) {
      if (res.writableEnded) return false;
      if (event) res.write(`event: ${event}\n`);
      res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
      return true;
    },
    comment(text) {
      if (!res.writableEnded) res.write(`: ${text}\n\n`);
    },
    close() {
      if (!res.writableEnded) res.end();
    },
  };
}

/** Split an NDJSON byte stream into parsed objects. */
export async function* ndjson(stream) {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* a partial line from a truncated upstream; drop it */
      }
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      yield JSON.parse(tail);
    } catch {
      /* ignore */
    }
  }
}

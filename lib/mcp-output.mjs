function safeReplacement(containsOutboundSecret) {
  const replacement = "[已隐藏]";
  const encoded = JSON.stringify(replacement).slice(1, -1);
  return containsOutboundSecret(encoded) ? "" : replacement;
}

function redactStringValue(value, redactOutbound, containsOutboundSecret) {
  const redacted = redactOutbound(value);
  const encoded = JSON.stringify(redacted).slice(1, -1);
  return containsOutboundSecret(encoded)
    ? safeReplacement(containsOutboundSecret)
    : redacted;
}

function redactMappedValue(value, redactOutbound, containsOutboundSecret) {
  if (typeof value === "string") {
    return redactStringValue(value, redactOutbound, containsOutboundSecret);
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    const text = String(value);
    const redacted = redactStringValue(text, redactOutbound, containsOutboundSecret);
    return redacted === text ? value : redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      redactMappedValue(item, redactOutbound, containsOutboundSecret));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactMappedValue(item, redactOutbound, containsOutboundSecret),
      ]),
    );
  }
  return value;
}

export function createMcpOutput(redactOutbound, containsOutboundSecret) {
  const supportedImages = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

  function ok(value) {
    const safeValue = redactMappedValue(
      value,
      redactOutbound,
      containsOutboundSecret,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(safeValue, null, 2) }],
    };
  }

  function fail(error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: "text",
        text: redactStringValue(message, redactOutbound, containsOutboundSecret),
      }],
      isError: true,
    };
  }

  function image(bytes, mimeType) {
    if (!supportedImages.has(mimeType)) throw new Error("MCP 图片格式不受支持");
    return {
      content: [{
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType,
      }],
    };
  }

  return { ok, fail, image };
}

export function plainText(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .trim();
}

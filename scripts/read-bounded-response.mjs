export async function readBoundedResponseBytes(response, { maxBytes, label = "response" }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive integer");
  }
  const contentLengthValue = response.headers?.get?.("content-length") ?? null;
  let declaredBytes = null;
  if (contentLengthValue !== null) {
    if (!/^\d+$/u.test(contentLengthValue)) {
      await cancelBody(response.body, `${label} Content-Length is invalid`);
      throw new Error(`${label} Content-Length is invalid`);
    }
    declaredBytes = Number(contentLengthValue);
    if (!Number.isSafeInteger(declaredBytes)) {
      await cancelBody(response.body, `${label} Content-Length is invalid`);
      throw new Error(`${label} Content-Length is invalid`);
    }
    if (declaredBytes > maxBytes) {
      await cancelBody(response.body, `${label} exceeded ${maxBytes} bytes`);
      throw new Error(`${label} exceeded ${maxBytes} bytes`);
    }
  }

  const reader = response.body?.getReader?.();
  if (!reader) throw new Error(`${label} body is not a readable stream`);
  const chunks = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error(`${label} returned an invalid chunk`);
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        throw new Error(`${label} exceeded ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try {
      await reader.cancel(error instanceof Error ? error.message : String(error));
    } catch {
      // The stream may already be closed or canceled.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (declaredBytes !== null && declaredBytes !== receivedBytes) {
    throw new Error(`${label} body did not match Content-Length`);
  }
  return Buffer.concat(chunks, receivedBytes);
}

async function cancelBody(body, reason) {
  try {
    await body?.cancel?.(reason);
  } catch {
    // Preserve the validation error when the stream is already closed or locked.
  }
}

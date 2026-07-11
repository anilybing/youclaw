// @ts-nocheck
// [XJC-PATCH] Weixin CDN downloads use bounded, DNS-pinned safe transport.
import { decryptAesEcb } from "./aes-ecb.js";
import { buildCdnDownloadUrl } from "./cdn-url.js";
import { logger } from "../util/logger.js";
import { safeWeixinRemoteRequest } from "../security/remote-fetch.js";

const CDN_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
const CDN_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Download raw bytes from the CDN (no decryption).
 */
async function fetchCdnBytes(url: string, label: string): Promise<Buffer> {
  let res: Response;
  const signal = AbortSignal.timeout(CDN_DOWNLOAD_TIMEOUT_MS);
  try {
    res = await safeWeixinRemoteRequest(url, { signal });
  } catch (err) {
    const cause =
      (err as NodeJS.ErrnoException).cause ?? (err as NodeJS.ErrnoException).code ?? "(no cause)";
    logger.error(
      `${label}: fetch network error err=${String(err)} cause=${String(cause)}`,
    );
    throw err;
  }
  logger.debug(`${label}: response status=${res.status} ok=${res.ok}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    const msg = `${label}: CDN download ${res.status} ${res.statusText} body=${body}`;
    logger.error(msg);
    throw new Error(msg);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CDN_DOWNLOAD_MAX_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${label}: CDN download exceeds 100MB limit`);
  }
  return readCapped(res, signal, label);
}

async function readCapped(res: Response, signal: AbortSignal, label: string): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > CDN_DOWNLOAD_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label}: CDN download exceeds 100MB limit`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return Buffer.concat(chunks, total);
}

/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 *
 * Two encodings are seen in the wild:
 *   - base64(raw 16 bytes)          → images (aes_key from media field)
 *   - base64(hex string of 16 bytes) → file / voice / video
 *
 * In the second case, base64-decoding yields 32 ASCII hex chars which must
 * then be parsed as hex to recover the actual 16-byte key.
 */
function parseAesKey(aesKeyBase64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    // hex-encoded key: base64 → hex string → raw bytes
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  const msg = `${label}: aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`;
  logger.error(msg);
  throw new Error(msg);
}

/**
 * Download and AES-128-ECB decrypt a CDN media file. Returns plaintext Buffer.
 * aesKeyBase64: CDNMedia.aes_key JSON field (see parseAesKey for supported formats).
 */
export async function downloadAndDecryptBuffer(
  encryptedQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl: string,
  label: string,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64, label);
  const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  logger.debug(`${label}: fetching validated CDN media`);
  const encrypted = await fetchCdnBytes(url, label);
  logger.debug(`${label}: downloaded ${encrypted.byteLength} bytes, decrypting`);
  const decrypted = decryptAesEcb(encrypted, key);
  logger.debug(`${label}: decrypted ${decrypted.length} bytes`);
  return decrypted;
}

/**
 * Download plain (unencrypted) bytes from the CDN. Returns the raw Buffer.
 */
export async function downloadPlainCdnBuffer(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
  label: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  logger.debug(`${label}: fetching validated CDN media`);
  return fetchCdnBytes(url, label);
}

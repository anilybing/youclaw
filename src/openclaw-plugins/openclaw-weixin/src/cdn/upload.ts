// @ts-nocheck
// [XJC-PATCH] 微信远程媒体下载统一安全边界
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getUploadUrl } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { aesEcbPaddedSize } from "./aes-ecb.js";
import { uploadBufferToCdn } from "./cdn-upload.js";
import { logger } from "../util/logger.js";
import { getExtensionFromContentTypeOrUrl } from "../media/mime.js";
import { tempFileName } from "../util/random.js";
import { UploadMediaType } from "../api/types.js";

export type UploadedFileInfo = {
  filekey: string;
  /** 由 upload_param 上传后 CDN 返回的下载加密参数; fill into ImageItem.media.encrypt_query_param */
  downloadEncryptedQueryParam: string;
  /** AES-128-ECB key, hex-encoded; convert to base64 for CDNMedia.aes_key */
  aeskey: string;
  /** Plaintext file size in bytes */
  fileSize: number;
  /** Ciphertext file size in bytes (AES-128-ECB with PKCS7 padding); use for ImageItem.hd_size / mid_size */
  fileSizeCiphertext: number;
};

const REMOTE_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const REMOTE_MEDIA_TIMEOUT_MS = 30_000;

export type RemoteMediaDownloadOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
};

/**
 * Download a remote media URL (image, video, file) to a local temp file in destDir.
 * Returns the local file path; extension is inferred from Content-Type / URL.
 *
 * This plugin is also published as a standalone nested package, so it cannot import
 * the app-level `src/channel/media-fetch.ts`. Keep this minimal policy in lockstep:
 * public http(s) only, no redirects, bounded streaming reads, and an overall timeout.
 */
export async function downloadRemoteImageToTemp(
  url: string,
  destDir: string,
  options: RemoteMediaDownloadOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? REMOTE_MEDIA_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? REMOTE_MEDIA_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("remote media maxBytes must be positive");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("remote media timeoutMs must be positive");
  }

  const safeUrl = assertSafeRemoteMediaUrl(url);
  logger.debug(`downloadRemoteImageToTemp: fetching url=${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();

  try {
    let res: Response;
    try {
      res = await fetchFn(safeUrl.href, {
        redirect: "error",
        signal: controller.signal,
      });
    } catch (err) {
      const detail = controller.signal.aborted
        ? `timed out after ${timeoutMs}ms`
        : err instanceof Error ? err.message : String(err);
      const msg = `remote media download failed: ${detail} url=${url}`;
      logger.error(`downloadRemoteImageToTemp: ${msg}`);
      throw new Error(msg);
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      const msg = `remote media download failed: ${res.status} ${res.statusText} url=${url}`;
      logger.error(`downloadRemoteImageToTemp: ${msg}`);
      throw new Error(msg);
    }

    const declaredHeader = res.headers.get("content-length");
    const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`remote media exceeds ${formatMb(maxBytes)}MB limit url=${url}`);
    }

    const buf = await readRemoteMediaCapped(res, maxBytes, safeUrl.href, controller.signal);
    logger.debug(`downloadRemoteImageToTemp: downloaded ${buf.length} bytes`);
    await fs.mkdir(destDir, { recursive: true });
    const ext = getExtensionFromContentTypeOrUrl(res.headers.get("content-type"), safeUrl.href);
    const name = tempFileName("weixin-remote", ext);
    const filePath = path.join(destDir, name);
    await fs.writeFile(filePath, buf);
    logger.debug(`downloadRemoteImageToTemp: saved to ${filePath} ext=${ext}`);
    return filePath;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`remote media download timed out after ${timeoutMs}ms url=${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function assertSafeRemoteMediaUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`invalid remote media URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`remote media URL only supports http/https: ${rawUrl}`);
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) throw new Error(`remote media URL is missing a host: ${rawUrl}`);
  const ipv4 = parseIpv4(host);
  if (ipv4 && isBlockedIpv4(ipv4)) {
    throw new Error(`remote media URL points to a private/reserved address: ${rawUrl}`);
  }
  if (host.includes(":") && isBlockedIpv6(host)) {
    throw new Error(`remote media URL points to a private/reserved address: ${rawUrl}`);
  }
  if (!ipv4 && !host.includes(":") && isBlockedHostname(host)) {
    throw new Error(`remote media URL points to a local/private host: ${rawUrl}`);
  }
  return parsed;
}

async function readRemoteMediaCapped(
  res: Response,
  maxBytes: number,
  rawUrl: string,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`remote media exceeds ${formatMb(maxBytes)}MB limit url=${rawUrl}`);
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return Buffer.concat(chunks, total);
}

function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolveRead, rejectRead) => {
    const onAbort = () => rejectRead(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolveRead(result);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        rejectRead(err);
      },
    );
  });
}

function isBlockedHostname(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) return true;
  return [".local", ".localdomain", ".lan", ".home", ".home.arpa", ".internal"]
    .some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  if (octets.some((part) => part > 255)) return null;
  return octets as [number, number, number, number];
}

function isBlockedIpv4([a, b, c]: [number, number, number, number]): boolean {
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isBlockedIpv6(host: string): boolean {
  if (host === "::" || host === "::1") return true;
  const mapped = extractMappedIpv4(host);
  if (mapped && isBlockedIpv4(mapped)) return true;
  const firstGroup = host.split(":")[0] ?? "";
  const first = firstGroup === "" ? 0 : Number.parseInt(firstGroup, 16);
  return (first & 0xff00) === 0xff00
    || (first >= 0xfc00 && first <= 0xfdff)
    || (first >= 0xfe80 && first <= 0xfebf)
    || host === "2001:db8::"
    || host.startsWith("2001:db8:");
}

function extractMappedIpv4(host: string): [number, number, number, number] | null {
  const prefix = ["::ffff:0:", "64:ff9b::", "::ffff:"].find((candidate) => host.startsWith(candidate));
  if (!prefix) return null;
  const rest = host.slice(prefix.length);
  const dotted = parseIpv4(rest);
  if (dotted) return dotted;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/**
 * Common upload pipeline: read file → hash → gen aeskey → getUploadUrl → uploadBufferToCdn → return info.
 */
async function uploadMediaToCdn(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
  label: string;
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, opts, cdnBaseUrl, mediaType, label } = params;

  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  logger.debug(
    `${label}: file=${filePath} rawsize=${rawsize} filesize=${filesize} md5=${rawfilemd5} filekey=${filekey}`,
  );

  const uploadUrlResp = await getUploadUrl({
    ...opts,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadParam) {
    logger.error(
      `${label}: getUploadUrl returned no upload_param, resp=${JSON.stringify(uploadUrlResp)}`,
    );
    throw new Error(`${label}: getUploadUrl returned no upload_param`);
  }

  const { downloadParam: downloadEncryptedQueryParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadParam,
    filekey,
    cdnBaseUrl,
    aeskey,
    label: `${label}[orig filekey=${filekey}]`,
  });

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

/** Upload a local image file to the Weixin CDN with AES-128-ECB encryption. */
export async function uploadFileToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.IMAGE,
    label: "uploadFileToWeixin",
  });
}

/** Upload a local video file to the Weixin CDN. */
export async function uploadVideoToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.VIDEO,
    label: "uploadVideoToWeixin",
  });
}

/**
 * Upload a local file attachment (non-image, non-video) to the Weixin CDN.
 * Uses media_type=FILE; no thumbnail required.
 */
export async function uploadFileAttachmentToWeixin(params: {
  filePath: string;
  fileName: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.FILE,
    label: "uploadFileAttachmentToWeixin",
  });
}

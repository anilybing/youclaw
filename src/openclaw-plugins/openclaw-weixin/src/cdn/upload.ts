// @ts-nocheck
// [XJC-PATCH] 微信远程媒体下载统一安全边界
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getUploadUrl } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { assertSafeWeixinRemoteUrl, safeWeixinRemoteRequest } from "../security/remote-fetch.js";
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
  /** Test-only transport injection. Production leaves all three fields unset. */
  fetchFn?: typeof fetch;
  lookupFn?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  requestFn?: (
    url: URL,
    address: { address: string; family: 4 | 6 },
    signal: AbortSignal,
  ) => Promise<Response>;
};

/**
 * Download a remote media URL (image, video, file) to a local temp file in destDir.
 * Returns the local file path; extension is inferred from Content-Type / URL.
 *
 * This plugin is also published as a standalone nested package, so it cannot import
 * the app-level `src/channel/media-fetch.ts`. Keep this minimal policy in lockstep:
 * public http(s) only, full A/AAAA validation, verified-IP pinning, per-hop redirect
 * validation, bounded streaming reads, and an overall timeout.
 */
export async function downloadRemoteImageToTemp(
  url: string,
  destDir: string,
  options: RemoteMediaDownloadOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? REMOTE_MEDIA_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? REMOTE_MEDIA_TIMEOUT_MS;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("remote media maxBytes must be positive");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("remote media timeoutMs must be positive");
  }

  const safeUrl = assertSafeWeixinRemoteUrl(url);
  logger.debug("downloadRemoteImageToTemp: fetching validated remote media");
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();

  try {
    let res: Response;
    try {
      res = await safeWeixinRemoteRequest(safeUrl.href, {
        signal: controller.signal,
        fetchFn: options.fetchFn,
        lookupFn: options.lookupFn,
        requestFn: options.requestFn,
      });
    } catch (err) {
      const detail = controller.signal.aborted
        ? `timed out after ${timeoutMs}ms`
        : err instanceof Error ? err.message : String(err);
      const msg = `remote media download failed: ${detail}`;
      logger.error(`downloadRemoteImageToTemp: ${msg}`);
      throw new Error(msg);
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      const msg = `remote media download failed: ${res.status} ${res.statusText}`;
      logger.error(`downloadRemoteImageToTemp: ${msg}`);
      throw new Error(msg);
    }

    const declaredHeader = res.headers.get("content-length");
    const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`remote media exceeds ${formatMb(maxBytes)}MB limit`);
    }

    const buf = await readRemoteMediaCapped(res, maxBytes, controller.signal);
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
      throw new Error(`remote media download timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readRemoteMediaCapped(
  res: Response,
  maxBytes: number,
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
        throw new Error(`remote media exceeds ${formatMb(maxBytes)}MB limit`);
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

  // [XJC-PATCH] 本地媒体上传前先按文件大小设上限(与其它渠道 50MB 对齐),避免超大文件
  // 整包 readFile 进内存造成膨胀;超限直接抛中文错误而非读完再被 CDN 拒。
  const MAX_WEIXIN_MEDIA_BYTES = 50 * 1024 * 1024;
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_WEIXIN_MEDIA_BYTES) {
    throw new Error(`媒体文件过大(${(stat.size / 1024 / 1024).toFixed(1)}MB),超过 50MB 上限`);
  }

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

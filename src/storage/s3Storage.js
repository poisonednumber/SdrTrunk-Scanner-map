'use strict';

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createLogger } = require('../logger');

/**
 * S3-compatible storage backend.
 *
 * Works with:
 *   - Amazon S3        (region set, no custom endpoint)
 *   - Cloudflare R2    (endpoint https://<acct>.r2.cloudflarestorage.com, region "auto")
 *   - Backblaze B2     (endpoint https://s3.<region>.backblazeb2.com)
 *   - MinIO            (custom endpoint, forcePathStyle=true)
 */
class S3Storage {
  constructor(opts = {}) {
    this.type = opts.type || 's3';
    this.bucket = opts.bucket;
    this.publicBaseUrl = opts.publicBaseUrl || null;
    if (!this.bucket) throw new Error(`${this.type}: S3_BUCKET_NAME is required`);

    const log = createLogger(`storage:${this.type}`);
    this.log = log;

    const clientConfig = {
      region: opts.region || 'auto',
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
      forcePathStyle: !!opts.forcePathStyle,
    };
    if (opts.endpoint) clientConfig.endpoint = opts.endpoint;

    this.client = new S3Client(clientConfig);
  }

  async save(key, buffer, contentType = 'audio/mpeg') {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );
    this.log.debug(`uploaded ${key} (${buffer.length} bytes)`);
    return { key, url: this.publicUrl(key) };
  }

  async exists(key) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async getBuffer(key) {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  /** Returns a Node Readable stream for the object. */
  async getReadStream(key) {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    return res.Body; // already a Node Readable in the v3 SDK on Node runtimes
  }

  async delete(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Either a configured public URL, or a short-lived presigned URL. */
  publicUrl(key) {
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    }
    return null;
  }

  async signedUrl(key, expiresInSeconds = 3600) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds }
    );
  }

  async testConnection() {
    const probe = `.healthcheck-${Date.now()}.txt`;
    await this.save(probe, Buffer.from('ok'), 'text/plain');
    await this.delete(probe);
    return { ok: true, type: this.type, bucket: this.bucket };
  }
}

module.exports = S3Storage;

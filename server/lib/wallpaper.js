'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const sharp = require('sharp');
const { DATA_DIR } = require('./paths');

const BING_ORIGIN = 'https://www.bing.com';
const ARCHIVE_URL = BING_ORIGIN + '/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN';
const ASSET_NAME = /^[a-f0-9]{64}\.jpg$/;
const LOCAL_IMAGE = /\.(jpe?g|png|gif|webp|bmp)$/i;

function archiveImages(value) {
  if (!Array.isArray(value)) return [];
  const images = [];
  for (const item of value.slice(0, 8)) {
    try {
      if (typeof item?.url !== 'string') continue;
      const url = new URL(item.url, BING_ORIGIN);
      if (url.origin !== BING_ORIGIN || url.username || url.password || url.pathname !== '/th' || url.hash ||
          !/^OHR\.[A-Za-z0-9_.-]+$/.test(url.searchParams.get('id') || '')) continue;
      if (images.some(image => image.url === url.href)) continue;
      images.push({ url: url.href, copyright: typeof item.copyright === 'string' ? item.copyright.slice(0, 500) : '' });
    } catch {}
  }
  return images;
}
const fileFor = image => crypto.createHash('sha256').update(image.url).digest('hex') + '.jpg';

function createWallpaperService({
  localDir = path.resolve(__dirname, '../../rele'), cacheDir = path.join(DATA_DIR, 'wallpaper-cache'),
  fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 5000, retryMs = 5 * 60 * 1000,
  metadataTtlMs = 60 * 60 * 1000, maxImageBytes = 8 * 1024 * 1024,
} = {}) {
  cacheDir = path.resolve(cacheDir);
  localDir = path.resolve(localDir);
  const metadataPath = path.join(cacheDir, 'metadata.json');
  let initialized, initializeRetryAt = 0, metadata = null, metadataPending = null, metadataRetryAt = 0;
  let localFiles = [], localReadAt = -Infinity, localPending = null;
  let pruneQueue = Promise.resolve();
  const downloads = new Map(), imageRetryAt = new Map();

  async function initialize() {
    if (now() < initializeRetryAt) throw new Error('Wallpaper cache initialization is cooling down');
    if (!initialized) initialized = (async () => {
      await fs.mkdir(cacheDir, { recursive: true });
      try {
        const stat = await fs.stat(metadataPath);
        if (stat.size > 65536) return;
        const saved = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        const images = archiveImages(saved.images);
        if (images.length && Number.isFinite(saved.fetchedAt) && saved.fetchedAt <= now()) metadata = { images, fetchedAt: saved.fetchedAt };
      } catch {}
    })().catch(error => {
      // A transient filesystem failure must not permanently cache a rejected promise.
      initialized = null;
      initializeRetryAt = now() + retryMs;
      throw error;
    });
    return initialized;
  }

  // The deadline covers response headers AND the bounded body, including both archive and image.
  async function fetchBytes(url, maxBytes, contentType, deadline) {
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Wallpaper upstream timed out')); }, Math.max(1, deadline - Date.now()));
    });
    try {
      return await Promise.race([(async () => {
        const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { Accept: contentType } });
        if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== contentType) throw new Error('Invalid wallpaper response');
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > maxBytes) throw new Error('Wallpaper response is too large');
        if (!response.body) throw new Error('Empty wallpaper response');
        const chunks = [], reader = response.body.getReader();
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw new Error('Wallpaper response is too large');
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        return Buffer.concat(chunks, size);
      })(), expired]);
    } catch (error) { controller.abort(); throw error; }
    finally { clearTimeout(timer); }
  }

  async function getMetadata(deadline) {
    await initialize();
    if (metadata && now() - metadata.fetchedAt < metadataTtlMs) return metadata;
    if (now() < metadataRetryAt) return metadata;
    if (!metadataPending) metadataPending = (async () => {
      try {
        const bytes = await fetchBytes(ARCHIVE_URL, 65536, 'application/json', deadline);
        const images = archiveImages(JSON.parse(bytes.toString('utf8')).images);
        if (!images.length) throw new Error('Empty Bing archive');
        metadata = { images, fetchedAt: now() };
        metadataRetryAt = 0;
        const temporary = metadataPath + '.' + crypto.randomUUID() + '.tmp';
        try { await fs.writeFile(temporary, JSON.stringify(metadata)); await fs.rename(temporary, metadataPath); }
        catch { await fs.rm(temporary, { force: true }).catch(() => {}); }
      } catch { metadataRetryAt = now() + retryMs; }
      finally { metadataPending = null; }
      return metadata;
    })();
    return metadataPending;
  }

  async function pruneCache() {
    const names = (await fs.readdir(cacheDir)).filter(name => ASSET_NAME.test(name));
    const protectedNames = new Set(metadata?.images.map(fileFor) || []);
    for (const name of downloads.keys()) protectedNames.add(name);
    const entries = await Promise.all(names.map(async name => ({ name, time: (await fs.stat(path.join(cacheDir, name))).mtimeMs })));
    entries.sort((a, b) => b.time - a.time);
    const keep = new Set(protectedNames);
    for (const entry of entries) if (keep.size < 16) keep.add(entry.name);
    // Only generated, validated JPEG names inside this dedicated cache directory are eligible.
    await Promise.all(entries.filter(entry => !keep.has(entry.name)).map(entry => fs.rm(path.join(cacheDir, entry.name), { force: true })));
  }

  async function ensureImage(image, deadline) {
    const file = fileFor(image), destination = path.join(cacheDir, file);
    if (downloads.has(file)) return downloads.get(file);
    const pending = (async () => {
      try {
        const stat = await fs.stat(destination);
        if (stat.isFile() && stat.size > 0 && stat.size <= maxImageBytes) return file;
      } catch {}
      if (now() < (imageRetryAt.get(file) || 0)) throw new Error('Wallpaper download is cooling down');
      const temporary = destination + '.' + crypto.randomUUID() + '.tmp';
      try {
        const bytes = await fetchBytes(image.url, maxImageBytes, 'image/jpeg', deadline);
        const info = await sharp(bytes, { limitInputPixels: 40 * 1000 * 1000 }).metadata();
        if (info.format !== 'jpeg' || !info.width || !info.height) throw new Error('Invalid wallpaper image');
        await fs.writeFile(temporary, bytes);
        await fs.rename(temporary, destination);
        imageRetryAt.delete(file);
        pruneQueue = pruneQueue.then(pruneCache).catch(() => {});
        await pruneQueue;
        return file;
      } catch (error) {
        imageRetryAt.set(file, now() + retryMs);
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    })();
    downloads.set(file, pending);
    try { return await pending; }
    finally { downloads.delete(file); }
  }

  async function selectLocal(idx, fallback) {
    if (now() - localReadAt >= 60000) {
      if (!localPending) localPending = (async () => {
        try {
          localFiles = (await fs.readdir(localDir, { withFileTypes: true }))
            .filter(entry => entry.isFile() && !entry.name.startsWith('.') && !/[\\\u0000-\u001f]/.test(entry.name) && LOCAL_IMAGE.test(entry.name))
            .map(entry => entry.name).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
        } catch { localFiles = []; }
        localReadAt = now(); localPending = null;
      })();
      await localPending;
    }
    if (!localFiles.length) return { file: null, url: null, total: 0, idx: 0, source: 'local', fallback };
    const selected = idx === null ? Math.floor(Math.random() * localFiles.length) : idx % localFiles.length;
    const file = localFiles[selected];
    return { file, url: '/rele/' + encodeURIComponent(file), total: localFiles.length, idx: selected, source: 'local', fallback };
  }

  async function select(query = {}) {
    const source = query.source === undefined ? 'bing' : query.source;
    const rawIdx = query.idx;
    const maxIdx = source === 'local' ? 1000000 : 7;
    const numericIdx = typeof rawIdx === 'number' || (typeof rawIdx === 'string' && /^[0-9]{1,7}$/.test(rawIdx)) ? Number(rawIdx) : NaN;
    if (!['bing', 'local'].includes(source) || (rawIdx !== undefined &&
        !(Number.isSafeInteger(numericIdx) && numericIdx >= 0 && numericIdx <= maxIdx))) {
      throw Object.assign(new Error('壁纸来源或序号无效'), { status: 400 });
    }
    const idx = rawIdx === undefined ? null : numericIdx;
    if (source === 'local') return selectLocal(idx, false);
    try {
      const deadline = Date.now() + timeoutMs;
      const archive = await getMetadata(deadline);
      if (archive?.images.length) {
        const selected = (idx || 0) % archive.images.length;
        const image = archive.images[selected];
        const file = await ensureImage(image, deadline);
        return { file, url: '/api/wallpaper/image/' + file, total: archive.images.length, idx: selected, source: 'bing', fallback: false, copyright: image.copyright };
      }
    } catch {}
    return selectLocal(idx, true);
  }

  return { select, localDir, imagePath: file => typeof file === 'string' && ASSET_NAME.test(file) ? path.join(cacheDir, file) : null };
}

function createWallpaperRouter(options) {
  const service = createWallpaperService(options), router = express.Router();
  router.use('/rele', express.static(service.localDir, { maxAge: '1d', etag: true, lastModified: true, index: false }));
  router.get('/api/wallpaper/image/:file', (req, res, next) => {
    const imagePath = service.imagePath(req.params.file);
    if (!imagePath) return res.status(404).json({ error: '壁纸不存在' });
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(imagePath, error => {
      if (!error) return;
      if (res.headersSent) return next(error);
      res.setHeader('Cache-Control', 'no-store');
      res.status(error.status === 404 ? 404 : 500).json({ error: '壁纸暂时不可用' });
    });
  });
  router.get('/api/wallpaper', async (req, res, next) => {
    try { res.setHeader('Cache-Control', 'no-store'); res.json(await service.select(req.query)); }
    catch (error) { if (error.status === 400) return res.status(400).json({ error: error.message }); next(error); }
  });
  return router;
}

module.exports = { createWallpaperService, createWallpaperRouter };

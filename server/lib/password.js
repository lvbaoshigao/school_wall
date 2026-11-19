const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// 原生异步 scrypt 不阻塞事件循环；仅接受有界字符串，避免 JSON 类型强转为共享口令。
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_LEN = 16;
const MAXMEM = 64 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 1024;
const SCRYPT_PREFIX = 'scrypt$';

function isPasswordInput(plain) {
  return typeof plain === 'string' && plain.length > 0 &&
    Buffer.byteLength(plain, 'utf8') <= MAX_PASSWORD_BYTES;
}

function scryptAsync(password, salt, options = { N, r: R, p: P }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { ...options, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// 格式：scrypt$N$r$p$saltBase64$keyBase64。拒绝非字符串，绝不隐式 String(object)。
async function hashPassword(plain) {
  if (!isPasswordInput(plain)) throw new TypeError('密码必须是1至1024字节的字符串');
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scryptAsync(plain, salt);
  return `${SCRYPT_PREFIX}${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function isBcryptHash(stored) {
  return typeof stored === 'string' && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(stored);
}

async function verifyPassword(plain, stored) {
  const invalid = { ok: false, needsUpgrade: false };
  if (!isPasswordInput(plain) || typeof stored !== 'string') return invalid;

  if (isBcryptHash(stored)) {
    // 不让损坏/被篡改的 cost 触发数小时 CPU 计算。现有账户默认 cost 为 10。
    const cost = Number(stored.slice(4, 6));
    if (cost < 4 || cost > 14) return invalid;
    const ok = await bcrypt.compare(plain, stored);
    // bcrypt 只比较前72字节；长口令自动迁移会把一次任意后缀永久变成新口令。
    return { ok, needsUpgrade: ok && Buffer.byteLength(plain, 'utf8') <= 72 };
  }

  if (!stored.startsWith(SCRYPT_PREFIX)) return invalid;
  const parts = stored.slice(SCRYPT_PREFIX.length).split('$');
  if (parts.length !== 5) return invalid;
  const [nStr, rStr, pStr, saltB64, keyB64] = parts;
  if (![nStr, rStr, pStr].every(v => /^[1-9]\d{0,5}$/.test(v))) return invalid;
  const n = Number(nStr), r = Number(rStr), p = Number(pStr);
  // 有界 KDF 参数：既兼容较低参数的旧哈希，也拒绝超大/非整数字段和异常输出长度。
  if (n < 2 || n > 32768 || (n & (n - 1)) !== 0 || r > 8 || p > 4 ||
      n * r * p > N * R * P * 4) return invalid;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  if (salt.length !== SALT_LEN || expected.length !== KEYLEN ||
      salt.toString('base64') !== saltB64 || expected.toString('base64') !== keyB64) return invalid;

  let actual;
  try { actual = await scryptAsync(plain, salt, { N: n, r, p }); }
  catch { return invalid; }
  const ok = crypto.timingSafeEqual(actual, expected);
  return { ok, needsUpgrade: ok && (n !== N || r !== R || p !== P) };
}

module.exports = { hashPassword, verifyPassword, isBcryptHash, isPasswordInput, MAX_PASSWORD_BYTES };

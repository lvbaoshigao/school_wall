const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// 口令哈希。
//
// 为什么不继续用 bcryptjs：
//   它是纯 JS 实现，hashSync 实测 119ms，全程阻塞事件循环 —— 登录接口限流
//   20 次/分钟/IP，意味着每个 IP 每分钟能独占 2.4 秒 CPU，几十个 IP 就能让服务永久卡死。
//   而它的「异步」版本按约 100ms 分块，对一次 120ms 的哈希只让出一次事件循环，
//   实测下来几乎没有改善（12 次心跳只走了 1 次）。
//
// 改用 crypto.scrypt：原生实现，异步版本在 libuv 线程池上执行，主线程完全不参与，
//   实测同样时长内事件循环走满 11/12 次心跳，且 4 个并发能真并行（111ms 而非 240ms）。
//   scrypt 是内存硬 KDF，抗 GPU 破解强于 bcrypt。
//
// 并发上限由 libuv 线程池（默认 4）天然约束，单次约 16MB 内存，
// 最坏情况占用 64MB，不会被并发登录打爆内存。
const N = 16384;   // CPU/内存开销参数，实测约 60ms/次
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_LEN = 16;
const MAXMEM = 64 * 1024 * 1024;   // 需 ≥ 128*N*r = 16MB，留足余量

const SCRYPT_PREFIX = 'scrypt$';

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// 生成新哈希，格式：scrypt$N$r$p$saltBase64$keyBase64
async function hashPassword(plain) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scryptAsync(String(plain), salt);
  return `${SCRYPT_PREFIX}${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function isBcryptHash(stored) {
  return typeof stored === 'string' && /^\$2[aby]?\$/.test(stored);
}

// 校验口令。
// 返回 { ok, needsUpgrade } —— needsUpgrade 为真时说明这条还是旧的 bcrypt 哈希，
// 调用方应在登录成功后顺手重新哈希写回，实现无感迁移（用户不需要改密码）。
async function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return { ok: false, needsUpgrade: false };

  if (isBcryptHash(stored)) {
    // 旧数据仍走 bcryptjs，但只在存量用户首次登录时发生一次，之后就升级掉了
    const ok = await bcrypt.compare(String(plain), stored);
    return { ok, needsUpgrade: ok };
  }

  if (!stored.startsWith(SCRYPT_PREFIX)) return { ok: false, needsUpgrade: false };

  const parts = stored.slice(SCRYPT_PREFIX.length).split('$');
  if (parts.length !== 5) return { ok: false, needsUpgrade: false };

  const [nStr, rStr, pStr, saltB64, keyB64] = parts;
  const n = parseInt(nStr, 10), r = parseInt(rStr, 10), p = parseInt(pStr, 10);
  if (!n || !r || !p) return { ok: false, needsUpgrade: false };

  let salt, expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(keyB64, 'base64');
  } catch { return { ok: false, needsUpgrade: false }; }
  if (!salt.length || !expected.length) return { ok: false, needsUpgrade: false };

  let actual;
  try {
    // 用存储时的参数校验，这样以后调高 N 也不会让老哈希失效
    actual = await new Promise((resolve, reject) => {
      crypto.scrypt(String(plain), salt, expected.length, { N: n, r, p, maxmem: MAXMEM },
        (err, key) => (err ? reject(err) : resolve(key)));
    });
  } catch { return { ok: false, needsUpgrade: false }; }

  const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  // 参数被调高后，老哈希在下次登录时升级到新参数
  return { ok, needsUpgrade: ok && (n !== N || r !== R || p !== P) };
}

module.exports = { hashPassword, verifyPassword, isBcryptHash };

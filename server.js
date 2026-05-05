const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "links.json");
const REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const REDIS_KEY = process.env.SHORT_STUDIO_REDIS_KEY || "short-studio:db";
const BODY_LIMIT = 1024 * 1024;
const SLUG_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const RESERVED_SLUGS = new Set([
  "api",
  "assets",
  "favicon.ico",
  "health",
  "index.html",
  "robots.txt",
  "shorten",
  "stats",
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

const writeQueue = { current: Promise.resolve() };
const rateBuckets = new Map();

function seedDb() {
  const now = new Date().toISOString();
  return {
    links: [
      {
        id: "seed-apple",
        slug: "apple",
        url: "https://www.apple.com/",
        title: "Apple",
        note: "Seed link for checking redirects and analytics.",
        color: "blue",
        createdAt: now,
        updatedAt: now,
        expiresAt: null,
        clicks: 0,
        lastClickAt: null,
        archived: false,
      },
    ],
    events: [],
  };
}

function hasRedisStorage() {
  return Boolean(REDIS_REST_URL && REDIS_REST_TOKEN);
}

function useFileStorage() {
  return !hasRedisStorage() && process.env.SHORT_STUDIO_STORAGE !== "memory" && !process.env.VERCEL;
}

function memoryStore() {
  if (!globalThis.__SHORT_STUDIO_DB__) {
    globalThis.__SHORT_STUDIO_DB__ = seedDb();
  }
  return globalThis.__SHORT_STUDIO_DB__;
}

async function redisCommand(command) {
  const response = await fetch(REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Redis command failed with HTTP ${response.status}`);
  }
  return payload.result;
}

async function ensureDb() {
  if (hasRedisStorage()) {
    const existing = await redisCommand(["GET", REDIS_KEY]);
    if (!existing) await writeDb(seedDb());
    return;
  }

  if (!useFileStorage()) {
    memoryStore();
    return;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_PATH);
  } catch {
    await writeDb(seedDb());
  }
}

async function readDb() {
  await ensureDb();

  if (hasRedisStorage()) {
    const raw = await redisCommand(["GET", REDIS_KEY]);
    if (!raw) return seedDb();
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }

  if (!useFileStorage()) {
    return memoryStore();
  }

  const raw = await fs.readFile(DB_PATH, "utf8");
  return JSON.parse(raw);
}

async function writeDb(db) {
  if (hasRedisStorage()) {
    await redisCommand(["SET", REDIS_KEY, JSON.stringify(db)]);
    return;
  }

  if (!useFileStorage()) {
    globalThis.__SHORT_STUDIO_DB__ = db;
    return;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(db, null, 2);
  writeQueue.current = writeQueue.current.then(() => fs.writeFile(DB_PATH, payload));
  return writeQueue.current;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, message) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(message),
  });
  res.end(message);
}

function notFound(res) {
  sendText(res, 404, "Not found");
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON body"), { status: 400 }));
      }
    });

    req.on("error", reject);
  });
}

function validateDestination(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error("Enter a destination URL."), { status: 400 });
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw Object.assign(new Error("Enter a valid URL including http:// or https://."), {
      status: 400,
    });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw Object.assign(new Error("Only http and https links are supported."), {
      status: 400,
    });
  }

  parsed.hash = parsed.hash;
  return parsed.toString();
}

function normalizeAlias(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw Object.assign(new Error("Custom alias must be text."), { status: 400 });
  }

  const alias = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,39}$/.test(alias)) {
    throw Object.assign(
      new Error("Use 3-40 letters, numbers, underscores, or dashes for the alias."),
      { status: 400 }
    );
  }

  if (RESERVED_SLUGS.has(alias.toLowerCase())) {
    throw Object.assign(new Error("That alias is reserved."), { status: 409 });
  }

  return alias;
}

function normalizeTitle(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().slice(0, 80);
}

function normalizeNote(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 180);
}

function normalizeExpiry(value) {
  if (!value) return null;
  const expiry = new Date(value);
  if (Number.isNaN(expiry.getTime())) {
    throw Object.assign(new Error("Expiration date is invalid."), { status: 400 });
  }
  return expiry.toISOString();
}

function randomSlug(length = 6) {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (byte) => SLUG_ALPHABET[byte % SLUG_ALPHABET.length]).join("");
}

function linkToClient(link, origin) {
  return {
    ...link,
    shortUrl: `${origin}/${link.slug}`,
    isExpired: Boolean(link.expiresAt && new Date(link.expiresAt) < new Date()),
  };
}

function summarize(db, origin) {
  const links = db.links
    .filter((link) => !link.archived)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((link) => linkToClient(link, origin));
  const clicks = links.reduce((sum, link) => sum + Number(link.clicks || 0), 0);
  const active = links.filter((link) => !link.isExpired).length;
  const lastEvent = db.events.slice(-1)[0] || null;

  return {
    links,
    metrics: {
      totalLinks: links.length,
      activeLinks: active,
      totalClicks: clicks,
      lastClickAt: lastEvent ? lastEvent.at : null,
    },
    events: db.events
      .slice(-24)
      .reverse()
      .map((event) => ({
        ...event,
        shortUrl: `${origin}/${event.slug}`,
      })),
  };
}

function hitRateLimit(req) {
  const ip = req.socket.remoteAddress || "local";
  const now = Date.now();
  const windowMs = 60_000;
  const bucket = rateBuckets.get(ip) || { resetAt: now + windowMs, count: 0 };

  if (bucket.resetAt < now) {
    bucket.resetAt = now + windowMs;
    bucket.count = 0;
  }

  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  return bucket.count > 80;
}

async function serveStatic(req, res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, cleanPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    notFound(res);
    return true;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
      "Content-Length": body.length,
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

async function createLink(req, res) {
  if (hitRateLimit(req)) {
    sendJson(res, 429, { error: "Too many requests. Wait a minute and try again." });
    return;
  }

  const payload = await parseBody(req);
  const destination = validateDestination(payload.url);
  const db = await readDb();
  const origin = baseUrl(req);
  const alias = normalizeAlias(payload.alias);
  let slug = alias;

  if (slug && db.links.some((link) => link.slug.toLowerCase() === slug.toLowerCase())) {
    sendJson(res, 409, { error: "That short link is already taken." });
    return;
  }

  while (!slug) {
    const candidate = randomSlug();
    if (!db.links.some((link) => link.slug === candidate) && !RESERVED_SLUGS.has(candidate)) {
      slug = candidate;
    }
  }

  const now = new Date().toISOString();
  const host = new URL(destination).hostname.replace(/^www\./, "");
  const link = {
    id: crypto.randomUUID(),
    slug,
    url: destination,
    title: normalizeTitle(payload.title, host),
    note: normalizeNote(payload.note),
    color: typeof payload.color === "string" ? payload.color.slice(0, 24) : "blue",
    createdAt: now,
    updatedAt: now,
    expiresAt: normalizeExpiry(payload.expiresAt),
    clicks: 0,
    lastClickAt: null,
    archived: false,
  };

  db.links.push(link);
  await writeDb(db);
  sendJson(res, 201, { link: linkToClient(link, origin), ...summarize(db, origin).metrics });
}

async function deleteLink(req, res, slug) {
  const db = await readDb();
  const link = db.links.find((item) => item.slug === slug && !item.archived);
  if (!link) {
    sendJson(res, 404, { error: "Short link not found." });
    return;
  }

  link.archived = true;
  link.updatedAt = new Date().toISOString();
  await writeDb(db);
  sendJson(res, 200, summarize(db, baseUrl(req)));
}

async function getStats(req, res, slug) {
  const db = await readDb();
  const link = db.links.find((item) => item.slug === slug && !item.archived);
  if (!link) {
    sendJson(res, 404, { error: "Short link not found." });
    return;
  }

  const origin = baseUrl(req);
  const events = db.events
    .filter((event) => event.slug === slug)
    .slice(-50)
    .reverse();

  sendJson(res, 200, { link: linkToClient(link, origin), events });
}

async function redirect(req, res, slug, options = {}) {
  const trackClick = options.trackClick !== false;
  const db = await readDb();
  const link = db.links.find((item) => item.slug === slug && !item.archived);

  if (!link) {
    await serveStatic(req, res, "/404.html") || notFound(res);
    return;
  }

  if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
    res.writeHead(410, { "Content-Type": "text/html; charset=utf-8" });
    res.end(trackClick ? `<!doctype html><title>Expired</title><h1>This short link has expired.</h1>` : "");
    return;
  }

  if (!trackClick) {
    res.writeHead(302, {
      Location: link.url,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  const now = new Date().toISOString();
  link.clicks = Number(link.clicks || 0) + 1;
  link.lastClickAt = now;
  link.updatedAt = now;
  db.events.push({
    id: crypto.randomUUID(),
    slug,
    at: now,
    referrer: req.headers.referer || "Direct",
    userAgent: req.headers["user-agent"] || "Unknown",
  });
  db.events = db.events.slice(-500);
  await writeDb(db);

  res.writeHead(302, {
    Location: link.url,
    "Cache-Control": "no-store",
  });
  res.end();
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/links") {
    const db = await readDb();
    sendJson(res, 200, summarize(db, baseUrl(req)));
    return true;
  }

  if (req.method === "POST" && pathname === "/api/shorten") {
    await createLink(req, res);
    return true;
  }

  const deleteMatch = pathname.match(/^\/api\/links\/([a-zA-Z0-9_-]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    await deleteLink(req, res, deleteMatch[1]);
    return true;
  }

  const statsMatch = pathname.match(/^\/api\/stats\/([a-zA-Z0-9_-]+)$/);
  if (req.method === "GET" && statsMatch) {
    await getStats(req, res, statsMatch[1]);
    return true;
  }

  return false;
}

async function handle(req, res) {
  try {
    const parsed = new URL(req.url, baseUrl(req));
    const pathname = decodeURIComponent(parsed.pathname);

    if (pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith("/api/")) {
      if (!(await handleApi(req, res, pathname))) notFound(res);
      return;
    }

    if (req.method === "GET" && (await serveStatic(req, res, pathname))) return;

    const slugMatch = pathname.match(/^\/([a-zA-Z0-9_-]+)$/);
    if ((req.method === "GET" || req.method === "HEAD") && slugMatch) {
      await redirect(req, res, slugMatch[1], { trackClick: req.method === "GET" });
      return;
    }

    notFound(res);
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, { error: error.message || "Unexpected server error" });
  }
}

if (require.main === module) {
  ensureDb()
    .then(() => {
      http.createServer(handle).listen(PORT, () => {
        console.log(`Apple URL shortener running at http://localhost:${PORT}`);
      });
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = handle;

const { createHmac, randomBytes, randomInt, timingSafeEqual } = require("crypto");

const BIN_ID = process.env.JSONBIN_BIN_ID;
const MASTER_KEY = process.env.JSONBIN_MASTER_KEY;
const COOKIE_NAME = "passdrop_client";
const MAX_FAILS = 5;
const COOLDOWN_MS = 60 * 60 * 1000;
const MAX_CAPACITY = 1000000;

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function queryValue(req, key) {
  const value = req.query && req.query[key];
  return Array.isArray(value) ? value[0] : value;
}

function requestBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return {};
}

function safeRewardUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return null;
    return url.toString();
  } catch (_) {
    return null;
  }
}

function readCookie(header) {
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index >= 0 && part.slice(0, index).trim() === COOKIE_NAME) {
      return part.slice(index + 1).trim();
    }
  }
  return "";
}

function signClientId(id) {
  return createHmac("sha256", MASTER_KEY).update(`passdrop-client:${id}`).digest("base64url");
}

function clientIdFor(req, res) {
  const token = readCookie(req.headers.cookie);
  const separator = token.lastIndexOf(".");
  if (separator > 0) {
    const id = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expected = Buffer.from(signClientId(id));
    const supplied = Buffer.from(signature);
    if (/^[a-f0-9]{32}$/.test(id) && supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
      return id;
    }
  }

  const id = randomBytes(16).toString("hex");
  const tokenValue = `${id}.${signClientId(id)}`;
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${tokenValue}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
  return id;
}

async function readDatabase() {
  const response = await fetch(`https://api.jsonbin.io/v3/b/${encodeURIComponent(BIN_ID)}/latest`, {
    headers: { "X-Master-Key": MASTER_KEY },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Could not read giveaway storage");
  const json = await response.json();
  if (!json.record || typeof json.record !== "object" || Array.isArray(json.record)) {
    throw new Error("Giveaway storage has an invalid format");
  }
  if (!json.record.giveaways || typeof json.record.giveaways !== "object" || Array.isArray(json.record.giveaways)) {
    json.record.giveaways = {};
  }
  return json.record;
}

async function writeDatabase(database) {
  const response = await fetch(`https://api.jsonbin.io/v3/b/${encodeURIComponent(BIN_ID)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Master-Key": MASTER_KEY },
    body: JSON.stringify(database),
  });
  if (!response.ok) throw new Error("Could not save giveaway storage");
}

function findAdmin(database, adminId) {
  for (const [id, giveaway] of Object.entries(database.giveaways)) {
    if (giveaway.adminId === adminId) return [id, giveaway];
  }
  return null;
}

function publicGiveaway(giveaway, cooldownUntil = 0) {
  return { name: giveaway.name, expiresAt: giveaway.expiresAt, cooldownUntil };
}

function adminDetails(id, giveaway) {
  return {
    id,
    name: giveaway.name || "",
    attempts: giveaway.attempts || 0,
    winners: giveaway.winners || 0,
    capacity: giveaway.capacity || 0,
    expiresAt: giveaway.expiresAt,
    url: giveaway.url || "",
  };
}

async function handleGet(req, res) {
  const giveawayId = queryValue(req, "g");
  const adminId = queryValue(req, "a");
  const database = await readDatabase();

  if (giveawayId) {
    const giveaway = database.giveaways[giveawayId];
    if (!giveaway) return send(res, 404, { error: "Giveaway not found." });
    const expiry = Date.parse(giveaway.expiresAt);
    if (!Number.isFinite(expiry) || Date.now() >= expiry) {
      return send(res, 410, { error: "This giveaway has expired." });
    }
    const clientId = clientIdFor(req, res);
    const entry = giveaway.cd && giveaway.cd[clientId];
    const cooldownUntil = entry && Number(entry.until) > Date.now() ? Number(entry.until) : 0;
    return send(res, 200, publicGiveaway(giveaway, cooldownUntil));
  }

  if (adminId) {
    const found = findAdmin(database, adminId);
    if (!found) return send(res, 404, { error: "Admin link not found." });
    return send(res, 200, adminDetails(found[0], found[1]));
  }
  return send(res, 400, { error: "A giveaway or admin link is required." });
}

async function handleCreate(body, res) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const url = safeRewardUrl(body.url);
  const password = typeof body.password === "string" ? body.password.trim() : "";
  const capacity = Number(body.capacity);
  const probability = Number(body.probability);
  const expiresInDays = Number(body.expiresInDays);

  if (!name || name.length > 60) return send(res, 400, { error: "Enter a giveaway name (up to 60 characters)." });
  if (!url) return send(res, 400, { error: "Enter a valid HTTP or HTTPS reward URL." });
  if (password.length < 3 || password.length > 8) return send(res, 400, { error: "Password must be 3–8 characters after trimming spaces." });
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    return send(res, 400, { error: `Winner capacity must be between 1 and ${MAX_CAPACITY}.` });
  }
  if (![10, 25, 50, 75, 100].includes(probability)) return send(res, 400, { error: "Choose a valid win probability." });
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 10) {
    return send(res, 400, { error: "Choose an expiration period from 1 to 10 days." });
  }

  const database = await readDatabase();
  const now = Date.now();
  for (const [id, existing] of Object.entries(database.giveaways)) {
    const expiry = Date.parse(existing.expiresAt);
    if (Number.isFinite(expiry) && now > expiry + 30 * 86400000) delete database.giveaways[id];
  }

  let id;
  do { id = randomBytes(12).toString("hex"); } while (database.giveaways[id]);
  const adminId = randomBytes(32).toString("hex");
  database.giveaways[id] = {
    name,
    url,
    password,
    capacity,
    probability,
    durationDays: expiresInDays,
    winners: 0,
    attempts: 0,
    adminId,
    cd: {},
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresInDays * 86400000).toISOString(),
  };

  await writeDatabase(database);
  return send(res, 201, { id, adminId });
}

async function handleCheck(req, body, res) {
  const giveawayId = typeof body.id === "string" ? body.id : "";
  const password = typeof body.password === "string" ? body.password.trim() : "";
  if (!giveawayId || password.length < 3 || password.length > 8) {
    return send(res, 400, { error: "Giveaway ID or password is invalid." });
  }

  const database = await readDatabase();
  const giveaway = database.giveaways[giveawayId];
  if (!giveaway) return send(res, 404, { error: "Giveaway not found." });
  const now = Date.now();
  const expiry = Date.parse(giveaway.expiresAt);
  if (!Number.isFinite(expiry) || now >= expiry) return send(res, 200, { status: "expired" });

  if (!giveaway.cd || typeof giveaway.cd !== "object" || Array.isArray(giveaway.cd)) giveaway.cd = {};
  const clientId = clientIdFor(req, res);
  const entry = giveaway.cd[clientId] || (giveaway.cd[clientId] = { until: 0, fails: 0, won: false });
  if (Number(entry.until) > now) {
    return send(res, 200, { status: "cooldown", cooldownUntil: Number(entry.until) });
  }
  if (Number(entry.until) && Number(entry.until) <= now) entry.until = 0;

  giveaway.attempts = (giveaway.attempts || 0) + 1;
  if (password.toLowerCase() !== String(giveaway.password || "").toLowerCase()) {
    entry.fails = (entry.fails || 0) + 1;
    if (entry.fails >= MAX_FAILS) {
      entry.until = now + COOLDOWN_MS;
      entry.fails = 0;
      await writeDatabase(database);
      return send(res, 200, { status: "locked", cooldownUntil: entry.until });
    }
    await writeDatabase(database);
    return send(res, 200, { status: "wrong", attemptsRemaining: MAX_FAILS - entry.fails });
  }

  if (entry.won) {
    const rewardUrl = safeRewardUrl(giveaway.url);
    if (!rewardUrl) return send(res, 500, { error: "The reward URL is invalid. Contact the giveaway owner." });
    await writeDatabase(database);
    return send(res, 200, { status: "win", url: rewardUrl, alreadyWon: true });
  }

  entry.fails = 0;
  if (Number(giveaway.winners || 0) >= Number(giveaway.capacity || 0)) {
    await writeDatabase(database);
    return send(res, 200, { status: "full" });
  }

  const rewardUrl = safeRewardUrl(giveaway.url);
  if (!rewardUrl) return send(res, 500, { error: "The reward URL is invalid. Contact the giveaway owner." });
  if (randomInt(0, 100) < Number(giveaway.probability)) {
    giveaway.winners = (giveaway.winners || 0) + 1;
    entry.won = true;
    entry.until = 0;
    await writeDatabase(database);
    return send(res, 200, { status: "win", url: rewardUrl });
  }

  entry.until = now + COOLDOWN_MS;
  await writeDatabase(database);
  return send(res, 200, { status: "lose", cooldownUntil: entry.until });
}

async function handleAdminSave(body, res) {
  const adminId = typeof body.adminId === "string" ? body.adminId : "";
  if (!adminId) return send(res, 400, { error: "Admin link is required." });
  const database = await readDatabase();
  const found = findAdmin(database, adminId);
  if (!found) return send(res, 404, { error: "Admin link not found." });

  const giveaway = found[1];
  const newUrl = typeof body.url === "string" ? body.url.trim() : "";
  const newPassword = typeof body.password === "string" ? body.password.trim() : "";
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword.trim() : "";
  const hasCapacity = Object.prototype.hasOwnProperty.call(body, "capacity");
  const newCapacity = hasCapacity ? Number(body.capacity) : Number(giveaway.capacity);

  let safeUrl = "";
  if (newUrl) {
    safeUrl = safeRewardUrl(newUrl);
    if (!safeUrl) return send(res, 400, { error: "Enter a valid HTTP or HTTPS reward URL." });
  }
  if (newPassword && (newPassword.length < 3 || newPassword.length > 8)) {
    return send(res, 400, { error: "New password must be 3–8 characters after trimming spaces." });
  }
  if (newPassword && (!currentPassword || currentPassword.toLowerCase() !== String(giveaway.password || "").toLowerCase())) {
    return send(res, 403, { error: "Current password is incorrect." });
  }
  if (!Number.isSafeInteger(newCapacity) || newCapacity < 1 || newCapacity > MAX_CAPACITY) {
    return send(res, 400, { error: `Winner capacity must be between 1 and ${MAX_CAPACITY}.` });
  }

  const oldSafeUrl = safeRewardUrl(giveaway.url);
  const linkChanged = Boolean(safeUrl && safeUrl !== oldSafeUrl);
  const passwordChanged = Boolean(newPassword && newPassword.toLowerCase() !== String(giveaway.password || "").toLowerCase());
  const statsReset = linkChanged || passwordChanged;
  const currentWinners = Number(giveaway.winners || 0);
  if (!statsReset && newCapacity < currentWinners) {
    return send(res, 400, { error: "Capacity cannot be less than the number of winners already recorded." });
  }

  if (safeUrl) giveaway.url = safeUrl;
  if (passwordChanged) giveaway.password = newPassword;
  giveaway.capacity = newCapacity;
  if (statsReset) {
    giveaway.attempts = 0;
    giveaway.winners = 0;
    giveaway.cd = {};
  }

  await writeDatabase(database);
  return send(res, 200, { ok: true, statsReset, capacity: giveaway.capacity });
}

async function handleRestart(body, res) {
  const adminId = typeof body.adminId === "string" ? body.adminId : "";
  if (!adminId) return send(res, 400, { error: "Admin link is required." });
  const database = await readDatabase();
  const found = findAdmin(database, adminId);
  if (!found) return send(res, 404, { error: "Admin link not found." });

  const giveaway = found[1];
  let durationDays = Number(giveaway.durationDays);
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 10) {
    const oldDuration = (Date.parse(giveaway.expiresAt) - Date.parse(giveaway.createdAt)) / 86400000;
    durationDays = Number.isFinite(oldDuration) ? Math.min(10, Math.max(1, Math.round(oldDuration))) : 3;
  }

  const now = Date.now();
  giveaway.durationDays = durationDays;
  giveaway.createdAt = new Date(now).toISOString();
  giveaway.expiresAt = new Date(now + durationDays * 86400000).toISOString();
  giveaway.attempts = 0;
  giveaway.winners = 0;
  giveaway.cd = {};

  await writeDatabase(database);
  return send(res, 200, { ok: true, expiresAt: giveaway.expiresAt, durationDays });
}

async function handleDelete(body, res) {
  const adminId = typeof body.adminId === "string" ? body.adminId : "";
  const database = await readDatabase();
  const found = findAdmin(database, adminId);
  if (!found) return send(res, 404, { error: "Admin link not found." });
  delete database.giveaways[found[0]];
  await writeDatabase(database);
  return send(res, 200, { ok: true });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!BIN_ID || !MASTER_KEY) return send(res, 500, { error: "Server storage is not configured." });

  try {
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return send(res, 405, { error: "Method not allowed." });
    }
    const body = requestBody(req);
    if (body.action === "create") return await handleCreate(body, res);
    if (body.action === "check") return await handleCheck(req, body, res);
    if (body.action === "admin-save") return await handleAdminSave(body, res);
    if (body.action === "restart") return await handleRestart(body, res);
    if (body.action === "delete") return await handleDelete(body, res);
    return send(res, 400, { error: "Unknown action." });
  } catch (error) {
    console.error("Giveaway API request failed:", error.message);
    return send(res, 502, { error: "Could not reach giveaway storage. Please try again." });
  }
};

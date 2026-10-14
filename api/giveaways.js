const {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} = require("crypto");

const BIN_ID = process.env.JSONBIN_BIN_ID;
const MASTER_KEY = process.env.JSONBIN_MASTER_KEY;
const COOKIE_NAME = "passdrop_client";
const COOLDOWN_MS = 2 * 60 * 60 * 1000;
const MAX_CAPACITY = 1000000;

function send(res, status, payload) {
  res.status(status).json(payload);
}

function getQueryValue(req, key) {
  const value = req.query && req.query[key];
  return Array.isArray(value) ? value[0] : value;
}

function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }
  return {};
}

function parseRewardUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch (_) {
    return null;
  }
}

function parseCookies(header) {
  const cookies = {};
  for (const item of String(header || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

function signClientId(id) {
  return createHmac("sha256", MASTER_KEY)
    .update(`passdrop-client:${id}`)
    .digest("base64url");
}

function getClientId(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) {
    const separator = token.lastIndexOf(".");
    if (separator > 0) {
      const id = token.slice(0, separator);
      const signature = token.slice(separator + 1);
      const expected = signClientId(id);
      const actualBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expected);
      if (
        /^[a-f0-9]{32}$/.test(id) &&
        actualBuffer.length === expectedBuffer.length &&
        timingSafeEqual(actualBuffer, expectedBuffer)
      ) {
        return id;
      }
    }
  }

  const id = randomBytes(16).toString("hex");
  const value = `${id}.${signClientId(id)}`;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${value}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`
  );
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
  if (
    !json.record.giveaways ||
    typeof json.record.giveaways !== "object" ||
    Array.isArray(json.record.giveaways)
  ) {
    json.record.giveaways = {};
  }
  return json.record;
}

async function writeDatabase(database) {
  const response = await fetch(`https://api.jsonbin.io/v3/b/${encodeURIComponent(BIN_ID)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": MASTER_KEY,
    },
    body: JSON.stringify(database),
  });
  if (!response.ok) throw new Error("Could not save giveaway storage");
}

function publicGiveaway(g) {
  return {
    name: g.name,
    expiresAt: g.expiresAt,
  };
}

function adminGiveaway(id, g) {
  return {
    id,
    name: g.name,
    attempts: g.attempts || 0,
    winners: g.winners || 0,
    capacity: g.capacity || 0,
    expiresAt: g.expiresAt,
    url: g.url || "",
  };
}

function findAdminGiveaway(database, adminId) {
  for (const [id, giveaway] of Object.entries(database.giveaways)) {
    if (giveaway.adminId === adminId) return [id, giveaway];
  }
  return null;
}

async function handleGet(req, res) {
  const giveawayId = getQueryValue(req, "g");
  const adminId = getQueryValue(req, "a");
  const database = await readDatabase();

  if (giveawayId) {
    const giveaway = database.giveaways[giveawayId];
    if (!giveaway) return send(res, 404, { error: "Giveaway not found." });
    const expiry = Date.parse(giveaway.expiresAt);
    if (!Number.isFinite(expiry) || Date.now() >= expiry) {
      return send(res, 410, { error: "This giveaway has expired." });
    }
    // Issue a signed HttpOnly ID cookie for server-side attempt tracking.
    getClientId(req, res);
    return send(res, 200, publicGiveaway(giveaway));
  }

  if (adminId) {
    const found = findAdminGiveaway(database, adminId);
    if (!found) return send(res, 404, { error: "Admin link not found." });
    return send(res, 200, adminGiveaway(found[0], found[1]));
  }

  return send(res, 400, { error: "A giveaway or admin link is required." });
}

async function handleCreate(body, res) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const url = parseRewardUrl(body.url);
  const password = typeof body.password === "string" ? body.password.trim() : "";
  const capacity = Number(body.capacity);
  const probability = Number(body.probability);
  const expiresInDays = Number(body.expiresInDays);

  if (!name || name.length > 120) {
    return send(res, 400, { error: "Enter a giveaway name (up to 120 characters)." });
  }
  if (!url) {
    return send(res, 400, { error: "Enter a valid HTTP or HTTPS reward URL." });
  }
  if (password.length < 3 || password.length > 8) {
    return send(res, 400, { error: "Password must be 3–8 characters after trimming spaces." });
  }
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    return send(res, 400, { error: `Winner capacity must be between 1 and ${MAX_CAPACITY}.` });
  }
  if (![25, 50, 75, 100].includes(probability)) {
    return send(res, 400, { error: "Choose a valid win probability." });
  }
  if (![1, 3, 7].includes(expiresInDays)) {
    return send(res, 400, { error: "Choose a valid expiration period." });
  }

  const database = await readDatabase();
  let id;
  do {
    id = randomBytes(12).toString("hex");
  } while (database.giveaways[id]);
  const adminId = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInDays * 86400000);

  database.giveaways[id] = {
    name,
    url,
    password,
    capacity,
    probability,
    winners: 0,
    attempts: 0,
    adminId,
    ipLogs: {},
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
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
  if (!Number.isFinite(expiry) || now >= expiry) {
    return send(res, 200, { status: "expired" });
  }

  if (!giveaway.ipLogs || typeof giveaway.ipLogs !== "object" || Array.isArray(giveaway.ipLogs)) {
    giveaway.ipLogs = {};
  }
  const clientId = getClientId(req, res);
  let clientData = giveaway.ipLogs[clientId];
  if (!clientData || typeof clientData !== "object" || Array.isArray(clientData)) {
    clientData = { attempts: 0, cooldownUntil: 0 };
  }

  if (now < Number(clientData.cooldownUntil || 0)) {
    const minutesLeft = Math.ceil((Number(clientData.cooldownUntil) - now) / 60000);
    return send(res, 200, { status: "cooldown", minutesLeft });
  }

  // Start a fresh five-try allowance after a completed wrong-password cooldown.
  if (Number(clientData.cooldownUntil || 0) && now >= Number(clientData.cooldownUntil)) {
    clientData.attempts = 0;
    clientData.cooldownUntil = 0;
  }

  giveaway.attempts = (giveaway.attempts || 0) + 1;
  if (password.toLowerCase() !== String(giveaway.password || "").toLowerCase()) {
    clientData.attempts = (clientData.attempts || 0) + 1;
    if (clientData.attempts >= 5) {
      clientData.cooldownUntil = now + COOLDOWN_MS;
      giveaway.ipLogs[clientId] = clientData;
      await writeDatabase(database);
      return send(res, 200, { status: "locked", minutesLeft: 120 });
    }

    giveaway.ipLogs[clientId] = clientData;
    await writeDatabase(database);
    return send(res, 200, {
      status: "wrong",
      attemptsRemaining: 5 - clientData.attempts,
    });
  }

  clientData.attempts = 0;
  clientData.cooldownUntil = 0;

  if (giveaway.winners >= giveaway.capacity) {
    giveaway.ipLogs[clientId] = clientData;
    await writeDatabase(database);
    return send(res, 200, { status: "full" });
  }

  if (randomInt(0, 100) < giveaway.probability) {
    const rewardUrl = parseRewardUrl(giveaway.url);
    if (!rewardUrl) return send(res, 500, { error: "The reward URL is invalid. Contact the giveaway owner." });
    giveaway.winners++;
    giveaway.ipLogs[clientId] = clientData;
    await writeDatabase(database);
    return send(res, 200, { status: "win", url: rewardUrl });
  }

  clientData.cooldownUntil = now + COOLDOWN_MS;
  giveaway.ipLogs[clientId] = clientData;
  await writeDatabase(database);
  return send(res, 200, { status: "lose" });
}

async function handleAdminSave(body, res) {
  const adminId = typeof body.adminId === "string" ? body.adminId : "";
  if (!adminId) return send(res, 400, { error: "Admin link is required." });

  const database = await readDatabase();
  const found = findAdminGiveaway(database, adminId);
  if (!found) return send(res, 404, { error: "Admin link not found." });

  const giveaway = found[1];
  const newUrl = typeof body.url === "string" ? body.url.trim() : "";
  const newPassword = typeof body.password === "string" ? body.password.trim() : "";

  if (newUrl) {
    const safeUrl = parseRewardUrl(newUrl);
    if (!safeUrl) return send(res, 400, { error: "Enter a valid HTTP or HTTPS reward URL." });
    giveaway.url = safeUrl;
  }
  if (newPassword) {
    if (newPassword.length < 3 || newPassword.length > 8) {
      return send(res, 400, { error: "Password must be 3–8 characters after trimming spaces." });
    }
    giveaway.password = newPassword;
  }

  await writeDatabase(database);
  return send(res, 200, { ok: true });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (!BIN_ID || !MASTER_KEY) {
    return send(res, 500, { error: "Server storage is not configured." });
  }

  try {
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return send(res, 405, { error: "Method not allowed." });
    }

    const body = getBody(req);
    if (body.action === "create") return await handleCreate(body, res);
    if (body.action === "check") return await handleCheck(req, body, res);
    if (body.action === "admin-save") return await handleAdminSave(body, res);
    return send(res, 400, { error: "Unknown action." });
  } catch (error) {
    console.error("Giveaway API request failed:", error.message);
    return send(res, 502, { error: "Could not reach giveaway storage. Please try again." });
  }
};

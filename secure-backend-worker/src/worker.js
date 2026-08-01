const encoder = new TextEncoder();
const decoder = new TextDecoder();
const GITHUB_API_VERSION = "2026-03-10";
const CONTENT_PATHS = Object.freeze({
  banners: "content/banners.json",
  ttbuddy: "content/ttbuddy.json"
});
const MAX_JSON_BYTES = 500_000;
const MAX_IMAGE_BYTES = 4_500_000;
const loginAttempts = new Map();

function responseJson(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    }
  });
}

function normalizeOrigin(value = "") { return value.trim().replace(/\/$/, ""); }
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || "")
    .split(",").map(normalizeOrigin).filter(Boolean);
}
function corsHeaders(request, env) {
  const origin = normalizeOrigin(request.headers.get("Origin") || "");
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function requireAllowedOrigin(request, env) {
  const origin = normalizeOrigin(request.headers.get("Origin") || "");
  return origin && allowedOrigins(env).includes(origin);
}

function bytesToB64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64UrlToText(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return decoder.decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0)));
}
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), {name:"HMAC", hash:"SHA-256"}, false, ["sign"]);
  return bytesToB64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
function constantTimeEqual(a, b) {
  a = String(a ?? ""); b = String(b ?? "");
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i=0; i<length; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
async function makeToken(username, env) {
  const payload = bytesToB64Url(encoder.encode(JSON.stringify({
    sub: username,
    iat: Date.now(),
    exp: Date.now() + Number(env.SESSION_HOURS || 8) * 3600_000,
    nonce: crypto.randomUUID()
  })));
  return `${payload}.${await hmac(payload, env.SESSION_SECRET)}`;
}
async function verifyToken(request, env) {
  const raw = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return false;
  const expected = await hmac(payload, env.SESSION_SECRET);
  if (!constantTimeEqual(signature, expected)) return false;
  try {
    const data = JSON.parse(b64UrlToText(payload));
    return data.sub === env.ADMIN_USERNAME && Number(data.exp) > Date.now();
  } catch { return false; }
}

function clientKey(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}
function checkLoginRate(request) {
  const key = clientKey(request);
  const now = Date.now();
  const entry = loginAttempts.get(key) || {count:0, reset:now + 15*60_000};
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 15*60_000; }
  if (entry.count >= 8) return false;
  entry.count += 1; loginAttempts.set(key, entry); return true;
}
function clearLoginRate(request) { loginAttempts.delete(clientKey(request)); }

function githubUrl(path, env) {
  return `https://api.github.com/repos/${encodeURIComponent(env.REPO_OWNER)}/${encodeURIComponent(env.REPO_NAME)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
}
async function githubFetch(path, env, options={}) {
  return fetch(githubUrl(path, env), {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "TuneTalk-Service-V7-Enterprise-CMS",
      ...(options.headers || {})
    }
  });
}
function textToBase64(text) {
  const bytes = encoder.encode(text); let binary="";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToText(value) {
  const clean = value.replace(/\n/g, "");
  return decoder.decode(Uint8Array.from(atob(clean), c => c.charCodeAt(0)));
}
async function readJsonFile(path, env) {
  const result = await githubFetch(path, env);
  if (!result.ok) throw new Error(`GitHub read failed (${result.status})`);
  const body = await result.json();
  return {data: JSON.parse(base64ToText(body.content)), sha: body.sha};
}
async function writeJsonFile(path, data, message, env) {
  const existing = await readJsonFile(path, env).catch(() => null);
  const text = JSON.stringify(data, null, 2) + "\n";
  if (encoder.encode(text).byteLength > MAX_JSON_BYTES) throw new Error("Content file is too large");
  const result = await githubFetch(path, env, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: textToBase64(text),
      branch: env.BRANCH || "main",
      ...(existing?.sha ? {sha: existing.sha} : {})
    })
  });
  if (!result.ok) throw new Error(`GitHub save failed (${result.status}): ${await result.text()}`);
  return result.json();
}
function validateBanners(data) {
  if (!Array.isArray(data) || data.length > 30) throw new Error("Invalid banner data");
  return data.map((item, index) => ({
    title: String(item.title || "Banner").slice(0, 100),
    image: String(item.image || "").replace(/^\/+/, "").slice(0, 300),
    alt: String(item.alt || item.title || "TuneTalk promotion").slice(0, 180),
    link: String(item.link || "#plans").slice(0, 300),
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : index + 1,
    enabled: item.enabled !== false
  }));
}
function validateKnowledge(data) {
  if (!Array.isArray(data) || data.length > 300) throw new Error("Invalid TT Buddy data");
  return data.map((item, index) => ({
    id: String(item.id || `kb-${Date.now()}-${index}`).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
    title: String(item.title || "Knowledge item").slice(0, 120),
    keywords: Array.from(new Set((Array.isArray(item.keywords) ? item.keywords : [])
      .map(value => String(value).trim().toLowerCase()).filter(Boolean))).slice(0, 30),
    answers: {
      zh: String(item.answers?.zh || "").slice(0, 4000),
      en: String(item.answers?.en || "").slice(0, 4000),
      ms: String(item.answers?.ms || "").slice(0, 4000)
    },
    enabled: item.enabled !== false
  }));
}
function decodeBase64Bytes(value) {
  const clean = String(value || "").replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  const binary = atob(clean);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
function detectImageExtension(bytes) {
  if (bytes[0]===0x89 && bytes[1]===0x50 && bytes[2]===0x4E && bytes[3]===0x47) return "png";
  if (bytes[0]===0xFF && bytes[1]===0xD8 && bytes[2]===0xFF) return "jpg";
  if (bytes[0]===0x52 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x46 && bytes[8]===0x57 && bytes[9]===0x45 && bytes[10]===0x42 && bytes[11]===0x50) return "webp";
  if (bytes[0]===0x47 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x38) return "gif";
  return "";
}
function bytesToBase64(bytes) {
  let binary=""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary);
}

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, {status:204, headers:cors});
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return responseJson({ok:true, service:"TuneTalk V7 Enterprise CMS", requestId}, 200, cors);
      if (!requireAllowedOrigin(request, env)) return responseJson({error:"Origin not allowed", requestId}, 403, cors);

      if (url.pathname === "/login" && request.method === "POST") {
        if (!checkLoginRate(request)) return responseJson({error:"Too many login attempts. Try again later.", requestId}, 429, cors);
        const body = await request.json();
        if (!constantTimeEqual(body.username, env.ADMIN_USERNAME) || !constantTimeEqual(body.password, env.ADMIN_PASSWORD)) {
          return responseJson({error:"Username or password is incorrect", requestId}, 401, cors);
        }
        clearLoginRate(request);
        return responseJson({token: await makeToken(body.username, env), expiresHours:Number(env.SESSION_HOURS || 8)}, 200, cors);
      }

      if (!(await verifyToken(request, env))) return responseJson({error:"Session expired. Please sign in again.", requestId}, 401, cors);
      if (url.pathname === "/api/session" && request.method === "GET") return responseJson({ok:true, user:env.ADMIN_USERNAME}, 200, cors);

      if (url.pathname === "/api/content" && request.method === "GET") {
        const type = url.searchParams.get("type");
        if (!CONTENT_PATHS[type]) return responseJson({error:"Invalid content type", requestId}, 400, cors);
        const file = await readJsonFile(CONTENT_PATHS[type], env);
        return responseJson({data:file.data, sha:file.sha}, 200, cors);
      }

      if (url.pathname === "/api/save" && request.method === "POST") {
        const body = await request.json();
        if (!CONTENT_PATHS[body.type]) return responseJson({error:"Invalid content type", requestId}, 400, cors);
        const cleaned = body.type === "banners" ? validateBanners(body.data) : validateKnowledge(body.data);
        await writeJsonFile(CONTENT_PATHS[body.type], cleaned, `V7 Enterprise CMS: update ${body.type}`, env);
        return responseJson({ok:true, message:"Published to GitHub", requestId}, 200, cors);
      }

      if (url.pathname === "/api/upload" && request.method === "POST") {
        const body = await request.json();
        const bytes = decodeBase64Bytes(body.contentBase64);
        if (!bytes.length || bytes.byteLength > MAX_IMAGE_BYTES) return responseJson({error:"Image must be smaller than 4.5 MB", requestId}, 413, cors);
        const extension = detectImageExtension(bytes);
        if (!extension) return responseJson({error:"Only PNG, JPG, WEBP or GIF images are accepted", requestId}, 400, cors);
        const safeStem = String(body.filename || "banner").replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 45) || "banner";
        const path = `images/banners/${safeStem}-${Date.now()}.${extension}`;
        const result = await githubFetch(path, env, {
          method:"PUT",
          body:JSON.stringify({message:"V7 Enterprise CMS: upload banner image", content:bytesToBase64(bytes), branch:env.BRANCH || "main"})
        });
        if (!result.ok) throw new Error(`GitHub image upload failed (${result.status}): ${await result.text()}`);
        return responseJson({ok:true, path, requestId}, 200, cors);
      }

      return responseJson({error:"Not found", requestId}, 404, cors);
    } catch (error) {
      console.error(requestId, error);
      return responseJson({error:error?.message || "Server error", requestId}, 500, cors);
    }
  }
};

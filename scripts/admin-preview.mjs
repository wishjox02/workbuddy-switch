// Windows/Node preview for the admin panel when Rust is not installed.
// Production deployments should run `cargo run -p wb-switch-admin` instead.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { Readable } from "node:stream";
import YAML from "yaml";

const root = path.dirname(fileURLToPath(import.meta.url));
const adminHtml = await readFile(path.join(root, "..", "crates", "wb-switch-admin", "public", "admin.html"), "utf8");
const db = new DatabaseSync(path.join(root, "..", "wb-admin-preview.sqlite3"));
db.exec(`CREATE TABLE IF NOT EXISTS sub2api_config (id INTEGER PRIMARY KEY CHECK (id = 1), base_url TEXT NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL, api_key_last4 TEXT NOT NULL, model_count INTEGER NOT NULL DEFAULT 0, models_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS sub2api_admin_config (id INTEGER PRIMARY KEY CHECK (id = 1), nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL, api_key_last4 TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sub2api_user_keys (user_id INTEGER PRIMARY KEY, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL, api_key_last4 TEXT NOT NULL, group_id INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL DEFAULT '', sub2api_account_id TEXT UNIQUE, sub2api_balance REAL, sub2api_status TEXT, sub2api_last_sync_at INTEGER, credits REAL NOT NULL DEFAULT 0, sub2api_usage_cost REAL NOT NULL DEFAULT 0, sub2api_usage_requests INTEGER NOT NULL DEFAULT 0, sub2api_usage_tokens INTEGER NOT NULL DEFAULT 0, sub2api_usage_last_sync_at INTEGER, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, last_login_at INTEGER);
CREATE TABLE IF NOT EXISTS sms_challenges (challenge_id TEXT PRIMARY KEY, phone TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used_at INTEGER, provider TEXT NOT NULL DEFAULT 'local', out_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS user_sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);`);
for (const statement of [
  "ALTER TABLE sms_challenges ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'",
  "ALTER TABLE sms_challenges ADD COLUMN out_id TEXT NOT NULL DEFAULT ''",
]) { try { db.exec(statement); } catch {} }
db.exec(`CREATE TABLE IF NOT EXISTS sms_settings (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 1, access_key_id TEXT NOT NULL DEFAULT '', secret_nonce TEXT NOT NULL DEFAULT '', secret_ciphertext TEXT NOT NULL DEFAULT '', secret_tag TEXT NOT NULL DEFAULT '', key_hint TEXT NOT NULL DEFAULT '', sign_name TEXT NOT NULL DEFAULT '', template_code TEXT NOT NULL DEFAULT '100001', scheme_name TEXT NOT NULL DEFAULT '', endpoint TEXT NOT NULL DEFAULT 'dypnsapi.aliyuncs.com', updated_at INTEGER NOT NULL DEFAULT 0)`);
db.exec(`CREATE TABLE IF NOT EXISTS model_services (id INTEGER PRIMARY KEY AUTOINCREMENT, model_type TEXT NOT NULL, model_id TEXT NOT NULL, display_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS kyrenpay_config (id INTEGER PRIMARY KEY CHECK (id = 1), api_base TEXT NOT NULL DEFAULT 'https://api.kyrenpay.com/epay', public_base TEXT NOT NULL DEFAULT '', pid TEXT NOT NULL, pkey_nonce TEXT NOT NULL, pkey_ciphertext TEXT NOT NULL, pkey_tag TEXT NOT NULL, pkey_last4 TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS recharge_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, out_trade_no TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL, amount REAL NOT NULL, credited REAL NOT NULL DEFAULT 0, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending', trade_no TEXT, pay_url TEXT, client_ip TEXT, created_at INTEGER NOT NULL, paid_at INTEGER, credited_at INTEGER)`);
db.exec(`CREATE TABLE IF NOT EXISTS recharge_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, amount REAL NOT NULL, credits REAL NOT NULL, label TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS credit_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, delta REAL NOT NULL, balance_after REAL NOT NULL, type TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', operator TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger (user_id, id DESC)`);
{ // 默认套餐：10 元 = 1000 积分（仅首次建库时插入）
  const existing = db.prepare("SELECT COUNT(*) AS count FROM recharge_plans").get();
  if (!existing.count) {
    const now = Date.now() / 1000;
    const defaults = [[10, 1000], [30, 3100], [50, 5300], [100, 11000], [200, 23000], [500, 60000]];
    for (let index = 0; index < defaults.length; index += 1) db.prepare("INSERT INTO recharge_plans (amount, credits, label, enabled, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(defaults[index][0], defaults[index][1], "", 1, index, now, now);
  }
}
for (const statement of [
  "CREATE TABLE IF NOT EXISTS kyrenpay_config (id INTEGER PRIMARY KEY CHECK (id = 1), api_base TEXT NOT NULL DEFAULT 'https://api.kyrenpay.com/epay', public_base TEXT NOT NULL DEFAULT '', pid TEXT NOT NULL, pkey_nonce TEXT NOT NULL, pkey_ciphertext TEXT NOT NULL, pkey_tag TEXT NOT NULL, pkey_last4 TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
  // 客户端公告（kv 表：key=app_announcement 时 content 即公告文案；enabled=0 隐藏）
  "CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)",
  // Token 消耗记录：每次“同步消费”写入一条增量记录，供后台 Token 菜单按用户查明细
  "CREATE TABLE IF NOT EXISTS token_usage_records (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, account_id TEXT NOT NULL DEFAULT '', cost_delta REAL NOT NULL DEFAULT 0, cost_total REAL NOT NULL DEFAULT 0, requests_delta INTEGER NOT NULL DEFAULT 0, requests_total INTEGER NOT NULL DEFAULT 0, tokens_delta INTEGER NOT NULL DEFAULT 0, tokens_total INTEGER NOT NULL DEFAULT 0, credits_after REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'sub2api_sync', note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
]) { try { db.exec(statement); } catch {} }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage_records (user_id, id DESC)"); } catch {}
{ // 默认公告（仅首次建库时插入）
  const existing = db.prepare("SELECT COUNT(*) AS count FROM app_kv WHERE key='app_announcement'").get();
  if (!existing.count) {
    db.prepare("INSERT INTO app_kv (key, value, enabled, updated_at) VALUES ('app_announcement', ?, 1, ?)")
      .run("欢迎使用小玉米 🌽 新用户注册即送 500 积分，充值 10 元起。", Date.now() / 1000);
  }
}
for (const statement of ["ALTER TABLE users ADD COLUMN sub2api_balance REAL", "ALTER TABLE users ADD COLUMN sub2api_status TEXT", "ALTER TABLE users ADD COLUMN sub2api_last_sync_at INTEGER", "ALTER TABLE users ADD COLUMN credits REAL NOT NULL DEFAULT 0", "ALTER TABLE users ADD COLUMN sub2api_usage_cost REAL NOT NULL DEFAULT 0", "ALTER TABLE users ADD COLUMN sub2api_usage_requests INTEGER NOT NULL DEFAULT 0", "ALTER TABLE users ADD COLUMN sub2api_usage_tokens INTEGER NOT NULL DEFAULT 0", "ALTER TABLE users ADD COLUMN sub2api_usage_last_sync_at INTEGER"]) { try { db.exec(statement); } catch {} }
const installations = new Map();
const releases = [];
const previewKey = createHash("sha256").update(process.env.WB_ADMIN_MASTER_KEY || "workbuddy-admin-preview-only").digest();

function encryptSecret(secret) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", previewKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decryptSecret(row) {
  if (!row?.nonce || !row?.ciphertext || !row?.tag) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", previewKey, Buffer.from(row.nonce, "base64"));
    decipher.setAuthTag(Buffer.from(row.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function loadSub2Api() {
  const row = db.prepare("SELECT * FROM sub2api_config WHERE id=1").get();
  const adminRow = db.prepare("SELECT * FROM sub2api_admin_config WHERE id=1").get();
  if (!row) return { config: { configured: false, baseUrl: "", apiKeyLast4: null, modelCount: 0 }, adminConfig: { configured: Boolean(adminRow), apiKeyLast4: adminRow?.api_key_last4 || null, updatedAt: adminRow?.updated_at || null }, apiKey: "", adminApiKey: decryptSecret(adminRow), models: [] };
  const models = JSON.parse(row.models_json || "[]");
  return { config: { configured: Boolean(row.base_url), baseUrl: row.base_url, apiKeyLast4: null, modelCount: row.model_count || models.length }, adminConfig: { configured: Boolean(adminRow), apiKeyLast4: adminRow?.api_key_last4 || null, updatedAt: adminRow?.updated_at || null }, apiKey: decryptSecret(row), adminApiKey: decryptSecret(adminRow), models };
}

function saveSub2Api() {
  const current = db.prepare("SELECT * FROM sub2api_config WHERE id=1").get();
  const encrypted = sub2api.apiKey ? encryptSecret(sub2api.apiKey) : current;
  db.prepare(`INSERT INTO sub2api_config (id, base_url, nonce, ciphertext, tag, api_key_last4, model_count, models_json)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET base_url=excluded.base_url, nonce=excluded.nonce, ciphertext=excluded.ciphertext, tag=excluded.tag, api_key_last4=excluded.api_key_last4, model_count=excluded.model_count, models_json=excluded.models_json`)
    .run(sub2api.config.baseUrl, encrypted?.nonce || "", encrypted?.ciphertext || "", encrypted?.tag || "", sub2api.config.apiKeyLast4 || "", sub2api.models.length, JSON.stringify(sub2api.models));
}

const sub2api = loadSub2Api();
const localProxyKey = "wb-switch-local";
const workbuddyModelsPath = path.join(process.env.USERPROFILE || process.env.HOME || ".", ".workbuddy", "models.json");
const workbuddyDisabledPath = path.join(process.env.USERPROFILE || process.env.HOME || ".", ".workbuddy", "models.disabled.json");

async function loadWorkBuddyModels() {
  try {
    const text = await readFile(workbuddyModelsPath, "utf8");
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`读取 WorkBuddy 模型文件失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadDisabledWorkBuddyModels() {
  try {
    const text = await readFile(workbuddyDisabledPath, "utf8");
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`读取 WorkBuddy 禁用模型文件失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function saveDisabledWorkBuddyModels(models) {
  const directory = path.dirname(workbuddyDisabledPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${workbuddyDisabledPath}.wb-switch-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(models, null, 2)}\n`, "utf8");
  try { await rename(temporaryPath, workbuddyDisabledPath); } catch (error) { try { await readFile(temporaryPath); await rename(temporaryPath, workbuddyDisabledPath); } catch { throw error; } }
}

function publicWorkBuddyModels(models, disabledIds = []) {
  return models.map((model) => {
    const copy = { ...model };
    copy.managed = model.wbSwitchManaged === true;
    copy.disabled = disabledIds.includes(model.id);
    delete copy.apiKey;
    return copy;
  });
}

async function saveWorkBuddyModels(models) {
  const directory = path.dirname(workbuddyModelsPath);
  await mkdir(directory, { recursive: true });
  try { await copyFile(workbuddyModelsPath, `${workbuddyModelsPath}.wb-switch.bak`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporaryPath = `${workbuddyModelsPath}.wb-switch-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(models, null, 2)}\n`, "utf8");
  try { await rename(temporaryPath, workbuddyModelsPath); } catch (error) { try { await readFile(temporaryPath); await rename(temporaryPath, workbuddyModelsPath); } catch { throw error; } }
}

function workBuddyModelEntry(input, proxyUrl, userApiKey = null, existing = null) {
  const id = String(input?.id || "").trim();
  if (!id || id.length > 256) return null;
  const name = String(input?.name || id).trim() || id;
  const vendor = String(input?.vendor || input?.provider || "Sub2API").trim() || "Sub2API";
  // WorkBuddy 客户端要求每个模型条目带有 token 上限等字段；缺字段时客户端可能不显示/不启用该模型。
  // 已有条目（重新导入接管）保留其原有能力与上限配置，仅更新认证与来源。
  const base = existing && typeof existing === "object" ? existing : {};
  return {
    ...base,
    id,
    name: base.name && base.name !== base.id ? base.name : name,
    vendor,
    url: proxyUrl,
    apiKey: userApiKey || localProxyKey,
    wbSwitchManaged: Boolean(userApiKey),
    supportsToolCall: base.supportsToolCall ?? true,
    supportsImages: base.supportsImages ?? false,
    supportsReasoning: base.supportsReasoning ?? false,
    useCustomProtocol: base.useCustomProtocol ?? false,
    maxInputTokens: Number.isFinite(Number(base.maxInputTokens)) && Number(base.maxInputTokens) > 0 ? Number(base.maxInputTokens) : 200000,
    maxOutputTokens: Number.isFinite(Number(base.maxOutputTokens)) && Number(base.maxOutputTokens) > 0 ? Number(base.maxOutputTokens) : 65536,
  };
}

// ---- DeepSeek Harness (dsh) 模型配置 ----
const dshProfilePatchPath = path.join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh", "profiles", "desktop", "cordis.patch.yml");
const dshDisabledPath = path.join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh", "profiles", "desktop", "dsh-models.disabled.json");
const dshProviderName = "wb-switch";

async function loadDshPatch() {
  const text = await readFile(dshProfilePatchPath, "utf8");
  const doc = YAML.parse(text);
  if (!Array.isArray(doc)) throw new Error("cordis.patch.yml 不是有效的 YAML 数组");
  return doc;
}

async function saveDshPatch(doc) {
  const directory = path.dirname(dshProfilePatchPath);
  await mkdir(directory, { recursive: true });
  try { await copyFile(dshProfilePatchPath, `${dshProfilePatchPath}.wb-switch.bak`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporaryPath = `${dshProfilePatchPath}.wb-switch-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporaryPath, YAML.stringify(doc), "utf8");
  try { await rename(temporaryPath, dshProfilePatchPath); } catch (error) { try { await readFile(temporaryPath); await rename(temporaryPath, dshProfilePatchPath); } catch { throw error; } }
}

async function loadDshDisabled() {
  try {
    const text = await readFile(dshDisabledPath, "utf8");
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function saveDshDisabled(models) {
  const directory = path.dirname(dshDisabledPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${dshDisabledPath}.wb-switch-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(models, null, 2)}\n`, "utf8");
  try { await rename(temporaryPath, dshDisabledPath); } catch (error) { try { await readFile(temporaryPath); await rename(temporaryPath, dshDisabledPath); } catch { throw error; } }
}

function dshEntryFromInput(input, apiBase, apiKeyEnv) {
  const id = String(input?.id || "").trim();
  if (!id || id.length > 256) return null;
  const name = String(input?.name || id).trim() || id;
  return { id, name };
}

async function dshProviderModels() {
  const doc = await loadDshPatch();
  const entry = doc.find((item) => item?.id === "llm-pi-ai");
  const provider = entry?.config?.providers?.[dshProviderName];
  if (!provider) return { doc, entry, provider: null, models: [] };
  const models = Array.isArray(provider.models) ? provider.models.filter((m) => m && typeof m === "object") : [];
  return { doc, entry, provider, models };
}

// 参考 WorkBuddy 的读取方式：读取 llm-pi-ai 下所有 provider 的模型，
// wb-switch 之外的 provider 也展示出来（标记 managed: false + providerName）
async function dshAllModels() {
  const doc = await loadDshPatch();
  const entry = doc.find((item) => item?.id === "llm-pi-ai");
  const providers = entry?.config?.providers || {};
  const models = [];
  for (const [name, provider] of Object.entries(providers)) {
    if (!provider || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!model || typeof model !== "object" || !model.id) continue;
      models.push({ id: model.id, name: model.name || model.id, providerName: name, managed: name === dshProviderName && model.managed !== false });
    }
  }
  return models;
}

async function ensureDshEntry(doc) {
  let entry = doc.find((item) => item?.id === "llm-pi-ai");
  if (!entry) {
    entry = { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers: {} } };
    doc.push(entry);
  }
  if (!entry.config) entry.config = {};
  if (!entry.config.providers) entry.config.providers = {};
  return entry;
}

function publicDshModels(models, disabled) {
  const disabledIds = disabled.map((item) => item.id);
  return models.map((model) => ({ ...model, managed: model.managed !== false, disabled: disabledIds.includes(model.id) }));
}

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(body));
}

async function body(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
}

async function rawBody(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

function overview() {
  const rows = [...installations.values()];
  const versionCounts = new Map();
  const platformCounts = new Map();
  let totalAccounts = 0;
  for (const row of rows) {
    totalAccounts += row.accountCount;
    versionCounts.set(row.appVersion, (versionCounts.get(row.appVersion) || 0) + 1);
    const platform = `${row.os}/${row.arch}`;
    platformCounts.set(platform, (platformCounts.get(platform) || 0) + 1);
  }
  const distribution = (map) => [...map.entries()].map(([key, count]) => ({ key, count }));
  return {
    totalInstallations: rows.length,
    activeToday: rows.length,
    active7d: rows.length,
    active30d: rows.length,
    totalAccounts,
    averageAccounts: rows.length ? totalAccounts / rows.length : 0,
    versions: distribution(versionCounts),
    platforms: distribution(platformCounts),
    features: [],
  };
}

function hashSecret(value) { return createHash("sha256").update(value).digest("hex"); }
function normalizePhone(value) { return String(value || "").replace(/[^0-9+]/g, ""); }
function maskPhone(value) { const phone = normalizePhone(value); return phone.length > 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : "***"; }
// ---- 阿里云号码认证服务（PNVS）短信验证码 ----
const smsEnv = (key) => String(process.env[key] || "").trim();
function smsConfig() {
  const accessKeyId = smsEnv("WB_SMS_ACCESS_KEY_ID");
  const accessKeySecret = smsEnv("WB_SMS_ACCESS_KEY_SECRET");
  const signName = smsEnv("WB_SMS_SIGN_NAME");
  if (!accessKeyId || !accessKeySecret || !signName) return null;
  return {
    accessKeyId,
    accessKeySecret,
    signName,
    templateCode: smsEnv("WB_SMS_TEMPLATE_CODE") || "100001",
    schemeName: smsEnv("WB_SMS_SCHEME_NAME"),
    endpoint: smsEnv("WB_SMS_ENDPOINT") || "dypnsapi.aliyuncs.com",
  };
}
function smsSettingsRow() {
  try { return db.prepare("SELECT * FROM sms_settings WHERE id=1").get() || null; } catch { return null; }
}

function smsSecretHint(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "••••";
  return `${text.slice(0, 3)}...${text.slice(-4)}`;
}

function resolveSmsConfig() {
  const envConfig = smsConfig();
  if (envConfig) return { config: envConfig, source: "environment", error: null };
  const row = smsSettingsRow();
  if (!row) return { config: null, source: "none", error: null };
  if (!(row.enabled === 1 || row.enabled === true)) return { config: null, source: "management", error: null };
  const accessKeyId = String(row.access_key_id || "").trim();
  const signName = String(row.sign_name || "").trim();
  if (!accessKeyId || !signName) return { config: null, source: "management", error: null };
  const secret = decryptSecret({ nonce: row.secret_nonce, ciphertext: row.secret_ciphertext, tag: row.secret_tag });
  if (!secret) return { config: null, source: "management", error: "短信密钥无法解密，请在设置里重新保存 AccessKey Secret" };
  return {
    config: {
      accessKeyId,
      accessKeySecret: secret,
      signName,
      templateCode: String(row.template_code || "100001"),
      schemeName: String(row.scheme_name || ""),
      endpoint: String(row.endpoint || "dypnsapi.aliyuncs.com"),
    },
    source: "management",
    error: null,
  };
}

function smsSettingsPayload() {
  const row = smsSettingsRow() || {};
  const resolved = resolveSmsConfig();
  return {
    provider: "aliyun",
    enabled: row.enabled === 1 || row.enabled === true,
    accessKeyId: String(row.access_key_id || ""),
    secretConfigured: Boolean(row.secret_ciphertext),
    keyHint: String(row.key_hint || ""),
    signName: String(row.sign_name || ""),
    templateCode: String(row.template_code || "100001"),
    schemeName: String(row.scheme_name || ""),
    endpoint: String(row.endpoint || "dypnsapi.aliyuncs.com"),
    updatedAt: Number(row.updated_at || 0),
    source: resolved.source,
    configured: Boolean(resolved.config),
    envOverride: Boolean(String(process.env.WB_SMS_ACCESS_KEY_ID || "").trim()),
    error: resolved.error,
  };
}

const SMS_API_VERSION = "2017-05-25";
const percentEncode = (value) =>
  encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) =>
    "%" + character.charCodeAt(0).toString(16).toUpperCase());

async function smsCall(config, action, params) {
  const sorted = [...params].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const body = sorted.map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`).join("&");
  const payloadHash = createHash("sha256").update(body, "utf8").digest("hex");
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce = randomBytes(16).toString("hex");
  const headers = [
    ["content-type", "application/x-www-form-urlencoded"],
    ["host", config.endpoint],
    ["x-acs-action", action],
    ["x-acs-content-sha256", payloadHash],
    ["x-acs-date", date],
    ["x-acs-signature-nonce", nonce],
    ["x-acs-version", SMS_API_VERSION],
  ];
  const canonicalHeaders = headers.map(([key, value]) => `${key}:${value}\n`).join("");
  const signedHeaders = headers.map(([key]) => key).join(";");
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `ACS3-HMAC-SHA256\n${createHash("sha256").update(canonicalRequest, "utf8").digest("hex")}`;
  const signature = createHmac("sha256", config.accessKeySecret).update(stringToSign, "utf8").digest("hex");
  const authorization = `ACS3-HMAC-SHA256 Credential=${config.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  const response = await fetch(`https://${config.endpoint}/`, {
    method: "POST",
    headers: { ...Object.fromEntries(headers), authorization },
    body,
  });
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { Code: "InvalidResponse", Message: text }; }
}

function smsBodyOk(result) {
  const success = result.Success === true || String(result.Success || "").toLowerCase() === "true";
  return String(result.Code || "") === "OK" && success;
}

function smsBodyMessage(result, fallback) {
  const message = String(result.Message || fallback || "阿里云拒绝请求");
  const code = String(result.Code || "");
  return (code && code !== "OK" ? `${message}（${code}）` : message).slice(0, 300);
}

async function sendAliyunSmsCode(config, phone, outId, validSeconds = 300) {
  const valid = Math.min(900, Math.max(60, Number(validSeconds) || 300));
  const params = [
    ["PhoneNumber", phone],
    ["SignName", config.signName],
    ["TemplateCode", config.templateCode],
    ["TemplateParam", JSON.stringify({ code: "##code##", min: String(Math.max(1, Math.floor(valid / 60))) })],
    ["CountryCode", "86"],
    ["OutId", outId],
    ["Interval", "60"],
    ["ValidTime", String(valid)],
    ["ReturnVerifyCode", "false"],
    ["CodeType", "1"],
  ];
  if (config.schemeName) params.push(["SchemeName", config.schemeName]);
  const result = await smsCall(config, "SendSmsVerifyCode", params);
  if (!smsBodyOk(result)) throw new Error(`短信验证码发送失败：${smsBodyMessage(result, "阿里云拒绝发送")}`);
  const model = result.Model || {};
  return { bizId: model.BizId || "", outId: model.OutId || outId, requestId: result.RequestId || "" };
}

async function checkAliyunSmsCode(config, phone, verifyCode, outId) {
  const params = [
    ["PhoneNumber", phone],
    ["VerifyCode", String(verifyCode || "")],
    ["CountryCode", "86"],
    ["OutId", String(outId || "")],
    ["CaseAuthPolicy", "1"],
  ];
  if (config.schemeName) params.push(["SchemeName", config.schemeName]);
  const result = await smsCall(config, "CheckSmsVerifyCode", params);
  if (String(result.Code || "") !== "OK") throw new Error(`验证码核验失败：${smsBodyMessage(result, "阿里云核验失败")}`);
  return String((result.Model || {}).VerifyResult || "").toUpperCase() === "PASS";
}

function makeSessionToken() { return `${randomBytes(24).toString("hex")}${randomBytes(24).toString("hex")}`; }
function userRow(row) { return row ? { id: row.id, phone: row.phone, displayName: row.display_name, sub2apiAccountId: row.sub2api_account_id, sub2apiBalance: row.sub2api_balance ?? null, sub2apiStatus: row.sub2api_status ?? null, sub2apiLastSyncAt: row.sub2api_last_sync_at ?? null, credits: Number(row.credits || 0), sub2apiUsageCost: Number(row.sub2api_usage_cost || 0), sub2apiUsageRequests: Number(row.sub2api_usage_requests || 0), sub2apiUsageTokens: Number(row.sub2api_usage_tokens || 0), sub2apiUsageLastSyncAt: row.sub2api_usage_last_sync_at ?? null, status: row.status, createdAt: row.created_at, lastLoginAt: row.last_login_at } : null; }

// ---- KyrenPay (EasyPay 兼容) 充值 ----
function loadKyrenpay() {
  const row = db.prepare("SELECT * FROM kyrenpay_config WHERE id=1").get();
  if (!row) return { configured: false, enabled: false, apiBase: "https://api.kyrenpay.com/epay", publicBase: "", pid: "", pkey: "", pkeyLast4: null };
  const pkey = decryptSecret({ nonce: row.pkey_nonce, ciphertext: row.pkey_ciphertext, tag: row.pkey_tag });
  return { configured: Boolean(row.pid && pkey), enabled: row.enabled === 1, apiBase: (row.api_base || "https://api.kyrenpay.com/epay").replace(/\/$/, ""), publicBase: (row.public_base || "").replace(/\/$/, ""), pid: row.pid, pkey, pkeyLast4: row.pkey_last4 || null };
}

// DSH provider 通过 apiKeyEnv 环境变量读取密钥；导入时写入 Windows 用户级环境变量
function setWbSwitchApiKeyEnv(value) {
  try { require("node:child_process").execSync(`setx WB_SWITCH_API_KEY "${value}"`, { stdio: "ignore" }); return true; }
  catch (error) { console.error("写入 WB_SWITCH_API_KEY 环境变量失败:", error?.message || error); return false; }
}

// 充值回调（notify）和支付完成跳转（return）的公网地址。
// 必须是 KyrenPay 服务器能访问到的本服务地址；留空时回退到请求自身的 Host。
function kyrenpayCallbackBase(request) {
  const config = loadKyrenpay();
  if (config.publicBase) return config.publicBase;
  const host = request.headers.host || request.headers[":authority"] || "";
  const proto = request.headers["x-forwarded-proto"] || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return host ? `${proto}://${host}` : "";
}

function saveKyrenpay(config) {
  const encrypted = config.pkey ? encryptSecret(config.pkey) : { nonce: "", ciphertext: "", tag: "" };
  db.prepare(`INSERT INTO kyrenpay_config (id, api_base, public_base, pid, pkey_nonce, pkey_ciphertext, pkey_tag, pkey_last4, enabled, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET api_base=excluded.api_base, public_base=excluded.public_base, pid=excluded.pid, pkey_nonce=excluded.pkey_nonce, pkey_ciphertext=excluded.pkey_ciphertext, pkey_tag=excluded.pkey_tag, pkey_last4=excluded.pkey_last4, enabled=excluded.enabled, updated_at=excluded.updated_at`)
    .run(config.apiBase, config.publicBase || "", config.pid, encrypted.nonce, encrypted.ciphertext, encrypted.tag, config.pkey ? config.pkey.slice(-4) : "", config.enabled ? 1 : 0, Date.now() / 1000);
}

function kyrenpayConfigRow() {
  const config = loadKyrenpay();
  return { configured: config.configured, enabled: config.enabled && config.configured, apiBase: config.apiBase, publicBase: config.publicBase, pid: config.pid || "", pkeyLast4: config.pkeyLast4 };
}

// 充值套餐：管理员配置的价格 -> 积分映射
function rechargePlanRow(row) { return row ? { id: row.id, amount: row.amount, credits: row.credits, label: row.label || "", enabled: row.enabled === 1, sortOrder: row.sort_order, updatedAt: row.updated_at } : null; }

function loadRechargePlans(includeDisabled = false) {
  const rows = includeDisabled
    ? db.prepare("SELECT * FROM recharge_plans ORDER BY sort_order, amount").all()
    : db.prepare("SELECT * FROM recharge_plans WHERE enabled=1 ORDER BY sort_order, amount").all();
  return rows.map(rechargePlanRow);
}

function resolveRechargePlan(amount) {
  // 按套餐金额精确匹配（允许浮点误差 0.001）；无套餐时按 1 元 = 100 积分兜底
  const plan = db.prepare("SELECT * FROM recharge_plans WHERE enabled=1 AND ABS(amount-?) < 0.001 ORDER BY sort_order LIMIT 1").get(Number(amount));
  if (plan) return { plan, credits: plan.credits };
  return { plan: null, credits: Math.round(Number(amount) * 100) };
}

// EasyPay MD5 签名：去掉 sign/sign_type，去空值，按 key ASCII 升序拼 k=v&...，末尾直接接商户密钥
function epaySign(params, key) {
  const sorted = Object.keys(params)
    .filter((name) => name !== "sign" && name !== "sign_type" && String(params[name] ?? "") !== "")
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join("&");
  return createHash("md5").update(sorted + key).digest("hex");
}

function epayVerify(params, key) {
  const provided = String(params.sign || "").toLowerCase();
  if (!provided) return false;
  return epaySign(params, key) === provided;
}

async function kyrenpayRequest(endpoint, params) {
  const config = loadKyrenpay();
  if (!config.configured) throw new Error("KyrenPay 支付配置未填写");
  const signed = { ...params, pid: config.pid };
  signed.sign = epaySign(signed, config.pkey);
  signed.sign_type = "MD5";
  const form = new URLSearchParams(signed).toString();
  const result = await fetch(`${config.apiBase}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  const text = await result.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!result.ok) throw new Error(`KyrenPay HTTP ${result.status}`);
  if (data && typeof data === "object" && "code" in data && Number(data.code) !== 1) throw new Error(`KyrenPay: ${data.msg || "下单失败"}`);
  return data || text;
}

function rechargeOrderRow(row) { return row ? { id: row.id, outTradeNo: row.out_trade_no, userId: row.user_id, amount: row.amount, credited: row.credited, type: row.type, status: row.status, tradeNo: row.trade_no, payUrl: row.pay_url, createdAt: row.created_at, paidAt: row.paid_at, creditedAt: row.credited_at } : null; }

// 充值到账：本地记录 credited 并尝试同步 sub2api 余额（preview 环境仅记录）
async function creditRechargeOrder(order, tradeNo) {
  const now = Date.now() / 1000;
  db.prepare("UPDATE recharge_orders SET status='Paid', trade_no=?, paid_at=? WHERE out_trade_no=?").run(tradeNo || null, now, order.out_trade_no);
  try {
    if (sub2api.adminApiKey && order.user_id) {
      const user = db.prepare("SELECT * FROM users WHERE id=?").get(order.user_id);
      if (user) adjustCredits(order.user_id, order.credited || order.amount, "recharge", order.out_trade_no, `KyrenPay 充值 ${order.amount} 元`, "kyrenpay");
    }
    db.prepare("UPDATE recharge_orders SET credited=?, credited_at=? WHERE out_trade_no=?").run(order.credited || order.amount, now, order.out_trade_no);
  } catch (error) {
    db.prepare("UPDATE recharge_orders SET status='Credited' WHERE out_trade_no=?").run(order.out_trade_no);
  }
  return rechargeOrderRow(db.prepare("SELECT * FROM recharge_orders WHERE out_trade_no=?").get(order.out_trade_no));
}
function authUser(request) { const value = request.headers.authorization || ""; const token = value.startsWith("Bearer ") ? value.slice(7).trim() : ""; if (!token) return null; const row = db.prepare("SELECT u.* FROM users u JOIN user_sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? ").get(hashSecret(token), Date.now() / 1000); return row ? { token, user: userRow(row) } : null; }
function adminAuthorized(request) { const expected = process.env.WB_ADMIN_TOKEN || ""; if (!expected) return true; const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "").trim(); return bearer === expected; }

function adjustCredits(userId, delta, kind = "manual", reference = "", note = "", operator = "admin") {
  const row = db.prepare("SELECT credits FROM users WHERE id=?").get(userId);
  if (!row) throw new Error("用户不存在");
  const current = Number(row.credits || 0); const change = Number(delta); const next = current + change;
  if (!Number.isFinite(change) || change === 0) throw new Error("积分变更必须是非零数字");
  if (next < 0) throw new Error("积分不能为负数");
  const now = Date.now() / 1000;
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE users SET credits=? WHERE id=?").run(next, userId);
    db.prepare("INSERT INTO credit_ledger (user_id, delta, balance_after, type, ref, note, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(userId, change, next, kind, reference, note, operator, now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return db.prepare("SELECT * FROM users WHERE id=?").get(userId);
}

async function syncSub2ApiConsumption(row) {
  if (!row.sub2api_account_id) throw new Error("用户尚未绑定 Sub2API 账号");
  if (!sub2api.adminApiKey) throw new Error("尚未配置 Sub2API 管理 API Key");
  const response = await fetch(`${adminUsersUrl()}/${encodeURIComponent(row.sub2api_account_id)}/usage`, { headers: { "x-api-key": sub2api.adminApiKey, Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(remoteAdminError(response.status, payload));
  const data = payload.data || payload;
  const usageCost = Number(data.total_cost ?? data.totalCost);
  if (!Number.isFinite(usageCost)) throw new Error("Sub2API 用量响应缺少 total_cost");
  const requests = Number(data.total_requests ?? data.totalRequests) || 0;
  const tokens = Number(data.total_tokens ?? data.totalTokens) || 0;
  const oldCost = Number(row.sub2api_usage_cost || 0);
  const consumedDelta = Math.max(0, usageCost - oldCost);
  let user = db.prepare("SELECT * FROM users WHERE id=?").get(row.id);
  if (consumedDelta > 0) user = adjustCredits(row.id, -consumedDelta, "sub2api_usage", `sub2api:${row.sub2api_account_id}:${usageCost.toFixed(8)}`, "同步 Sub2API 消费", "sub2api");
  const targetBalance = Number(user.credits || 0) > 0 ? 99999999 : 0;
  let balanceAmount = targetBalance; let balanceOperation = "set";
  if (targetBalance <= 0) { const currentRemote = Number((await fetchSub2ApiUser(row.sub2api_account_id)).balance || 0); if (currentRemote <= 0) balanceAmount = 0; else { balanceAmount = currentRemote; balanceOperation = "subtract"; } }
  const balanceResponse = balanceAmount === 0 ? { ok: true, json: async () => ({}) } : await fetch(`${adminUsersUrl()}/${encodeURIComponent(row.sub2api_account_id)}/balance`, { method: "POST", headers: { "x-api-key": sub2api.adminApiKey, "Content-Type": "application/json", "Idempotency-Key": `wb-credit-sync-${row.sub2api_account_id}-${Math.floor(Date.now() / 60000)}` }, body: JSON.stringify({ balance: balanceAmount, operation: balanceOperation, notes: "WorkBuddy 消费积分同步" }) });
  const balancePayload = await balanceResponse.json().catch(() => ({}));
  if (!balanceResponse.ok) throw new Error(remoteAdminError(balanceResponse.status, balancePayload));
  const now = Date.now() / 1000;
  db.prepare("UPDATE users SET sub2api_usage_cost=?, sub2api_usage_requests=?, sub2api_usage_tokens=?, sub2api_usage_last_sync_at=?, sub2api_balance=? WHERE id=?").run(usageCost, requests, tokens, now, targetBalance, row.id);
  const updated = db.prepare("SELECT * FROM users WHERE id=?").get(row.id);
  // 记录本次新增消耗，供后台「Token」菜单查看明细
  if (consumedDelta > 0 || requests > Number(row.sub2api_usage_requests || 0) || tokens > Number(row.sub2api_usage_tokens || 0)) {
    const oldRequests = Number(row.sub2api_usage_requests || 0);
    const oldTokens = Number(row.sub2api_usage_tokens || 0);
    try {
      db.prepare("INSERT INTO token_usage_records (user_id, account_id, cost_delta, cost_total, requests_delta, requests_total, tokens_delta, tokens_total, credits_after, source, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(row.id, String(row.sub2api_account_id || ""), consumedDelta, usageCost, Math.max(0, requests - oldRequests), requests, Math.max(0, tokens - oldTokens), tokens, Number(updated.credits || 0), "sub2api_sync", "同步 Sub2API 消费", now);
    } catch { /* 记录失败不影响同步主流程 */ }
  }
  return { userId: row.id, usageCost, requests, tokens, consumedDelta, creditsAfter: Number(updated.credits || 0), sub2apiBalanceTarget: targetBalance, syncedAt: now };
}

async function fetchSub2ApiModels() {
  if (!sub2api.config.baseUrl) throw new Error("请先保存 Sub2API Base URL");
  if (!sub2api.apiKey) throw new Error("后台未配置全局用户 Key，请先登录客户端读取当前用户模型");
  const base = sub2api.config.baseUrl.replace(/\/$/, "");
  const modelsUrl = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  const response = await fetch(modelsUrl, {
    headers: { Authorization: `Bearer ${sub2api.apiKey}`, Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) throw new Error("Sub2API 返回 401：请使用用户 API Key（通常以 sk- 开头），不要使用管理员 API Key、登录 JWT 或后台密码");
    if (response.status === 403) throw new Error(`Sub2API 返回 403：${payload.error?.message || payload.error || payload.message || "API Key 已识别但没有模型目录权限"}。请检查 Key 所属用户、分组权限、IP 白名单和账户状态`);
    throw new Error(payload.error?.message || payload.error || `Sub2API 返回 ${response.status}`);
  }
  const list = Array.isArray(payload.data) ? payload.data : [];
  return list.filter((model) => model && typeof model.id === "string").map((model) => ({
    id: model.id,
    object: model.object || null,
    ownedBy: model.owned_by || model.ownedBy || null,
    created: typeof model.created === "number" ? model.created : null,
  }));
}

function adminUsersUrl() {
  const base = sub2api.config.baseUrl.replace(/\/$/, "");
  const origin = base.endsWith("/api/v1") ? base.slice(0, -7) : base.endsWith("/v1") ? base.slice(0, -3) : base;
  return `${origin}/api/v1/admin/users`;
}

function adminUsageUrl() { return adminUsersUrl().replace(/\/admin\/users$/, "/admin/usage"); }

function syncEmail(phone) { return `${normalizePhone(phone).replace(/\D/g, "")}@users.workbuddy.local`; }
function extractRemoteItems(payload) {
  const candidates = [payload?.data, payload?.items, payload];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (Array.isArray(candidate?.items)) return candidate.items;
    if (Array.isArray(candidate?.users)) return candidate.users;
  }
  return [];
}
function remoteUserId(value) {
  const candidates = [value, value?.data, value?.data?.user];
  for (const item of candidates) {
    const id = item?.id ?? item?.user_id ?? item?.userId;
    if (id !== undefined && id !== null && String(id).trim()) return String(id);
  }
  return null;
}
function remoteAdminError(status, payload) {
  if (payload?.code === "INVALID_ADMIN_KEY" || status === 401) return "Sub2API 管理 API Key 无效或已失效，请重新生成 Admin API Key";
  return `Sub2API 管理接口返回 ${status}：${payload?.message || payload?.error || "请求失败"}`;
}
async function fetchSub2ApiUsers() {
  if (!sub2api.adminApiKey) throw new Error("尚未配置 Sub2API 管理 API Key");
  const users = []; const seen = new Set();
  for (let page = 1; page <= 1000; page += 1) {
    const url = new URL(adminUsersUrl()); url.searchParams.set("page", String(page)); url.searchParams.set("page_size", "100");
    const response = await fetch(url, { headers: { "x-api-key": sub2api.adminApiKey, Accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(remoteAdminError(response.status, payload));
    const items = extractRemoteItems(payload); let added = 0;
    for (const user of items) {
      const id = remoteUserId(user);
      if (!id || seen.has(id)) continue;
      seen.add(id); users.push(user); added += 1;
    }
    if (items.length < 100 || added === 0) break;
  }
  return users;
}

async function fetchSub2ApiTokenRecords(accountId, page = 1, pageSize = 50, model = "", startDate = "", endDate = "") {
  const user = await fetchSub2ApiUser(accountId);
  const data = await fetchSub2ApiTokenUsagePage({ userId: accountId, page, pageSize, model, startDate, endDate });
  const userData = user.user || user;
  data.user = { id: String(accountId), email: userData.email || "", name: userData.name || userData.username || "", status: userData.status || "unknown", balance: Number.isFinite(Number(userData.balance)) ? Number(userData.balance) : null };
  data.usage = data.stats;
  delete data.stats;
  return data;
}

async function fetchSub2ApiTokenUsagePage({ userId = "", model = "", startDate = "", endDate = "", page = 1, pageSize = 50 } = {}) {
  if (!sub2api.adminApiKey) throw new Error("尚未配置 Sub2API 管理 API Key");
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 50));
  const headers = { "x-api-key": sub2api.adminApiKey, Accept: "application/json" };
  const logsUrl = new URL(adminUsageUrl());
  logsUrl.searchParams.set("page", String(safePage));
  logsUrl.searchParams.set("page_size", String(safePageSize));
  if (userId) logsUrl.searchParams.set("user_id", String(userId));
  if (model) logsUrl.searchParams.set("model", model);
  if (startDate) logsUrl.searchParams.set("start_date", startDate);
  if (endDate) logsUrl.searchParams.set("end_date", endDate);
  const statsUrl = new URL(`${adminUsageUrl()}/stats`);
  if (userId) statsUrl.searchParams.set("user_id", String(userId));
  if (model) statsUrl.searchParams.set("model", model);
  if (startDate) statsUrl.searchParams.set("start_date", startDate);
  if (endDate) statsUrl.searchParams.set("end_date", endDate);
  const [logsResponse, statsResponse] = await Promise.all([fetch(logsUrl, { headers }), fetch(statsUrl, { headers })]);
  const [logsPayload, statsPayload] = await Promise.all([logsResponse.json().catch(() => ({})), statsResponse.json().catch(() => ({}))]);
  if (!logsResponse.ok) throw new Error(remoteAdminError(logsResponse.status, logsPayload));
  if (!statsResponse.ok) throw new Error(remoteAdminError(statsResponse.status, statsPayload));
  const envelope = logsPayload.data || logsPayload;
  const records = extractRemoteItems(logsPayload).map(record => ({
    id: record.id ?? null,
    user_id: record.user_id ?? record.userId ?? null,
    user_email: record.user_email ?? record.email ?? null,
    model: record.model ?? record.model_name ?? null,
    prompt_tokens: record.prompt_tokens ?? record.input_tokens ?? null,
    completion_tokens: record.completion_tokens ?? record.output_tokens ?? null,
    total_tokens: record.total_tokens ?? null,
    actual_cost: record.actual_cost ?? record.cost ?? null,
    created_at: record.created_at ?? record.createdAt ?? null,
    status_code: record.status_code ?? record.statusCode ?? null,
    request_type: record.request_type ?? record.requestType ?? null,
  }));
  return {
    records,
    total: Number(envelope.total ?? envelope.total_count ?? logsPayload.total) || records.length,
    page: safePage,
    pageSize: safePageSize,
    stats: statsPayload.data || statsPayload,
  };
}

async function fetchSub2ApiTokenUsageModels() {
  if (!sub2api.adminApiKey) throw new Error("尚未配置 Sub2API 管理 API Key");
  const response = await fetch(adminUsersUrl().replace(/\/admin\/users$/, "/admin/dashboard/models"), {
    headers: { "x-api-key": sub2api.adminApiKey, Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(remoteAdminError(response.status, payload));
  const data = payload.data || payload;
  const models = Array.isArray(data.models) ? data.models : Array.isArray(data) ? data : [];
  return [...new Set(models.map(item => String(typeof item === "string" ? item : item.model || item.name || item.id || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
async function syncSub2ApiUser(row) {
  const email = syncEmail(row.phone);
  const users = await fetchSub2ApiUsers();
  let remote = users.find((item) => String(item.email || "").toLowerCase() === email.toLowerCase());
  let created = false;
  if (!remote) {
    const response = await fetch(adminUsersUrl(), {
      method: "POST",
      headers: { "x-api-key": sub2api.adminApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: `WbSync-${randomBytes(18).toString("hex")}-a9`, allowed_groups: [], restrict_public_groups: false }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(remoteAdminError(response.status, payload));
    const id = remoteUserId(payload);
    if (!id) throw new Error("Sub2API 创建用户成功，但响应中没有用户 ID");
    remote = { id };
    created = true;
  }
  const accountId = remoteUserId(remote);
  if (!accountId) throw new Error("Sub2API 用户记录缺少 ID");
  const detail = await fetchSub2ApiUser(accountId);
  const balance = Number.isFinite(Number(detail?.balance)) ? Number(detail.balance) : null;
  const remoteStatus = detail?.status ? String(detail.status) : null;
  const syncedAt = Date.now() / 1000;
  const userKey = await ensureSub2ApiUserKey(row.id, accountId);
  db.prepare("UPDATE users SET sub2api_account_id=?, sub2api_balance=?, sub2api_status=?, sub2api_last_sync_at=?, status=CASE WHEN ? IN ('active','disabled') THEN ? ELSE status END WHERE id=?").run(accountId, balance, remoteStatus, syncedAt, remoteStatus, remoteStatus, row.id);
  return { userId: row.id, phone: row.phone, email, sub2apiAccountId: accountId, created, synced: true, error: null, balance, remoteStatus, lastSyncAt: syncedAt, apiKeyLast4: userKey.apiKeyLast4, apiKeyReady: true, modelCount: userKey.modelCount };
}
async function fetchSub2ApiUser(id) {
  if (!sub2api.adminApiKey) throw new Error("尚未配置 Sub2API 管理 API Key");
  const response = await fetch(`${adminUsersUrl()}/${encodeURIComponent(id)}`, { headers: { "x-api-key": sub2api.adminApiKey, Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(remoteAdminError(response.status, payload));
  return payload.data || payload;
}
async function fetchSub2ApiModelsForKey(apiKey) {
  const base = sub2api.config.baseUrl.replace(/\/$/, "");
  const modelsUrl = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  const response = await fetch(modelsUrl, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (payload.code === "INSUFFICIENT_BALANCE") throw new Error("用户 API Key 已创建，但 Sub2API 用户余额不足，暂时无法读取模型");
    throw new Error(payload.error?.message || payload.error || `用户 API Key 读取模型失败 (${response.status})`);
  }
  return Array.isArray(payload.data) ? payload.data.filter((item) => item && typeof item.id === "string") : [];
}
async function ensureSub2ApiUserKey(userId, accountId) {
  const existing = db.prepare("SELECT * FROM sub2api_user_keys WHERE user_id=?").get(userId);
  if (existing) {
    const key = decryptSecret(existing);
    try { const models = await fetchSub2ApiModelsForKey(key); return { apiKeyLast4: existing.api_key_last4, key, modelCount: models.length }; } catch (error) { const message = String(error?.message || error); if (message.includes("INSUFFICIENT_BALANCE") || message.includes("余额不足") || message.includes("403")) return { apiKeyLast4: existing.api_key_last4, key, modelCount: 0 }; throw error; }
  }
  if (!sub2api.adminApiKey) throw new Error("尚未配置 Sub2API 管理 API Key");
  const groupResponse = await fetch(`${adminUsersUrl().replace(/\/users$/, "/groups/all")}`, { headers: { "x-api-key": sub2api.adminApiKey, Accept: "application/json" } });
  const groupPayload = await groupResponse.json().catch(() => ({}));
  if (!groupResponse.ok) throw new Error(remoteAdminError(groupResponse.status, groupPayload));
  const groups = extractRemoteItems(groupPayload);
  const group = groups.find((item) => String(item.name || "").toLowerCase() === "china-models");
  if (!group) throw new Error("Sub2API 中不存在分组 China-models，请先创建该分组");
  const createResponse = await fetch(`${adminUsersUrl()}/${encodeURIComponent(accountId)}/api-keys`, { method: "POST", headers: { "x-api-key": sub2api.adminApiKey, "Content-Type": "application/json" }, body: JSON.stringify({ name: `WorkBuddy user ${userId}`, group_id: Number(group.id) }) });
  const createPayload = await createResponse.json().catch(() => ({}));
  let key = String(createPayload?.data?.key || createPayload?.data?.api_key || createPayload?.api_key || createPayload?.key || "");
  if (createResponse.status === 404) {
    const user = await fetchSub2ApiUser(accountId); const password = `WbSync-${randomBytes(18).toString("hex")}-a9`;
    const updateResponse = await fetch(`${adminUsersUrl()}/${encodeURIComponent(accountId)}`, { method: "PUT", headers: { "x-api-key": sub2api.adminApiKey, "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    const updatePayload = await updateResponse.json().catch(() => ({}));
    if (!updateResponse.ok) throw new Error(remoteAdminError(updateResponse.status, updatePayload));
    const base = sub2api.config.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
    const loginResponse = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email, password }) });
    const loginPayload = await loginResponse.json().catch(() => ({}));
    if (!loginResponse.ok) throw new Error(loginPayload.message || "Sub2API 用户登录失败");
    const accessToken = loginPayload.data?.access_token;
    if (!accessToken) throw new Error("Sub2API 登录响应缺少 access_token");
    const keyResponse = await fetch(`${base}/api/v1/keys`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: `WorkBuddy user ${userId}`, group_id: Number(group.id) }) });
    const keyPayload = await keyResponse.json().catch(() => ({}));
    if (!keyResponse.ok) throw new Error(keyPayload.message || keyPayload.error || `创建用户 API Key 失败 (${keyResponse.status})`);
    key = String(keyPayload?.data?.key || keyPayload?.data?.api_key || keyPayload?.api_key || keyPayload?.key || "");
  } else if (!createResponse.ok) {
    throw new Error(remoteAdminError(createResponse.status, createPayload));
  }
  if (!key.startsWith("sk-")) throw new Error("Sub2API 创建 API Key 成功，但没有返回完整 Key");
  const encrypted = encryptSecret(key); let models = []; try { models = await fetchSub2ApiModelsForKey(key); } catch (error) { const message = String(error?.message || error); if (!(message.includes("INSUFFICIENT_BALANCE") || message.includes("余额不足") || message.includes("403"))) throw error; } const now = Date.now() / 1000;
  db.prepare("INSERT INTO sub2api_user_keys (user_id, nonce, ciphertext, tag, api_key_last4, group_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET nonce=excluded.nonce, ciphertext=excluded.ciphertext, tag=excluded.tag, api_key_last4=excluded.api_key_last4, group_id=excluded.group_id, updated_at=excluded.updated_at").run(userId, encrypted.nonce, encrypted.ciphertext, encrypted.tag, key.slice(-4), Number(group.id), now);
  return { apiKeyLast4: key.slice(-4), key, modelCount: models.length };
}
async function setSub2ApiUserEnabled(row, enabled) {
  let accountId = row.sub2api_account_id;
  if (!accountId) { const synced = await syncSub2ApiUser(row); accountId = synced.sub2apiAccountId; }
  const response = await fetch(`${adminUsersUrl()}/${encodeURIComponent(accountId)}`, { method: "PUT", headers: { "x-api-key": sub2api.adminApiKey, "Content-Type": "application/json" }, body: JSON.stringify({ status: enabled ? "active" : "disabled" }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(remoteAdminError(response.status, payload));
  const detail = await fetchSub2ApiUser(accountId);
  const balance = Number.isFinite(Number(detail?.balance)) ? Number(detail.balance) : null;
  const remoteStatus = detail?.status ? String(detail.status) : null;
  const syncedAt = Date.now() / 1000;
  db.prepare("UPDATE users SET status=?, sub2api_balance=?, sub2api_status=?, sub2api_last_sync_at=? WHERE id=?").run(enabled ? "active" : "disabled", balance, remoteStatus, syncedAt, row.id);
  return { userId: row.id, phone: row.phone, email: syncEmail(row.phone), sub2apiAccountId: accountId, created: false, synced: true, error: null, balance, remoteStatus, lastSyncAt: syncedAt };
}
async function syncAllSub2ApiUsers() {
  const rows = db.prepare("SELECT * FROM users ORDER BY id ASC").all();
  const results = [];
  for (const row of rows) {
    try { results.push(await syncSub2ApiUser(row)); } catch (error) { results.push({ userId: row.id, phone: row.phone, email: syncEmail(row.phone), sub2apiAccountId: row.sub2api_account_id || null, created: false, synced: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (request.method === "OPTIONS") return json(response, 204, {});
  if (url.pathname === "/healthz") return json(response, 200, { ok: true, service: "wb-admin-preview" });
  if (["/admin", "/admin/overview", "/admin/features", "/admin/users", "/admin/tokens", "/admin/token-usage", "/admin/sub2api", "/admin/releases", "/admin/recharge", "/admin/settings"].includes(url.pathname)) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return response.end(adminHtml);
  }
  try {
    if (url.pathname === "/api/admin/sms/settings" && request.method === "GET") {
      if (!adminAuthorized(request)) return json(response, 401, { ok: false, error: "未授权" });
      return json(response, 200, { ok: true, data: smsSettingsPayload() });
    }
    if (url.pathname === "/api/admin/sms/settings" && request.method === "PUT") {
      if (!adminAuthorized(request)) return json(response, 401, { ok: false, error: "未授权" });
      const payload = await body(request);
      const existing = smsSettingsRow() || {};
      const secretInput = String(payload.accessKeySecret || "").trim();
      let enc = { nonce: existing.secret_nonce || "", ciphertext: existing.secret_ciphertext || "", tag: existing.secret_tag || "" };
      let hint = existing.key_hint || "";
      if (payload.clearSecret) { enc = { nonce: "", ciphertext: "", tag: "" }; hint = ""; }
      else if (secretInput) { enc = encryptSecret(secretInput); hint = smsSecretHint(secretInput); }
      db.prepare(`INSERT INTO sms_settings (id, enabled, access_key_id, secret_nonce, secret_ciphertext, secret_tag, key_hint, sign_name, template_code, scheme_name, endpoint, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, access_key_id=excluded.access_key_id, secret_nonce=excluded.secret_nonce,
          secret_ciphertext=excluded.secret_ciphertext, secret_tag=excluded.secret_tag, key_hint=excluded.key_hint, sign_name=excluded.sign_name,
          template_code=excluded.template_code, scheme_name=excluded.scheme_name, endpoint=excluded.endpoint, updated_at=excluded.updated_at`)
        .run(payload.enabled ? 1 : 0, String(payload.accessKeyId || "").trim(), enc.nonce, enc.ciphertext, enc.tag, hint,
          String(payload.signName || "").trim(), String(payload.templateCode || "100001").trim() || "100001",
          String(payload.schemeName || "").trim(), String(payload.endpoint || "dypnsapi.aliyuncs.com").trim() || "dypnsapi.aliyuncs.com",
          Math.floor(Date.now() / 1000));
      return json(response, 200, { ok: true, data: smsSettingsPayload() });
    }
    if (url.pathname === "/api/client/auth/sms/send" && request.method === "POST") {
      const payload = await body(request); const phone = normalizePhone(payload.phone);
      if (phone.length < 6 || phone.length > 32) return json(response, 400, { ok: false, error: "手机号格式不正确" });
      const mode = (process.env.WB_SMS_MODE || "").trim();
      const resolvedSms = resolveSmsConfig();
      const config = mode === "dev" ? null : resolvedSms.config;
      if (config) {
        const outId = randomBytes(16).toString("hex");
        let outcome;
        try { outcome = await sendAliyunSmsCode(config, phone, outId, 300); }
        catch (error) { return json(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
        const challengeId = randomBytes(16).toString("hex"); const now = Date.now() / 1000;
        db.prepare("INSERT INTO sms_challenges (challenge_id, phone, code_hash, expires_at, provider, out_id) VALUES (?, ?, ?, ?, ?, ?)").run(challengeId, phone, "", now + 300, "aliyun", outcome.outId || outId);
        return json(response, 200, { ok: true, data: { challengeId, phoneMasked: maskPhone(phone), expiresIn: 300, retryAfter: 60, provider: "aliyun" } });
      }
      if (mode === "production") return json(response, 501, { ok: false, error: resolvedSms.error || "短信服务未配置：请在后台「系统设置 → 阿里云短信登录」填写 AccessKey、签名和模板" });
      const challengeId = randomBytes(16).toString("hex"); const now = Date.now() / 1000;
      db.prepare("INSERT INTO sms_challenges (challenge_id, phone, code_hash, expires_at, provider, out_id) VALUES (?, ?, ?, ?, ?, ?)").run(challengeId, phone, hashSecret("123456"), now + 300, "local", "");
      return json(response, 200, { ok: true, data: { challengeId, phoneMasked: maskPhone(phone), expiresIn: 300, retryAfter: 60, provider: "local", devCode: "123456" } });
    }
    if (url.pathname === "/api/client/auth/sms/login" && request.method === "POST") {
      const payload = await body(request); const phone = normalizePhone(payload.phone);
      const challenge = db.prepare("SELECT * FROM sms_challenges WHERE challenge_id=?").get(payload.challengeId);
      const nowSec = Date.now() / 1000;
      if (!challenge || challenge.phone !== phone || challenge.used_at || challenge.expires_at < nowSec || challenge.attempts >= 5) return json(response, 401, { ok: false, error: "验证码不正确或已经失效" });
      if (String(challenge.provider || "local") === "aliyun") {
        const resolvedSms = resolveSmsConfig();
        const config = resolvedSms.config;
        if (!config) return json(response, 503, { ok: false, error: resolvedSms.error || "短信服务未配置：请在后台「系统设置 → 阿里云短信登录」填写 AccessKey、签名和模板" });
        let passed = false;
        try { passed = await checkAliyunSmsCode(config, phone, String(payload.verifyCode || ""), challenge.out_id || ""); }
        catch (error) { db.prepare("UPDATE sms_challenges SET attempts=attempts+1 WHERE challenge_id=?").run(payload.challengeId); return json(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
        if (!passed) { db.prepare("UPDATE sms_challenges SET attempts=attempts+1 WHERE challenge_id=?").run(payload.challengeId); return json(response, 401, { ok: false, error: "验证码不正确或已经失效" }); }
        db.prepare("UPDATE sms_challenges SET attempts=attempts+1, used_at=? WHERE challenge_id=?").run(nowSec, payload.challengeId);
      } else {
        if (hashSecret(String(payload.verifyCode || "")) !== challenge.code_hash) { db.prepare("UPDATE sms_challenges SET attempts=attempts+1 WHERE challenge_id=?").run(payload.challengeId); return json(response, 401, { ok: false, error: "验证码不正确或已经失效" }); }
        db.prepare("UPDATE sms_challenges SET attempts=attempts+1, used_at=? WHERE challenge_id=?").run(nowSec, payload.challengeId);
      }
      const now = Date.now() / 1000; db.prepare("INSERT INTO users (phone, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?) ON CONFLICT(phone) DO UPDATE SET last_login_at=excluded.last_login_at").run(phone, phone, now, now);
      const user = db.prepare("SELECT * FROM users WHERE phone=?").get(phone);
      if (user.status === "disabled") return json(response, 403, { ok: false, error: "用户已被禁用，请联系管理员" });
      const token = makeSessionToken(); db.prepare("INSERT INTO user_sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)").run(hashSecret(token), user.id, now, now + 30 * 86400);
      let sub2apiSync; try { sub2apiSync = await syncSub2ApiUser(user); } catch (error) { sub2apiSync = { userId: user.id, phone, email: syncEmail(phone), sub2apiAccountId: user.sub2api_account_id || null, created: false, synced: false, error: error instanceof Error ? error.message : String(error) }; }
      const syncedUser = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
      return json(response, 200, { ok: true, data: { sessionToken: token, user: userRow(syncedUser), sub2apiSync } });
    }
    if (url.pathname === "/api/client/auth/me" && request.method === "GET") {
      const auth = authUser(request); return auth ? json(response, 200, { ok: true, data: { user: auth.user } }) : json(response, 401, { ok: false, error: "登录已过期" });
    }
    if (url.pathname === "/api/client/auth/logout" && request.method === "POST") {
      const auth = authUser(request); if (auth) db.prepare("UPDATE user_sessions SET revoked_at=? WHERE token_hash=?").run(Date.now() / 1000, hashSecret(auth.token)); return json(response, 200, { ok: true });
    }
    // ---- 充值（KyrenPay / EasyPay） ----
    if (url.pathname === "/api/client/recharge/config" && request.method === "GET") {
      const config = kyrenpayConfigRow();
      return json(response, 200, { ok: true, data: { enabled: config.enabled, pid: config.enabled ? config.pid : "", apiBase: config.enabled ? config.apiBase : "", plans: loadRechargePlans() } });
    }
    if (url.pathname === "/api/client/recharge/create" && request.method === "POST") {
      const auth = authUser(request); if (!auth) return json(response, 401, { ok: false, error: "请先登录" });
      const config = kyrenpayConfigRow();
      if (!config.enabled) return json(response, 400, { ok: false, error: "支付功能未启用，请联系管理员" });
      const payload = await body(request);
      const amount = Number(payload.amount);
      const type = String(payload.type || "alipay");
      if (!Number.isFinite(amount) || amount < 1 || amount > 4000) return json(response, 400, { ok: false, error: "充值金额需在 1-4000 之间" });
      if (!["alipay", "wxpay", "creditcard", "crypto", "paynow"].includes(type)) return json(response, 400, { ok: false, error: "不支持的支付方式" });
      const { credits } = resolveRechargePlan(amount);
      const outTradeNo = `WB${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString("hex").toUpperCase()}`;
      const now = Date.now() / 1000;
      const callbackBase = kyrenpayCallbackBase(request);
      if (!callbackBase) return json(response, 500, { ok: false, error: "无法确定回调地址，请在后台配置公网回调地址" });
      const notifyUrl = `${callbackBase}/api/client/recharge/notify`;
      // 支付完成后的浏览器跳转地址：优先用客户端传来的自身页面地址（校验 http/https）
      let returnUrl = `${callbackBase}/recharge`;
      if (payload.returnUrl) {
        try { const parsed = new URL(String(payload.returnUrl)); if (parsed.protocol === "http:" || parsed.protocol === "https:") returnUrl = parsed.toString(); } catch { /* 忽略非法地址 */ }
      }
      const clientIp = request.headers["x-forwarded-for"]?.split(",")[0]?.trim() || request.socket?.remoteAddress || "127.0.0.1";
      db.prepare("INSERT INTO recharge_orders (out_trade_no, user_id, amount, credited, type, status, client_ip, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(outTradeNo, auth.user.id, amount, credits, type, "Pending", clientIp, now);
      const order = db.prepare("SELECT * FROM recharge_orders WHERE out_trade_no=?").get(outTradeNo);
      try {
        const result = await kyrenpayRequest("/mapi.php", {
          type, out_trade_no: outTradeNo, notify_url: notifyUrl, return_url: returnUrl,
          name: `WorkBuddy 充值 ${amount} 元`, money: amount.toFixed(2), clientip: clientIp,
        });
        const payUrl = result?.payurl || result?.qrcode || null;
        if (payUrl) db.prepare("UPDATE recharge_orders SET pay_url=? WHERE out_trade_no=?").run(payUrl, outTradeNo);
        const updated = db.prepare("SELECT * FROM recharge_orders WHERE out_trade_no=?").get(outTradeNo);
        return json(response, 200, { ok: true, data: { order: rechargeOrderRow(updated), payUrl, qrcode: result?.qrcode || null, tradeNo: result?.trade_no || null } });
      } catch (error) {
        db.prepare("UPDATE recharge_orders SET status='Failed' WHERE out_trade_no=?").run(outTradeNo);
        return json(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname === "/api/client/recharge/orders" && request.method === "GET") {
      const auth = authUser(request); if (!auth) return json(response, 401, { ok: false, error: "请先登录" });
      const rows = db.prepare("SELECT * FROM recharge_orders WHERE user_id=? ORDER BY id DESC LIMIT 50").all(auth.user.id);
      return json(response, 200, { ok: true, data: { orders: rows.map(rechargeOrderRow) } });
    }
    if (url.pathname === "/api/client/recharge/status" && request.method === "GET") {
      const auth = authUser(request); if (!auth) return json(response, 401, { ok: false, error: "请先登录" });
      const outTradeNo = String(url.searchParams.get("outTradeNo") || "");
      const row = db.prepare("SELECT * FROM recharge_orders WHERE out_trade_no=? AND user_id=?").get(outTradeNo, auth.user.id);
      if (!row) return json(response, 404, { ok: false, error: "订单不存在" });
      return json(response, 200, { ok: true, data: { order: rechargeOrderRow(row) } });
    }
    // 支付回调：KyrenPay -> /epay/api.php 风格 notify，MD5 验签（GET 或 POST）
    if (url.pathname === "/api/client/recharge/notify" && (request.method === "GET" || request.method === "POST")) {
      const config = loadKyrenpay();
      const params = request.method === "GET"
        ? Object.fromEntries(url.searchParams.entries())
        : Object.fromEntries(new URLSearchParams(await rawBody(request)).entries());
      const outTradeNo = String(params.out_trade_no || "");
      const tradeStatus = String(params.trade_status || "").toLowerCase();
      if (!config.configured || !epayVerify(params, config.pkey)) return json(response, 400, "fail");
      const order = db.prepare("SELECT * FROM recharge_orders WHERE out_trade_no=?").get(outTradeNo);
      if (!order) return json(response, 200, "success");
      if (tradeStatus === "trade_success" && order.status !== "Paid" && order.status !== "Credited") {
        await creditRechargeOrder(order, String(params.trade_no || ""));
      }
      return json(response, 200, "success");
    }
    if (url.pathname === "/api/admin/users" && request.method === "GET") {
      const rows = db.prepare("SELECT id, phone, display_name as displayName, sub2api_account_id as sub2apiAccountId, sub2api_balance as sub2apiBalance, sub2api_status as sub2apiStatus, sub2api_last_sync_at as sub2apiLastSyncAt, credits, status, created_at as createdAt, last_login_at as lastLoginAt FROM users ORDER BY last_login_at DESC").all(); return json(response, 200, { ok: true, data: rows });
    }
    const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/(sync|status)$/);
    if (adminUserMatch && request.method === "POST") {
      const row = db.prepare("SELECT * FROM users WHERE id=?").get(Number(adminUserMatch[1]));
      if (!row) return json(response, 404, { ok: false, error: "用户不存在" });
      try {
        const result = adminUserMatch[2] === "sync" ? await syncSub2ApiUser(row) : await setSub2ApiUserEnabled(row, Boolean((await body(request)).enabled));
        return json(response, 200, { ok: true, data: result });
      } catch (error) { return json(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
    }
    const consumptionMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/consumption\/sync$/);
    if (consumptionMatch && request.method === "POST") {
      const row = db.prepare("SELECT * FROM users WHERE id=?").get(Number(consumptionMatch[1]));
      if (!row) return json(response, 404, { ok: false, error: "用户不存在" });
      try { return json(response, 200, { ok: true, data: await syncSub2ApiConsumption(row) }); } catch (error) { return json(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
    }
    if (url.pathname === "/api/admin/sub2api/users/consumption-sync" && request.method === "POST") {
      const rows = db.prepare("SELECT * FROM users WHERE sub2api_account_id IS NOT NULL ORDER BY id ASC").all(); const results = [];
      for (const row of rows) { try { results.push({ ok: true, result: await syncSub2ApiConsumption(row) }); } catch (error) { results.push({ ok: false, userId: row.id, error: error instanceof Error ? error.message : String(error) }); } }
      return json(response, 200, { ok: true, data: { results } });
    }
    const creditHistoryMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/credits\/history$/);
    if (creditHistoryMatch && request.method === "GET") {
      const rows = db.prepare("SELECT id, user_id as userId, delta, balance_after as balanceAfter, type, ref as reference, note, operator, created_at as createdAt FROM credit_ledger WHERE user_id=? ORDER BY id DESC LIMIT 200").all(Number(creditHistoryMatch[1]));
      return json(response, 200, { ok: true, data: { history: rows } });
    }
    const creditAdjustMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/credits$/);
    if (creditAdjustMatch && request.method === "POST") {
      try {
        const payload = await body(request); const row = adjustCredits(Number(creditAdjustMatch[1]), Number(payload.delta), String(payload.type || "manual"), String(payload.reference || ""), String(payload.note || ""), String(payload.operator || "admin"));
        return json(response, 200, { ok: true, data: { user: userRow(row), balance: Number(row.credits || 0) } });
      } catch (error) { return json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
    }
    if (url.pathname === "/api/client/credits" && request.method === "GET") {
      const auth = authUser(request); if (!auth) return json(response, 401, { ok: false, error: "未登录" });
      const history = db.prepare("SELECT id, user_id as userId, delta, balance_after as balanceAfter, type, ref as reference, note, operator, created_at as createdAt FROM credit_ledger WHERE user_id=? ORDER BY id DESC LIMIT 100").all(auth.user.id);
      const row = db.prepare("SELECT credits FROM users WHERE id=?").get(auth.user.id);
      return json(response, 200, { ok: true, data: { credits: Number(row?.credits || 0), history } });
    }
    // 客户端公告（未登录也可读：无敏感信息）
    if (url.pathname === "/api/client/announcement" && request.method === "GET") {
      const row = db.prepare("SELECT value, enabled FROM app_kv WHERE key='app_announcement'").get();
      const announcement = row && row.enabled === 1 ? String(row.value || "") : "";
      return json(response, 200, { ok: true, data: { announcement } });
    }
    // ===== Token 统计：用户列表（含余额与累计消耗）=====
    if (url.pathname === "/api/admin/tokens/users" && request.method === "GET") {
      if (!adminAuthorized(request)) return json(response, 401, { ok: false, error: "需要管理员令牌" });
      try {
        const remoteUsers = await fetchSub2ApiUsers();
        const users = remoteUsers.map(user => ({
          id: remoteUserId(user),
          email: String(user.email || user.username || ""),
          name: String(user.name || user.display_name || ""),
          status: String(user.status || "unknown"),
          balance: Number.isFinite(Number(user.balance ?? user.available_balance)) ? Number(user.balance ?? user.available_balance) : null,
        })).filter(user => user.id);
        const totals = { users: users.length, balance: users.reduce((sum, user) => sum + (user.balance || 0), 0) };
        return json(response, 200, { ok: true, data: { users, totals } });
      } catch (error) {
        return json(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    // ===== Token 统计：单个用户的消耗记录 =====
    const tokenRecordsMatch = url.pathname.match(/^\/api\/admin\/tokens\/users\/([^/]+)\/records$/);
    if (tokenRecordsMatch && request.method === "GET") {
      if (!adminAuthorized(request)) return json(response, 401, { ok: false, error: "需要管理员令牌" });
      try {
        const startDate = String(url.searchParams.get("startDate") || "");
        const endDate = String(url.searchParams.get("endDate") || "");
        if (startDate && endDate && startDate > endDate) return json(response, 400, { ok: false, error: "开始日期不能晚于结束日期" });
        const data = await fetchSub2ApiTokenRecords(decodeURIComponent(tokenRecordsMatch[1]), url.searchParams.get("page"), url.searchParams.get("pageSize"), String(url.searchParams.get("model") || ""), startDate, endDate);
        return json(response, 200, { ok: true, data });
      } catch (error) {
        return json(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname === "/api/admin/tokens/usage/models" && request.method === "GET") {
      if (!adminAuthorized(request)) return json(response, 401, { ok: false, error: "需要管理员令牌" });
      try { return json(response, 200, { ok: true, data: { models: await fetchSub2ApiTokenUsageModels() } }); }
      catch (error) { return json(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
    }
    if (url.pathname === "/api/admin/tokens/usage" && request.method === "GET") {
      if (!adminAuthorized(request)) return json(response, 401, { ok: false, error: "需要管理员令牌" });
      const startDate = String(url.searchParams.get("startDate") || "");
      const endDate = String(url.searchParams.get("endDate") || "");
      if (startDate && endDate && startDate > endDate) return json(response, 400, { ok: false, error: "开始日期不能晚于结束日期" });
      try {
        const data = await fetchSub2ApiTokenUsagePage({
          model: String(url.searchParams.get("model") || ""),
          startDate,
          endDate,
          page: url.searchParams.get("page"),
          pageSize: url.searchParams.get("pageSize"),
        });
        return json(response, 200, { ok: true, data });
      } catch (error) {
        return json(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    // ===== Token 统计：全量同步消耗 =====
    if (url.pathname === "/api/admin/tokens/sync" && request.method === "POST") {
      const rows = db.prepare("SELECT * FROM users WHERE sub2api_account_id IS NOT NULL ORDER BY id ASC").all();
      const results = [];
      for (const row of rows) {
        try { results.push({ ok: true, userId: row.id, result: await syncSub2ApiConsumption(row) }); }
        catch (error) { results.push({ ok: false, userId: row.id, error: error instanceof Error ? error.message : String(error) }); }
      }
      return json(response, 200, { ok: true, data: { results } });
    }

    // 后台公告配置（读/写）。写接口与 Rust 版同口径：
    // Authorization: Bearer <WB_ADMIN_TOKEN>（直传令牌；预览环境未设置时放行为预览模式）。
    if (url.pathname === "/api/admin/announcement" && request.method === "GET") {
      const row = db.prepare("SELECT value, enabled, updated_at as updatedAt FROM app_kv WHERE key='app_announcement'").get();
      return json(response, 200, { ok: true, data: row ? { announcement: String(row.value || ""), enabled: row.enabled === 1, updatedAt: row.updatedAt } : { announcement: "", enabled: false, updatedAt: null } });
    }
    if (url.pathname === "/api/admin/announcement" && request.method === "POST") {
      // 与 Rust 版同口径：Authorization: Bearer <WB_ADMIN_TOKEN>（直传令牌）
      const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
      const expected = process.env.WB_ADMIN_TOKEN || "";
      if (!expected || !bearer || bearer !== expected) return json(response, 401, { ok: false, error: "需要管理员令牌" });
      const payload = await body(request);
      const text = String(payload.announcement ?? "").trim();
      const enabled = payload.enabled === undefined ? true : Boolean(payload.enabled);
      db.prepare("INSERT INTO app_kv (key, value, enabled, updated_at) VALUES ('app_announcement', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, enabled=excluded.enabled, updated_at=excluded.updated_at")
        .run(text.slice(0, 500), enabled ? 1 : 0, Date.now() / 1000);
      return json(response, 200, { ok: true, data: { announcement: text, enabled } });
    }
    if (url.pathname === "/api/telemetry/heartbeat" && request.method === "POST") {
      const payload = await body(request);
      installations.set(payload.installationId, {
        installationId: payload.installationId,
        appVersion: payload.appVersion || "unknown",
        os: payload.os || "unknown",
        arch: payload.arch || "unknown",
        locale: payload.locale || null,
        accountCount: Number(payload.accountCount) || 0,
        firstSeen: Date.now() / 1000,
        lastSeen: Date.now() / 1000,
        activeDays: 1,
      });
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/api/admin/overview" && request.method === "GET") return json(response, 200, { ok: true, data: overview() });
    if (url.pathname === "/api/admin/installations" && request.method === "GET") return json(response, 200, { ok: true, data: [...installations.values()] });
    if (url.pathname === "/api/admin/releases" && request.method === "GET") return json(response, 200, { ok: true, data: releases });
    if (url.pathname === "/api/admin/releases" && request.method === "POST") {
      const payload = await body(request);
      const release = { version: payload.version, channel: payload.channel || "stable", manifestUrl: payload.manifestUrl || "", minSupported: payload.minSupported || "", mandatory: Boolean(payload.mandatory), notes: payload.notes || "", enabled: true, createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000 };
      const index = releases.findIndex((item) => item.version === release.version);
      if (index >= 0) releases[index] = release; else releases.push(release);
      return json(response, 200, { ok: true, data: release });
    }
    if (url.pathname === "/api/admin/sub2api/config" && request.method === "GET") return json(response, 200, { ok: true, data: sub2api.config });
    if (url.pathname === "/api/admin/kyrenpay/config" && request.method === "GET") return json(response, 200, { ok: true, data: kyrenpayConfigRow() });
    if (url.pathname === "/api/admin/kyrenpay/config" && request.method === "POST") {
      const payload = await body(request);
      const config = loadKyrenpay();
      if (payload.apiBase) config.apiBase = String(payload.apiBase).trim().replace(/\/$/, "");
      if (payload.publicBase !== undefined) config.publicBase = String(payload.publicBase || "").trim().replace(/\/$/, "");
      if (payload.pid !== undefined) config.pid = String(payload.pid).trim();
      if (payload.pkey) config.pkey = String(payload.pkey).trim();
      if (payload.enabled !== undefined) config.enabled = Boolean(payload.enabled);
      if (!config.pid || !config.pkey) { config.enabled = false; }
      saveKyrenpay(config);
      return json(response, 200, { ok: true, data: kyrenpayConfigRow() });
    }
    if (url.pathname === "/api/admin/kyrenpay/orders" && request.method === "GET") {
      const rows = db.prepare("SELECT * FROM recharge_orders ORDER BY id DESC LIMIT 200").all();
      return json(response, 200, { ok: true, data: { orders: rows.map(rechargeOrderRow) } });
    }
    if (url.pathname === "/api/admin/recharge/plans" && request.method === "GET") {
      return json(response, 200, { ok: true, data: { plans: loadRechargePlans(true) } });
    }
    if (url.pathname === "/api/admin/recharge/plans" && request.method === "POST") {
      const payload = await body(request);
      const amount = Number(payload.amount);
      const credits = Number(payload.credits);
      if (!Number.isFinite(amount) || amount <= 0) return json(response, 400, { ok: false, error: "价格必须为正数" });
      if (!Number.isFinite(credits) || credits <= 0) return json(response, 400, { ok: false, error: "积分必须为正数" });
      const now = Date.now() / 1000;
      const sortOrder = Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : 999;
      db.prepare("INSERT INTO recharge_plans (amount, credits, label, enabled, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(amount, credits, String(payload.label || ""), payload.enabled === false ? 0 : 1, sortOrder, now, now);
      return json(response, 200, { ok: true, data: { plans: loadRechargePlans(true) } });
    }
    const planMatch = url.pathname.match(/^\/api\/admin\/recharge\/plans\/(\d+)$/);
    if (planMatch && request.method === "PUT") {
      const row = db.prepare("SELECT * FROM recharge_plans WHERE id=?").get(Number(planMatch[1]));
      if (!row) return json(response, 404, { ok: false, error: "套餐不存在" });
      const payload = await body(request);
      if (payload.amount !== undefined) {
        const amount = Number(payload.amount);
        if (!Number.isFinite(amount) || amount <= 0) return json(response, 400, { ok: false, error: "价格必须为正数" });
        row.amount = amount;
      }
      if (payload.credits !== undefined) {
        const credits = Number(payload.credits);
        if (!Number.isFinite(credits) || credits <= 0) return json(response, 400, { ok: false, error: "积分必须为正数" });
        row.credits = credits;
      }
      if (payload.label !== undefined) row.label = String(payload.label || "");
      if (payload.enabled !== undefined) row.enabled = payload.enabled ? 1 : 0;
      if (payload.sortOrder !== undefined && Number.isFinite(Number(payload.sortOrder))) row.sort_order = Number(payload.sortOrder);
      db.prepare("UPDATE recharge_plans SET amount=?, credits=?, label=?, enabled=?, sort_order=?, updated_at=? WHERE id=?")
        .run(row.amount, row.credits, row.label, row.enabled, row.sort_order, Date.now() / 1000, row.id);
      return json(response, 200, { ok: true, data: { plans: loadRechargePlans(true) } });
    }
    if (planMatch && request.method === "DELETE") {
      const result = db.prepare("DELETE FROM recharge_plans WHERE id=?").run(Number(planMatch[1]));
      if (!result.changes) return json(response, 404, { ok: false, error: "套餐不存在" });
      return json(response, 200, { ok: true, data: { plans: loadRechargePlans(true) } });
    }
    if (url.pathname === "/api/admin/sub2api/config" && request.method === "POST") {
      const payload = await body(request);
      sub2api.config = { configured: Boolean(String(payload.baseUrl || "").trim()), baseUrl: String(payload.baseUrl || "").trim(), apiKeyLast4: null, modelCount: sub2api.models.length };
      saveSub2Api();
      return json(response, 200, { ok: true, data: sub2api.config });
    }
    if (url.pathname === "/api/admin/sub2api/admin-config" && request.method === "GET") return json(response, 200, { ok: true, data: sub2api.adminConfig });
    if (url.pathname === "/api/admin/sub2api/admin-config" && request.method === "POST") {
      const payload = await body(request);
      if (!payload.apiKey) return json(response, 400, { ok: false, error: "Sub2API 管理 API Key 不能为空" });
      sub2api.adminApiKey = String(payload.apiKey).trim();
      const encrypted = encryptSecret(sub2api.adminApiKey);
      db.prepare(`INSERT INTO sub2api_admin_config (id, nonce, ciphertext, tag, api_key_last4, updated_at) VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce, ciphertext=excluded.ciphertext, tag=excluded.tag, api_key_last4=excluded.api_key_last4, updated_at=excluded.updated_at`)
        .run(encrypted.nonce, encrypted.ciphertext, encrypted.tag, sub2api.adminApiKey.slice(-4), Date.now() / 1000);
      sub2api.adminConfig = { configured: true, apiKeyLast4: sub2api.adminApiKey.slice(-4), updatedAt: Date.now() / 1000 };
      return json(response, 200, { ok: true, data: sub2api.adminConfig });
    }
    if (url.pathname === "/api/admin/sub2api/users/test" && request.method === "POST") {
      const users = await fetchSub2ApiUsers();
      return json(response, 200, { ok: true, data: { count: users.length } });
    }
    if (url.pathname === "/api/admin/sub2api/users/sync" && request.method === "POST") {
      const results = await syncAllSub2ApiUsers();
      const synced = results.filter((item) => item.synced).length;
      return json(response, 200, { ok: true, data: { results, synced, failed: results.length - synced } });
    }
    if (url.pathname === "/api/admin/sub2api/test" && request.method === "POST") {
      const started = Date.now();
      sub2api.models = await fetchSub2ApiModels();
      sub2api.config.modelCount = sub2api.models.length;
      saveSub2Api();
      return json(response, 200, { ok: true, data: { models: sub2api.models, count: sub2api.models.length, durationMs: Date.now() - started } });
    }
    if (url.pathname === "/api/admin/sub2api/models/refresh" && request.method === "POST") {
      sub2api.models = await fetchSub2ApiModels();
      sub2api.config.modelCount = sub2api.models.length;
      saveSub2Api();
      return json(response, 200, { ok: true, data: { models: sub2api.models, count: sub2api.models.length } });
    }
    if (url.pathname === "/api/admin/model-services" && request.method === "GET") {
      const rows = db.prepare("SELECT id, model_type as modelType, model_id as modelId, display_name as displayName, enabled, created_at as createdAt, updated_at as updatedAt FROM model_services ORDER BY updated_at DESC, id DESC").all();
      return json(response, 200, { ok: true, data: rows });
    }
    if (url.pathname === "/api/admin/model-services" && request.method === "POST") {
      const payload = await body(request);
      const now = Date.now() / 1000;
      const result = db.prepare("INSERT INTO model_services (model_type, model_id, display_name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(String(payload.modelType || "custom"), String(payload.modelId || ""), String(payload.displayName || payload.modelId || ""), payload.enabled === false ? 0 : 1, now, now);
      const row = db.prepare("SELECT id, model_type as modelType, model_id as modelId, display_name as displayName, enabled, created_at as createdAt, updated_at as updatedAt FROM model_services WHERE id=?").get(result.lastInsertRowid);
      return json(response, 200, { ok: true, data: row });
    }
    const modelServiceMatch = url.pathname.match(/^\/api\/admin\/model-services\/(\d+)$/);
    if (modelServiceMatch && request.method === "DELETE") {
      db.prepare("DELETE FROM model_services WHERE id=?").run(Number(modelServiceMatch[1]));
      return json(response, 200, { ok: true });
    }
    if (modelServiceMatch && request.method === "POST") {
      const row = db.prepare("SELECT model_id as modelId FROM model_services WHERE id=?").get(Number(modelServiceMatch[1]));
      if (!row) return json(response, 404, { ok: false, error: "模型服务不存在" });
      const started = Date.now();
      const models = await fetchSub2ApiModels();
      const model = models.find((item) => item.id === row.modelId);
      return json(response, 200, { ok: true, data: { available: Boolean(model), durationMs: Date.now() - started, modelId: row.modelId } });
    }
    if (url.pathname === "/api/client/models" && request.method === "GET") {
      const auth = authUser(request);
      if (auth) {
        const keyRow = db.prepare("SELECT * FROM sub2api_user_keys WHERE user_id=?").get(auth.user.id);
        if (!keyRow) return json(response, 400, { ok: false, error: "当前用户尚未创建 Sub2API API Key，请重新登录或执行用户同步" });
        const models = await fetchSub2ApiModelsForKey(decryptSecret(keyRow));
        return json(response, 200, { ok: true, data: { models: models.map((model) => ({ id: model.id, displayName: model.id, modelType: model.owned_by || "sub2api", object: model.object || "model", enabled: true }),), source: "user-api-key" } });
      }
      let services = db.prepare("SELECT model_id as id, display_name as displayName, model_type as modelType, enabled FROM model_services WHERE enabled=1 ORDER BY updated_at DESC, id DESC").all();
      if (services.length === 0 && sub2api.models.length > 0) {
        const now = Date.now() / 1000;
        const insert = db.prepare("INSERT INTO model_services (model_type, model_id, display_name, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)");
        for (const model of sub2api.models) insert.run(model.ownedBy || "sub2api", model.id, model.id, now, now);
        services = db.prepare("SELECT model_id as id, display_name as displayName, model_type as modelType, enabled FROM model_services WHERE enabled=1 ORDER BY updated_at DESC, id DESC").all();
      }
      return json(response, 200, { ok: true, data: { models: services } });
    }
    if (url.pathname === "/api/client/workbuddy/models" && request.method === "GET") {
      const models = await loadWorkBuddyModels();
      const disabled = await loadDisabledWorkBuddyModels();
      const disabledIds = disabled.map((item) => item.id);
      const disabledPublic = publicWorkBuddyModels(disabled, disabledIds).map((model) => ({ ...model, disabled: true }));
      return json(response, 200, { ok: true, data: { models: [...publicWorkBuddyModels(models, disabledIds), ...disabledPublic], path: workbuddyModelsPath } });
    }
    if (url.pathname === "/api/client/workbuddy/models" && request.method === "POST") {
      const payload = await body(request);
      const current = await loadWorkBuddyModels();
      const auth = authUser(request);
      let endpointUrl = `http://${request.headers.host || "127.0.0.1:57900"}/v1`;
      let userApiKey = null;
      if (auth) {
        const keyRow = db.prepare("SELECT * FROM sub2api_user_keys WHERE user_id=?").get(auth.user.id);
        if (!keyRow) return json(response, 400, { ok: false, error: "当前用户尚未创建 Sub2API API Key" });
        endpointUrl = `${sub2api.config.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/v1`;
        userApiKey = decryptSecret(keyRow);
      }
      for (const input of Array.isArray(payload.models) ? payload.models : []) {
        // 重新导入时保留该 id 已有条目的能力/上限配置，只更新认证与来源标记
        const existing = current.find((item) => item.id === String(input?.id || "").trim()) || null;
        const entry = workBuddyModelEntry(input, endpointUrl, userApiKey, existing);
        if (entry && auth) entry.wbSwitchUserId = auth.user.id;
        if (!entry) continue;
        const index = current.findIndex((item) => item.id === entry.id);
        if (index >= 0) current[index] = entry; else current.push(entry);
      }
      await saveWorkBuddyModels(current);
      const disabled = await loadDisabledWorkBuddyModels();
      const disabledIds = disabled.map((item) => item.id);
      const disabledPublic = publicWorkBuddyModels(disabled, disabledIds).map((model) => ({ ...model, disabled: true }));
      return json(response, 200, { ok: true, data: { models: [...publicWorkBuddyModels(current, disabledIds), ...disabledPublic], path: workbuddyModelsPath, proxyUrl: endpointUrl } });
    }
    if (url.pathname === "/api/client/workbuddy/models/remove" && request.method === "POST") {
      const payload = await body(request);
      const current = await loadWorkBuddyModels();
      const disabled = await loadDisabledWorkBuddyModels();
      const disabledIds = disabled.map((item) => item.id);
      const id = String(payload.id || "").trim();
      const target = current.find((item) => item.id === id);
      if (!target) return json(response, 404, { ok: false, error: "模型不存在于 WorkBuddy 配置" });
      if (target.wbSwitchManaged !== true) return json(response, 400, { ok: false, error: "该模型不是本工具导入的模型，不能删除；可以重新导入接管" });
      const next = current.filter((item) => item.id !== id);
      await saveWorkBuddyModels(next);
      const disabledPublic = publicWorkBuddyModels(disabled, disabledIds).map((model) => ({ ...model, disabled: true }));
      return json(response, 200, { ok: true, data: { models: [...publicWorkBuddyModels(next, disabledIds), ...disabledPublic], path: workbuddyModelsPath } });
    }
    if (url.pathname === "/api/client/workbuddy/models/remove-all" && request.method === "POST") {
      const current = await loadWorkBuddyModels();
      const disabled = await loadDisabledWorkBuddyModels();
      const disabledIds = disabled.map((item) => item.id);
      let removed = 0;
      const next = current.filter((item) => {
        if (item.wbSwitchManaged === true) { removed += 1; return false; }
        return true;
      });
      await saveWorkBuddyModels(next);
      const disabledPublic = publicWorkBuddyModels(disabled, disabledIds).map((model) => ({ ...model, disabled: true }));
      return json(response, 200, { ok: true, data: { models: [...publicWorkBuddyModels(next, disabledIds), ...disabledPublic], removed, path: workbuddyModelsPath } });
    }
    if (url.pathname === "/api/client/workbuddy/models/disable" && request.method === "POST") {
      const payload = await body(request);
      const current = await loadWorkBuddyModels();
      const id = String(payload.id || "").trim();
      const index = current.findIndex((item) => item.id === id);
      if (index < 0) return json(response, 404, { ok: false, error: "模型不存在于 WorkBuddy 配置" });
      const removed = current.splice(index, 1)[0];
      const disabled = await loadDisabledWorkBuddyModels();
      if (!disabled.some((item) => item.id === id)) disabled.push(removed);
      await saveDisabledWorkBuddyModels(disabled);
      await saveWorkBuddyModels(current);
      const disabledIds = disabled.map((item) => item.id);
      const disabledPublic = publicWorkBuddyModels(disabled, disabledIds).map((model) => ({ ...model, disabled: true }));
      return json(response, 200, { ok: true, data: { models: [...publicWorkBuddyModels(current, disabledIds), ...disabledPublic], path: workbuddyModelsPath } });
    }
    if (url.pathname === "/api/client/workbuddy/models/enable" && request.method === "POST") {
      const payload = await body(request);
      const disabled = await loadDisabledWorkBuddyModels();
      const id = String(payload.id || "").trim();
      const index = disabled.findIndex((item) => item.id === id);
      if (index < 0) return json(response, 400, { ok: false, error: "该模型没有被禁用" });
      const restored = disabled.splice(index, 1)[0];
      await saveDisabledWorkBuddyModels(disabled);
      const current = await loadWorkBuddyModels();
      const existing = current.findIndex((item) => item.id === id);
      if (existing >= 0) current[existing] = restored; else current.push(restored);
      await saveWorkBuddyModels(current);
      const disabledIds = disabled.map((item) => item.id);
      const disabledPublic = publicWorkBuddyModels(disabled, disabledIds).map((model) => ({ ...model, disabled: true }));
      return json(response, 200, { ok: true, data: { models: [...publicWorkBuddyModels(current, disabledIds), ...disabledPublic], path: workbuddyModelsPath } });
    }
    // ---- DeepSeek Harness 模型管理 ----
    if (url.pathname === "/api/client/dsh/models" && request.method === "GET") {
      // 参考 WorkBuddy：读取全部 provider 的模型，不只是 wb-switch
      const models = await dshAllModels();
      const disabled = await loadDshDisabled();
      const disabledIds = disabled.map((item) => item.id);
      const active = models.map((model) => ({ ...model, disabled: disabledIds.includes(model.id) }));
      const disabledExtra = disabled
        .filter((item) => !models.some((model) => model.id === item.id))
        .map((model) => ({ id: model.id, name: model.name || model.id, providerName: dshProviderName, managed: model.managed !== false, disabled: true }));
      return json(response, 200, { ok: true, data: { models: [...active, ...disabledExtra], path: dshProfilePatchPath } });
    }
    if (url.pathname === "/api/client/dsh/models" && request.method === "POST") {
      const payload = await body(request);
      const auth = authUser(request);
      let endpointUrl = `${sub2api.config.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/v1`;
      let userApiKey = null;
      if (auth) {
        const keyRow = db.prepare("SELECT * FROM sub2api_user_keys WHERE user_id=?").get(auth.user.id);
        if (!keyRow) return json(response, 400, { ok: false, error: "当前用户尚未创建 Sub2API API Key" });
        userApiKey = decryptSecret(keyRow);
        // DSH 从环境变量 WB_SWITCH_API_KEY 读取密钥，导入时写入用户级环境变量
        // （setx 只影响新启动的进程；正在运行的 DSH 需重启后才能读到）
        if (userApiKey) setWbSwitchApiKeyEnv(userApiKey);
      }
      const doc = await loadDshPatch();
      const entry = await ensureDshEntry(doc);
      const provider = entry.config.providers[dshProviderName] || (entry.config.providers[dshProviderName] = {
        displayName: "WorkBuddy Switch",
        apiKeyEnv: "WB_SWITCH_API_KEY",
        api: "openai-completions",
        baseURL: endpointUrl,
        models: [],
      });
      if (!Array.isArray(provider.models)) provider.models = [];
      const disabled = await loadDshDisabled();
      let added = 0;
      for (const input of Array.isArray(payload.models) ? payload.models : []) {
        const entryModel = dshEntryFromInput(input);
        if (!entryModel) continue;
        const index = provider.models.findIndex((item) => item.id === entryModel.id);
        if (index >= 0) provider.models[index] = { ...provider.models[index], ...entryModel, managed: true };
        else { provider.models.push({ ...entryModel, managed: true }); added += 1; }
        const disabledIndex = disabled.findIndex((item) => item.id === entryModel.id);
        if (disabledIndex >= 0) disabled.splice(disabledIndex, 1);
      }
      await saveDshDisabled(disabled);
      await saveDshPatch(doc);
      const disabledIds = disabled.map((item) => item.id);
      const disabledPublic = disabled.map((model) => ({ ...model, managed: model.managed !== false, disabled: true }));
      return json(response, 200, { ok: true, data: { models: [...publicDshModels(provider.models, disabled), ...disabledPublic], added, path: dshProfilePatchPath } });
    }
    if (url.pathname === "/api/client/dsh/models/remove" && request.method === "POST") {
      const payload = await body(request);
      const id = String(payload.id || "").trim();
      const doc = await loadDshPatch();
      const entry = doc.find((item) => item?.id === "llm-pi-ai");
      const provider = entry?.config?.providers?.[dshProviderName];
      if (!provider || !Array.isArray(provider.models)) return json(response, 404, { ok: false, error: "该模型不存在于 DeepSeek Harness 配置" });
      const index = provider.models.findIndex((item) => item.id === id);
      if (index < 0) return json(response, 404, { ok: false, error: "该模型不存在于 DeepSeek Harness 配置" });
      provider.models.splice(index, 1);
      const disabled = await loadDshDisabled();
      const disabledIndex = disabled.findIndex((item) => item.id === id);
      if (disabledIndex >= 0) disabled.splice(disabledIndex, 1);
      await saveDshDisabled(disabled);
      await saveDshPatch(doc);
      const disabledIds = disabled.map((item) => item.id);
      const disabledPublic = disabled.map((model) => ({ ...model, managed: model.managed !== false, disabled: true }));
      return json(response, 200, { ok: true, data: { models: [...publicDshModels(provider.models, disabled), ...disabledPublic], path: dshProfilePatchPath } });
    }
    if (url.pathname === "/api/client/dsh/models/remove-all" && request.method === "POST") {
      const doc = await loadDshPatch();
      const entry = doc.find((item) => item?.id === "llm-pi-ai");
      const provider = entry?.config?.providers?.[dshProviderName];
      let removed = 0;
      if (provider && Array.isArray(provider.models)) {
        removed = provider.models.length;
        provider.models = [];
      }
      if (provider) delete entry.config.providers[dshProviderName];
      await saveDshDisabled([]);
      await saveDshPatch(doc);
      return json(response, 200, { ok: true, data: { models: [], removed, path: dshProfilePatchPath } });
    }
    if (url.pathname === "/api/client/dsh/models/disable" && request.method === "POST") {
      const payload = await body(request);
      const id = String(payload.id || "").trim();
      const doc = await loadDshPatch();
      const entry = doc.find((item) => item?.id === "llm-pi-ai");
      const provider = entry?.config?.providers?.[dshProviderName];
      if (!provider || !Array.isArray(provider.models)) return json(response, 404, { ok: false, error: "该模型不存在于 DeepSeek Harness 配置" });
      const index = provider.models.findIndex((item) => item.id === id);
      if (index < 0) return json(response, 404, { ok: false, error: "该模型不存在于 DeepSeek Harness 配置" });
      const [removed] = provider.models.splice(index, 1);
      const disabled = await loadDshDisabled();
      if (!disabled.some((item) => item.id === id)) disabled.push(removed);
      await saveDshDisabled(disabled);
      await saveDshPatch(doc);
      const disabledPublic = disabled.map((model) => ({ ...model, managed: model.managed !== false, disabled: true }));
      return json(response, 200, { ok: true, data: { models: [...publicDshModels(provider.models, disabled), ...disabledPublic], path: dshProfilePatchPath } });
    }
    if (url.pathname === "/api/client/dsh/models/enable" && request.method === "POST") {
      const payload = await body(request);
      const id = String(payload.id || "").trim();
      const authEnable = authUser(request);
      if (authEnable) {
        const keyRow = db.prepare("SELECT * FROM sub2api_user_keys WHERE user_id=?").get(authEnable.user.id);
        if (keyRow) { const key = decryptSecret(keyRow); if (key) setWbSwitchApiKeyEnv(key); }
      }
      const disabled = await loadDshDisabled();
      const index = disabled.findIndex((item) => item.id === id);
      if (index < 0) return json(response, 400, { ok: false, error: "该模型没有被禁用" });
      const restored = disabled.splice(index, 1)[0];
      await saveDshDisabled(disabled);
      const doc = await loadDshPatch();
      const entry = await ensureDshEntry(doc);
      const provider = entry.config.providers[dshProviderName] || (entry.config.providers[dshProviderName] = {
        displayName: "WorkBuddy Switch",
        apiKeyEnv: "WB_SWITCH_API_KEY",
        api: "openai-completions",
        baseURL: `${sub2api.config.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/v1`,
        models: [],
      });
      if (!Array.isArray(provider.models)) provider.models = [];
      const existing = provider.models.findIndex((item) => item.id === id);
      if (existing >= 0) provider.models[existing] = restored; else provider.models.push(restored);
      await saveDshPatch(doc);
      const disabledPublic = disabled.map((model) => ({ ...model, managed: model.managed !== false, disabled: true }));
      return json(response, 200, { ok: true, data: { models: [...publicDshModels(provider.models, disabled), ...disabledPublic], path: dshProfilePatchPath } });
    }
    if (url.pathname === "/v1/models" && request.method === "GET") {
      let services = db.prepare("SELECT model_id as id, model_type as owned_by, enabled FROM model_services WHERE enabled=1 ORDER BY updated_at DESC, id DESC").all();
      if (services.length === 0 && sub2api.models.length > 0) {
        services = sub2api.models.map((model) => ({ id: model.id, owned_by: model.ownedBy || "sub2api", enabled: 1 }));
      }
      return json(response, 200, { object: "list", data: services.map((model) => ({ id: model.id, object: "model", owned_by: model.owned_by })) });
    }
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      if (request.headers.authorization !== `Bearer ${localProxyKey}`) return json(response, 401, { error: { message: "WorkBuddy 本地代理凭据无效", type: "invalid_request_error" } });
      if (!sub2api.config.baseUrl || !sub2api.apiKey) return json(response, 503, { error: { message: "尚未配置 Sub2API" } });
      const text = await new Promise((resolve, reject) => { let value = ""; request.on("data", (chunk) => { value += chunk; }); request.on("end", () => resolve(value)); request.on("error", reject); });
      const base = sub2api.config.baseUrl.replace(/\/$/, "");
      const chatUrl = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      const upstream = await fetch(chatUrl, { method: "POST", headers: { Authorization: `Bearer ${sub2api.apiKey}`, "Content-Type": "application/json" }, body: text });
      response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
      if (upstream.body) return Readable.fromWeb(upstream.body).pipe(response);
      return response.end(Buffer.from(await upstream.arrayBuffer()));
    }
    if (url.pathname === "/api/client/models/speed" && request.method === "GET") {
      const started = Date.now();
      const auth = authUser(request);
      if (auth) {
        const keyRow = db.prepare("SELECT * FROM sub2api_user_keys WHERE user_id=?").get(auth.user.id);
        if (!keyRow) return json(response, 400, { ok: false, error: "当前用户尚未创建 Sub2API API Key" });
        const models = await fetchSub2ApiModelsForKey(decryptSecret(keyRow));
        return json(response, 200, { ok: true, data: { count: models.length, durationMs: Date.now() - started, source: "user-api-key" } });
      }
      const models = await fetchSub2ApiModels();
      return json(response, 200, { ok: true, data: { count: models.length, durationMs: Date.now() - started } });
    }
    if (url.pathname === "/" || url.pathname === "/favicon.ico") return response.end();
    return json(response, 404, { ok: false, error: "Not Found" });
  } catch (error) {
    return json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(57900, "0.0.0.0", () => {
  console.log("wb-admin preview: http://127.0.0.1:57900/admin/overview");
  console.log("Preview mode: Sub2API config is persisted in wb-admin-preview.sqlite3; telemetry/release data stays in memory.");
});

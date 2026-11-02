use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use sha2::{Digest, Sha256};

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn utc_day(timestamp: i64) -> String {
    // UTC day key is sufficient for aggregate reporting and avoids a timezone dependency.
    let days = timestamp.div_euclid(86_400);
    format!("day-{days}")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    pub installation_id: String,
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub locale: Option<String>,
    pub account_count: u32,
    pub launch: Option<bool>,
    pub events: Option<std::collections::HashMap<String, u32>>,
}

impl Heartbeat {
    pub fn validate(&self) -> Result<(), String> {
        if self.installation_id.trim().is_empty() || self.installation_id.len() > 128 {
            return Err("installationId 无效".to_string());
        }
        for (name, value) in [
            ("appVersion", &self.app_version),
            ("os", &self.os),
            ("arch", &self.arch),
        ] {
            if value.trim().is_empty() || value.len() > 80 {
                return Err(format!("{name} 无效"));
            }
        }
        if self.account_count > 10_000 {
            return Err("accountCount 超出范围".to_string());
        }
        if let Some(events) = &self.events {
            if events.len() > 64 || events.values().any(|value| *value > 1_000_000) {
                return Err("events 超出范围".to_string());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub total_installations: i64,
    pub active_today: i64,
    pub active_7d: i64,
    pub active_30d: i64,
    pub total_accounts: i64,
    pub average_accounts: f64,
    pub versions: Vec<DistributionRow>,
    pub platforms: Vec<DistributionRow>,
    pub features: Vec<FeatureRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionRow {
    pub key: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureRow {
    pub feature: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationRow {
    pub installation_id: String,
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub locale: Option<String>,
    pub account_count: i64,
    pub first_seen: i64,
    pub last_seen: i64,
    pub active_days: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInput {
    pub version: String,
    pub channel: Option<String>,
    pub manifest_url: Option<String>,
    pub min_supported: Option<String>,
    pub mandatory: Option<bool>,
    pub notes: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseRow {
    pub version: String,
    pub channel: String,
    pub manifest_url: String,
    pub min_supported: String,
    pub mandatory: bool,
    pub notes: String,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct Sub2ApiVaultRecord {
    pub version: u8,
    pub base_url: String,
    pub nonce: String,
    pub ciphertext: String,
    pub api_key_last4: String,
    pub updated_at: i64,
    pub last_refresh_at: Option<i64>,
    pub models_json: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Sub2ApiAdminVaultRecord {
    pub version: u8,
    pub nonce: String,
    pub ciphertext: String,
    pub api_key_last4: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct Sub2ApiUserKeyRecord {
    pub user_id: i64,
    pub nonce: String,
    pub ciphertext: String,
    pub api_key_last4: String,
    pub group_id: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelServiceRecord {
    pub id: i64,
    pub model_type: String,
    pub model_id: String,
    pub display_name: String,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelServiceInput {
    pub model_type: String,
    pub model_id: String,
    pub display_name: String,
    pub enabled: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRecord {
    pub id: i64,
    pub phone: String,
    pub display_name: String,
    pub sub2api_account_id: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub last_login_at: Option<i64>,
    pub sub2api_balance: Option<f64>,
    pub sub2api_status: Option<String>,
    pub sub2api_last_sync_at: Option<i64>,
    pub credits: f64,
    pub sub2api_usage_cost: f64,
    pub sub2api_usage_requests: i64,
    pub sub2api_usage_tokens: i64,
    pub sub2api_usage_last_sync_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditLedgerRecord {
    pub id: i64,
    pub user_id: i64,
    pub delta: f64,
    pub balance_after: f64,
    pub kind: String,
    pub reference: String,
    pub note: String,
    pub operator: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageRecord {
    pub id: i64,
    pub account_id: String,
    pub cost_delta: f64,
    pub cost_total: f64,
    pub requests_delta: i64,
    pub requests_total: i64,
    pub tokens_delta: i64,
    pub tokens_total: i64,
    pub credits_after: f64,
    pub source: String,
    pub note: String,
    pub created_at: i64,
}

/// 一次短信验证码挑战。`provider` 为 `local` 时本地校验 code_hash，
/// 为 `aliyun` 时交由阿里云核销，`out_id` 用于关联阿里云流水。
#[derive(Debug, Clone)]
pub struct SmsChallenge {
    pub phone: String,
    pub code_hash: String,
    pub expires_at: i64,
    pub attempts: i64,
    pub used_at: Option<i64>,
    pub provider: String,
    pub out_id: String,
}

impl SmsChallenge {
    /// 挑战是否仍然可用（未使用、未过期、未超过尝试上限）。
    pub fn is_active(&self, now: i64) -> bool {
        self.used_at.is_none() && self.expires_at >= now && self.attempts < 5
    }
}

/// 后台可配置的短信供应商设置（单行表，`id` 恒为 1）。
/// 密钥只保存 AES-256-GCM 密文与打码提示，接口不回明文。
#[derive(Debug, Clone, Default)]
pub struct SmsSettingsRow {
    pub enabled: bool,
    pub access_key_id: String,
    pub secret_nonce: String,
    pub secret_ciphertext: String,
    pub key_hint: String,
    pub sign_name: String,
    pub template_code: String,
    pub scheme_name: String,
    pub endpoint: String,
    pub updated_at: i64,
}

impl SmsSettingsRow {
    pub fn secret_configured(&self) -> bool {
        !self.secret_ciphertext.is_empty()
    }
}

pub struct AdminStore {
    connection: Mutex<Connection>,
}

impl AdminStore {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|error| {
                rusqlite::Error::ToSqlConversionFailure(Box::new(error))
            })?;
        }
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS installations (
               installation_id TEXT PRIMARY KEY,
               app_version TEXT NOT NULL,
               os TEXT NOT NULL,
               arch TEXT NOT NULL,
               locale TEXT,
               account_count INTEGER NOT NULL DEFAULT 0,
               first_seen INTEGER NOT NULL,
               last_seen INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS usage_days (
               installation_id TEXT NOT NULL,
               day_key TEXT NOT NULL,
               launches INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY (installation_id, day_key),
               FOREIGN KEY (installation_id) REFERENCES installations(installation_id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS feature_events (
               day_key TEXT NOT NULL,
               feature TEXT NOT NULL,
               count INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY (day_key, feature)
             );
             CREATE TABLE IF NOT EXISTS releases (
               version TEXT PRIMARY KEY,
               channel TEXT NOT NULL DEFAULT 'stable',
               manifest_url TEXT NOT NULL DEFAULT '',
               min_supported TEXT NOT NULL DEFAULT '',
               mandatory INTEGER NOT NULL DEFAULT 0,
               notes TEXT NOT NULL DEFAULT '',
               enabled INTEGER NOT NULL DEFAULT 1,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS sub2api_config (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               version INTEGER NOT NULL,
               base_url TEXT NOT NULL,
               nonce TEXT NOT NULL,
               ciphertext TEXT NOT NULL,
               api_key_last4 TEXT NOT NULL,
               updated_at INTEGER NOT NULL,
               last_refresh_at INTEGER,
               models_json TEXT NOT NULL DEFAULT '[]',
               last_error TEXT
             );
             CREATE TABLE IF NOT EXISTS sub2api_admin_config (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               version INTEGER NOT NULL,
               nonce TEXT NOT NULL,
               ciphertext TEXT NOT NULL,
               api_key_last4 TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS sub2api_user_keys (
               user_id INTEGER PRIMARY KEY,
               nonce TEXT NOT NULL,
               ciphertext TEXT NOT NULL,
               api_key_last4 TEXT NOT NULL,
               group_id INTEGER,
               updated_at INTEGER NOT NULL,
               FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS model_services (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               model_type TEXT NOT NULL,
               model_id TEXT NOT NULL,
               display_name TEXT NOT NULL,
               enabled INTEGER NOT NULL DEFAULT 1,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS users (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               phone TEXT NOT NULL UNIQUE,
               display_name TEXT NOT NULL DEFAULT '',
               sub2api_account_id TEXT UNIQUE,
               sub2api_balance REAL,
               sub2api_status TEXT,
               sub2api_last_sync_at INTEGER,
               status TEXT NOT NULL DEFAULT 'active',
               created_at INTEGER NOT NULL,
               last_login_at INTEGER,
               credits REAL NOT NULL DEFAULT 0
               ,sub2api_usage_cost REAL NOT NULL DEFAULT 0
               ,sub2api_usage_requests INTEGER NOT NULL DEFAULT 0
               ,sub2api_usage_tokens INTEGER NOT NULL DEFAULT 0
               ,sub2api_usage_last_sync_at INTEGER
             );
             CREATE TABLE IF NOT EXISTS credit_ledger (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               user_id INTEGER NOT NULL,
               delta REAL NOT NULL,
               balance_after REAL NOT NULL,
               kind TEXT NOT NULL,
               reference TEXT NOT NULL DEFAULT '',
               note TEXT NOT NULL DEFAULT '',
               operator TEXT NOT NULL DEFAULT '',
               created_at INTEGER NOT NULL,
               FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger(user_id, id DESC);
             CREATE TABLE IF NOT EXISTS token_usage_records (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               user_id INTEGER NOT NULL,
               account_id TEXT NOT NULL DEFAULT '',
               cost_delta REAL NOT NULL DEFAULT 0,
               cost_total REAL NOT NULL DEFAULT 0,
               requests_delta INTEGER NOT NULL DEFAULT 0,
               requests_total INTEGER NOT NULL DEFAULT 0,
               tokens_delta INTEGER NOT NULL DEFAULT 0,
               tokens_total INTEGER NOT NULL DEFAULT 0,
               credits_after REAL NOT NULL DEFAULT 0,
               source TEXT NOT NULL DEFAULT 'sub2api_sync',
               note TEXT NOT NULL DEFAULT '',
               created_at INTEGER NOT NULL,
               FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage_records(user_id, id DESC);
             CREATE TABLE IF NOT EXISTS sms_challenges (
               challenge_id TEXT PRIMARY KEY,
               phone TEXT NOT NULL,
               code_hash TEXT NOT NULL,
               expires_at INTEGER NOT NULL,
               attempts INTEGER NOT NULL DEFAULT 0,
               used_at INTEGER,
               provider TEXT NOT NULL DEFAULT 'local',
               out_id TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE IF NOT EXISTS sms_settings (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               enabled INTEGER NOT NULL DEFAULT 1,
               access_key_id TEXT NOT NULL DEFAULT '',
               secret_nonce TEXT NOT NULL DEFAULT '',
               secret_ciphertext TEXT NOT NULL DEFAULT '',
               key_hint TEXT NOT NULL DEFAULT '',
               sign_name TEXT NOT NULL DEFAULT '',
               template_code TEXT NOT NULL DEFAULT '100001',
               scheme_name TEXT NOT NULL DEFAULT '',
               endpoint TEXT NOT NULL DEFAULT 'dypnsapi.aliyuncs.com',
               updated_at INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS user_sessions (
               token_hash TEXT PRIMARY KEY,
               user_id INTEGER NOT NULL,
               created_at INTEGER NOT NULL,
               expires_at INTEGER NOT NULL,
               revoked_at INTEGER,
               FOREIGN KEY(user_id) REFERENCES users(id)
             );",
        )?;
        // Existing preview/production databases were created before the sync snapshot fields.
        for statement in [
            "ALTER TABLE users ADD COLUMN sub2api_balance REAL",
            "ALTER TABLE users ADD COLUMN sub2api_status TEXT",
            "ALTER TABLE users ADD COLUMN sub2api_last_sync_at INTEGER",
            "ALTER TABLE users ADD COLUMN credits REAL NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN sub2api_usage_cost REAL NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN sub2api_usage_requests INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN sub2api_usage_tokens INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN sub2api_usage_last_sync_at INTEGER",
            "ALTER TABLE sms_challenges ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'",
            "ALTER TABLE sms_challenges ADD COLUMN out_id TEXT NOT NULL DEFAULT ''",
        ] {
            let _ = connection.execute(statement, []);
        }
        Ok(Self { connection: Mutex::new(connection) })
    }

    pub fn issue_sms_challenge(&self, phone: &str, code: &str, lifetime_secs: i64) -> rusqlite::Result<String> {
        self.issue_sms_challenge_with(phone, Some(code), lifetime_secs, "local", "")
    }

    /// 记录一次验证码挑战。`code` 为 None 表示验证码由外部供应商生成并核销
    /// （此时 `provider` 记录供应商名、`out_id` 记录供应商流水号）。
    pub fn issue_sms_challenge_with(
        &self,
        phone: &str,
        code: Option<&str>,
        lifetime_secs: i64,
        provider: &str,
        out_id: &str,
    ) -> rusqlite::Result<String> {
        let challenge_id = Uuid::new_v4().to_string();
        let expires_at = now_secs() + lifetime_secs;
        let code_hash = code.map(hash_secret).unwrap_or_default();
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute(
            "INSERT INTO sms_challenges (challenge_id, phone, code_hash, expires_at, provider, out_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![challenge_id, normalize_phone(phone), code_hash, expires_at, provider, out_id],
        )?;
        Ok(challenge_id)
    }

    /// 查询挑战信息：phone、code_hash、expires_at、attempts、used_at、provider、out_id。
    pub fn sms_challenge(&self, challenge_id: &str) -> rusqlite::Result<Option<SmsChallenge>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.query_row(
            "SELECT phone, code_hash, expires_at, attempts, used_at, provider, out_id FROM sms_challenges WHERE challenge_id=?1",
            [challenge_id],
            |row| Ok(SmsChallenge {
                phone: row.get(0)?,
                code_hash: row.get(1)?,
                expires_at: row.get(2)?,
                attempts: row.get(3)?,
                used_at: row.get(4)?,
                provider: row.get(5)?,
                out_id: row.get(6)?,
            }),
        ).optional()
    }

    /// 结算挑战：`passed` 为 true 时标记已使用，否则仅累计尝试次数。
    pub fn finish_sms_challenge(&self, challenge_id: &str, passed: bool) -> rusqlite::Result<()> {
        let now = now_secs();
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute("UPDATE sms_challenges SET attempts=attempts+1, used_at=CASE WHEN ?2 THEN ?3 ELSE used_at END WHERE challenge_id=?1", params![challenge_id, passed, now])?;
        Ok(())
    }

    /// 读取后台保存的短信供应商设置。
    pub fn load_sms_settings(&self) -> rusqlite::Result<Option<SmsSettingsRow>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.query_row(
            "SELECT enabled, access_key_id, secret_nonce, secret_ciphertext, key_hint, sign_name, template_code, scheme_name, endpoint, updated_at FROM sms_settings WHERE id=1",
            [],
            |row| Ok(SmsSettingsRow {
                enabled: row.get::<_, i64>(0)? != 0,
                access_key_id: row.get(1)?,
                secret_nonce: row.get(2)?,
                secret_ciphertext: row.get(3)?,
                key_hint: row.get(4)?,
                sign_name: row.get(5)?,
                template_code: row.get(6)?,
                scheme_name: row.get(7)?,
                endpoint: row.get(8)?,
                updated_at: row.get(9)?,
            }),
        ).optional()
    }

    /// 保存短信供应商设置（覆盖单行记录）。
    pub fn save_sms_settings(&self, row: &SmsSettingsRow) -> rusqlite::Result<()> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute(
            "INSERT INTO sms_settings (id, enabled, access_key_id, secret_nonce, secret_ciphertext, key_hint, sign_name, template_code, scheme_name, endpoint, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, access_key_id=excluded.access_key_id,
               secret_nonce=excluded.secret_nonce, secret_ciphertext=excluded.secret_ciphertext, key_hint=excluded.key_hint,
               sign_name=excluded.sign_name, template_code=excluded.template_code, scheme_name=excluded.scheme_name,
               endpoint=excluded.endpoint, updated_at=excluded.updated_at",
            params![
                row.enabled as i64,
                row.access_key_id,
                row.secret_nonce,
                row.secret_ciphertext,
                row.key_hint,
                row.sign_name,
                row.template_code,
                row.scheme_name,
                row.endpoint,
                row.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn verify_sms_challenge(&self, challenge_id: &str, phone: &str, code: &str) -> rusqlite::Result<bool> {
        let now = now_secs();
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        let row = connection.query_row(
            "SELECT phone, code_hash, expires_at, attempts, used_at FROM sms_challenges WHERE challenge_id=?1",
            [challenge_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?, row.get::<_, Option<i64>>(4)?)),
        ).optional()?;
        let Some((saved_phone, code_hash, expires_at, attempts, used_at)) = row else { return Ok(false); };
        if normalize_phone(phone) != saved_phone || used_at.is_some() || expires_at < now || attempts >= 5 {
            return Ok(false);
        }
        let passed = hash_secret(code) == code_hash;
        connection.execute("UPDATE sms_challenges SET attempts=attempts+1, used_at=CASE WHEN ?2 THEN ?3 ELSE used_at END WHERE challenge_id=?1", params![challenge_id, passed, now])?;
        Ok(passed)
    }

    pub fn create_user_session(&self, phone: &str, session_token: &str, lifetime_secs: i64) -> rusqlite::Result<UserRecord> {
        let now = now_secs();
        let phone = normalize_phone(phone);
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute(
            "INSERT INTO users (phone, display_name, created_at, last_login_at) VALUES (?1, ?1, ?2, ?2)
             ON CONFLICT(phone) DO UPDATE SET last_login_at=excluded.last_login_at",
            params![phone, now],
        )?;
        let user_id: i64 = connection.query_row("SELECT id FROM users WHERE phone=?1", [&phone], |row| row.get(0))?;
        connection.execute("INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)", params![hash_secret(session_token), user_id, now, now + lifetime_secs])?;
        user_by_id(&connection, user_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn user_by_token(&self, token: &str) -> rusqlite::Result<Option<UserRecord>> {
        let now = now_secs();
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        let user_id = connection.query_row("SELECT user_id FROM user_sessions WHERE token_hash=?1 AND revoked_at IS NULL AND expires_at > ?2", params![hash_secret(token), now], |row| row.get::<_, i64>(0)).optional()?;
        let Some(user_id) = user_id else { return Ok(None); };
        user_by_id(&connection, user_id)
    }

    pub fn revoke_session(&self, token: &str) -> rusqlite::Result<()> {
        self.connection.lock().expect("admin db mutex poisoned").execute("UPDATE user_sessions SET revoked_at=?2 WHERE token_hash=?1", params![hash_secret(token), now_secs()])?;
        Ok(())
    }

    pub fn list_users(&self) -> rusqlite::Result<Vec<UserRecord>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        let mut statement = connection.prepare("SELECT id, phone, display_name, sub2api_account_id, status, created_at, last_login_at, sub2api_balance, sub2api_status, sub2api_last_sync_at, credits, sub2api_usage_cost, sub2api_usage_requests, sub2api_usage_tokens, sub2api_usage_last_sync_at FROM users ORDER BY last_login_at DESC NULLS LAST, id DESC")?;
        let rows = statement.query_map([], user_row)?;
        rows.collect()
    }

    pub fn bind_user_sub2api(&self, user_id: i64, account_id: Option<&str>) -> rusqlite::Result<Option<UserRecord>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute("UPDATE users SET sub2api_account_id=?1 WHERE id=?2", params![account_id, user_id])?;
        user_by_id(&connection, user_id)
    }

    pub fn user_by_id(&self, user_id: i64) -> rusqlite::Result<Option<UserRecord>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        user_by_id(&connection, user_id)
    }

    pub fn save_sub2api_snapshot(&self, user_id: i64, balance: Option<f64>, remote_status: Option<&str>) -> rusqlite::Result<Option<UserRecord>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute(
            "UPDATE users SET sub2api_balance=?1, sub2api_status=?2, sub2api_last_sync_at=?3 WHERE id=?4",
            params![balance, remote_status, now_secs(), user_id],
        )?;
        user_by_id(&connection, user_id)
    }

    pub fn set_user_status(&self, user_id: i64, status: &str) -> rusqlite::Result<Option<UserRecord>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute("UPDATE users SET status=?1 WHERE id=?2", params![status, user_id])?;
        user_by_id(&connection, user_id)
    }

    pub fn adjust_credits(&self, user_id: i64, delta: f64, kind: &str, reference: &str, note: &str, operator: &str) -> rusqlite::Result<Option<UserRecord>> {
        let mut connection = self.connection.lock().expect("admin db mutex poisoned");
        let transaction = connection.transaction()?;
        let current: Option<f64> = transaction.query_row("SELECT credits FROM users WHERE id=?1", [user_id], |row| row.get(0)).optional()?;
        let Some(current) = current else { return Ok(None); };
        let next = current + delta;
        if next < 0.0 { return Err(rusqlite::Error::InvalidParameterName("积分不能为负数".to_string())); }
        let now = now_secs();
        transaction.execute("UPDATE users SET credits=?1 WHERE id=?2", params![next, user_id])?;
        transaction.execute("INSERT INTO credit_ledger (user_id, delta, balance_after, kind, reference, note, operator, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)", params![user_id, delta, next, kind, reference, note, operator, now])?;
        transaction.commit()?;
        user_by_id(&connection, user_id)
    }

    pub fn credit_history(&self, user_id: i64, limit: u32) -> rusqlite::Result<Vec<CreditLedgerRecord>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        let mut statement = connection.prepare("SELECT id, user_id, delta, balance_after, kind, reference, note, operator, created_at FROM credit_ledger WHERE user_id=?1 ORDER BY id DESC LIMIT ?2")?;
        let rows = statement.query_map(params![user_id, limit.min(500)], |row| Ok(CreditLedgerRecord {
            id: row.get(0)?, user_id: row.get(1)?, delta: row.get(2)?, balance_after: row.get(3)?, kind: row.get(4)?, reference: row.get(5)?, note: row.get(6)?, operator: row.get(7)?, created_at: row.get(8)?,
        }))?;
        rows.collect()
    }

    pub fn insert_token_usage_record(&self, record: &TokenUsageRecord, user_id: i64) -> rusqlite::Result<()> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute(
            "INSERT INTO token_usage_records (user_id, account_id, cost_delta, cost_total,
             requests_delta, requests_total, tokens_delta, tokens_total, credits_after, source, note, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![user_id, record.account_id, record.cost_delta, record.cost_total,
                record.requests_delta, record.requests_total, record.tokens_delta, record.tokens_total,
                record.credits_after, record.source, record.note, record.created_at],
        )?;
        Ok(())
    }

    pub fn save_sub2api_usage_snapshot(&self, user_id: i64, cost: f64, requests: i64, tokens: i64) -> rusqlite::Result<Option<UserRecord>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute("UPDATE users SET sub2api_usage_cost=?1, sub2api_usage_requests=?2, sub2api_usage_tokens=?3, sub2api_usage_last_sync_at=?4 WHERE id=?5", params![cost, requests, tokens, now_secs(), user_id])?;
        user_by_id(&connection, user_id)
    }

    pub fn load_sub2api_user_key(&self, user_id: i64) -> rusqlite::Result<Option<Sub2ApiUserKeyRecord>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.query_row(
            "SELECT user_id, nonce, ciphertext, api_key_last4, group_id, updated_at FROM sub2api_user_keys WHERE user_id=?1",
            [user_id],
            |row| Ok(Sub2ApiUserKeyRecord {
                user_id: row.get(0)?, nonce: row.get(1)?, ciphertext: row.get(2)?, api_key_last4: row.get(3)?, group_id: row.get(4)?, updated_at: row.get(5)?,
            }),
        ).optional()
    }

    pub fn save_sub2api_user_key(&self, record: &Sub2ApiUserKeyRecord) -> rusqlite::Result<()> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute(
            "INSERT INTO sub2api_user_keys (user_id, nonce, ciphertext, api_key_last4, group_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(user_id) DO UPDATE SET nonce=excluded.nonce, ciphertext=excluded.ciphertext,
               api_key_last4=excluded.api_key_last4, group_id=excluded.group_id, updated_at=excluded.updated_at",
            params![record.user_id, record.nonce, record.ciphertext, record.api_key_last4, record.group_id, record.updated_at],
        )?;
        Ok(())
    }

    pub fn load_sub2api_vault(&self) -> rusqlite::Result<Option<Sub2ApiVaultRecord>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection
            .query_row(
                "SELECT version, base_url, nonce, ciphertext, api_key_last4, updated_at, last_refresh_at, models_json, last_error FROM sub2api_config WHERE id=1",
                [],
                |row| {
                    Ok(Sub2ApiVaultRecord {
                        version: row.get::<_, i64>(0)? as u8,
                        base_url: row.get(1)?,
                        nonce: row.get(2)?,
                        ciphertext: row.get(3)?,
                        api_key_last4: row.get(4)?,
                        updated_at: row.get(5)?,
                        last_refresh_at: row.get(6)?,
                        models_json: row.get(7)?,
                        last_error: row.get(8)?,
                    })
                },
            )
            .optional()
    }

    pub fn save_sub2api_vault(&self, record: &Sub2ApiVaultRecord) -> rusqlite::Result<()> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute(
            "INSERT INTO sub2api_config (id, version, base_url, nonce, ciphertext, api_key_last4, updated_at, last_refresh_at, models_json, last_error)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET version=excluded.version, base_url=excluded.base_url, nonce=excluded.nonce,
               ciphertext=excluded.ciphertext, api_key_last4=excluded.api_key_last4, updated_at=excluded.updated_at,
               last_refresh_at=excluded.last_refresh_at, models_json=excluded.models_json, last_error=excluded.last_error",
            params![
                record.version as i64,
                record.base_url,
                record.nonce,
                record.ciphertext,
                record.api_key_last4,
                record.updated_at,
                record.last_refresh_at,
                record.models_json,
                record.last_error,
            ],
        )?;
        Ok(())
    }

    pub fn load_sub2api_admin_vault(&self) -> rusqlite::Result<Option<Sub2ApiAdminVaultRecord>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.query_row(
            "SELECT version, nonce, ciphertext, api_key_last4, updated_at FROM sub2api_admin_config WHERE id=1",
            [],
            |row| Ok(Sub2ApiAdminVaultRecord {
                version: row.get::<_, i64>(0)? as u8,
                nonce: row.get(1)?,
                ciphertext: row.get(2)?,
                api_key_last4: row.get(3)?,
                updated_at: row.get(4)?,
            }),
        ).optional()
    }

    pub fn save_sub2api_admin_vault(&self, record: &Sub2ApiAdminVaultRecord) -> rusqlite::Result<()> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute(
            "INSERT INTO sub2api_admin_config (id, version, nonce, ciphertext, api_key_last4, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET version=excluded.version, nonce=excluded.nonce,
               ciphertext=excluded.ciphertext, api_key_last4=excluded.api_key_last4, updated_at=excluded.updated_at",
            params![record.version as i64, record.nonce, record.ciphertext, record.api_key_last4, record.updated_at],
        )?;
        Ok(())
    }

    pub fn record_heartbeat(&self, heartbeat: &Heartbeat) -> rusqlite::Result<()> {
        let now = now_secs();
        let day = utc_day(now);
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute(
            "INSERT INTO installations (installation_id, app_version, os, arch, locale, account_count, first_seen, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(installation_id) DO UPDATE SET
               app_version=excluded.app_version, os=excluded.os, arch=excluded.arch,
               locale=excluded.locale, account_count=excluded.account_count, last_seen=excluded.last_seen",
            params![
                heartbeat.installation_id.trim(),
                heartbeat.app_version.trim(),
                heartbeat.os.trim(),
                heartbeat.arch.trim(),
                heartbeat.locale.as_deref().map(str::trim),
                heartbeat.account_count as i64,
                now,
            ],
        )?;
        if heartbeat.launch.unwrap_or(true) {
            connection.execute(
                "INSERT INTO usage_days (installation_id, day_key, launches) VALUES (?1, ?2, 1)
                 ON CONFLICT(installation_id, day_key) DO UPDATE SET launches=launches+1",
                params![heartbeat.installation_id.trim(), day],
            )?;
        } else {
            connection.execute(
                "INSERT INTO usage_days (installation_id, day_key, launches) VALUES (?1, ?2, 0)
                 ON CONFLICT(installation_id, day_key) DO NOTHING",
                params![heartbeat.installation_id.trim(), day],
            )?;
        }
        if let Some(events) = &heartbeat.events {
            for (feature, count) in events {
                if feature.trim().is_empty() || feature.len() > 80 {
                    continue;
                }
                connection.execute(
                    "INSERT INTO feature_events (day_key, feature, count) VALUES (?1, ?2, ?3)
                     ON CONFLICT(day_key, feature) DO UPDATE SET count=count+excluded.count",
                    params![day, feature.trim(), *count as i64],
                )?;
            }
        }
        Ok(())
    }

    pub fn list_model_services(&self) -> rusqlite::Result<Vec<ModelServiceRecord>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT id, model_type, model_id, display_name, enabled, created_at, updated_at
             FROM model_services ORDER BY updated_at DESC, id DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(ModelServiceRecord {
                id: row.get(0)?,
                model_type: row.get(1)?,
                model_id: row.get(2)?,
                display_name: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn add_model_service(&self, input: &ModelServiceInput) -> rusqlite::Result<ModelServiceRecord> {
        let now = now_secs();
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute(
            "INSERT INTO model_services (model_type, model_id, display_name, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                input.model_type.trim(),
                input.model_id.trim(),
                input.display_name.trim(),
                input.enabled.unwrap_or(true) as i64,
                now,
            ],
        )?;
        let id = connection.last_insert_rowid();
        connection.query_row(
            "SELECT id, model_type, model_id, display_name, enabled, created_at, updated_at FROM model_services WHERE id=?1",
            [id],
            |row| Ok(ModelServiceRecord {
                id: row.get(0)?, model_type: row.get(1)?, model_id: row.get(2)?, display_name: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0, created_at: row.get(5)?, updated_at: row.get(6)?,
            }),
        )
    }

    pub fn delete_model_service(&self, id: i64) -> rusqlite::Result<bool> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        Ok(connection.execute("DELETE FROM model_services WHERE id=?1", [id])? > 0)
    }

    pub fn overview(&self) -> rusqlite::Result<Overview> {
        let now = now_secs();
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        let total_installations = connection.query_row("SELECT COUNT(*) FROM installations", [], |row| row.get(0))?;
        let active_today = active_since(&connection, now - 86_400)?;
        let active_7d = active_since(&connection, now - 7 * 86_400)?;
        let active_30d = active_since(&connection, now - 30 * 86_400)?;
        let total_accounts = connection.query_row("SELECT COALESCE(SUM(account_count), 0) FROM installations", [], |row| row.get(0))?;
        let average_accounts = if total_installations == 0 { 0.0 } else { total_accounts as f64 / total_installations as f64 };
        Ok(Overview {
            total_installations,
            active_today,
            active_7d,
            active_30d,
            total_accounts,
            average_accounts,
            versions: distribution(&connection, "app_version")?,
            platforms: distribution_platforms(&connection)?,
            features: features_since(&connection, utc_day(now - 30 * 86_400))?,
        })
    }

    pub fn installations(&self, limit: u32) -> rusqlite::Result<Vec<InstallationRow>> {
        let limit = i64::from(limit.clamp(1, 500));
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT installation_id, app_version, os, arch, locale, account_count, first_seen, last_seen,
                    (SELECT COUNT(*) FROM usage_days u WHERE u.installation_id=i.installation_id)
             FROM installations i ORDER BY last_seen DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit], |row| {
            Ok(InstallationRow {
                installation_id: row.get(0)?,
                app_version: row.get(1)?,
                os: row.get(2)?,
                arch: row.get(3)?,
                locale: row.get(4)?,
                account_count: row.get(5)?,
                first_seen: row.get(6)?,
                last_seen: row.get(7)?,
                active_days: row.get(8)?,
            })
        })?;
        rows.collect()
    }

    pub fn upsert_release(&self, input: &ReleaseInput) -> rusqlite::Result<ReleaseRow> {
        let now = now_secs();
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        connection.execute(
            "INSERT INTO releases (version, channel, manifest_url, min_supported, mandatory, notes, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT(version) DO UPDATE SET channel=excluded.channel, manifest_url=excluded.manifest_url,
               min_supported=excluded.min_supported, mandatory=excluded.mandatory, notes=excluded.notes,
               enabled=excluded.enabled, updated_at=excluded.updated_at",
            params![
                input.version.trim(),
                input.channel.as_deref().unwrap_or("stable"),
                input.manifest_url.as_deref().unwrap_or(""),
                input.min_supported.as_deref().unwrap_or(""),
                input.mandatory.unwrap_or(false) as i64,
                input.notes.as_deref().unwrap_or(""),
                input.enabled.unwrap_or(true) as i64,
                now,
            ],
        )?;
        release_by_version(&connection, input.version.trim())?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn releases(&self) -> rusqlite::Result<Vec<ReleaseRow>> {
        let connection = self.connection.lock().expect("admin db mutex poisoned");
        let mut statement = connection.prepare(
            "SELECT version, channel, manifest_url, min_supported, mandatory, notes, enabled, created_at, updated_at
             FROM releases ORDER BY updated_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(ReleaseRow {
                version: row.get(0)?,
                channel: row.get(1)?,
                manifest_url: row.get(2)?,
                min_supported: row.get(3)?,
                mandatory: row.get::<_, i64>(4)? != 0,
                notes: row.get(5)?,
                enabled: row.get::<_, i64>(6)? != 0,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        rows.collect()
    }
}

fn active_since(connection: &Connection, since: i64) -> rusqlite::Result<i64> {
    connection.query_row("SELECT COUNT(*) FROM installations WHERE last_seen >= ?1", [since], |row| row.get(0))
}

fn distribution(connection: &Connection, field: &str) -> rusqlite::Result<Vec<DistributionRow>> {
    // Field is selected from a fixed internal allowlist only.
    let sql = match field {
        "app_version" => "SELECT app_version, COUNT(*) FROM installations GROUP BY app_version ORDER BY COUNT(*) DESC, app_version",
        _ => return Ok(Vec::new()),
    };
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], |row| Ok(DistributionRow { key: row.get(0)?, count: row.get(1)? }))?;
    rows.collect()
}

fn distribution_platforms(connection: &Connection) -> rusqlite::Result<Vec<DistributionRow>> {
    let mut statement = connection.prepare("SELECT os || '/' || arch, COUNT(*) FROM installations GROUP BY os, arch ORDER BY COUNT(*) DESC")?;
    let rows = statement.query_map([], |row| Ok(DistributionRow { key: row.get(0)?, count: row.get(1)? }))?;
    rows.collect()
}

fn features_since(connection: &Connection, day: String) -> rusqlite::Result<Vec<FeatureRow>> {
    let mut statement = connection.prepare("SELECT feature, SUM(count) FROM feature_events WHERE day_key >= ?1 GROUP BY feature ORDER BY SUM(count) DESC LIMIT 20")?;
    let rows = statement.query_map([day], |row| Ok(FeatureRow { feature: row.get(0)?, count: row.get(1)? }))?;
    rows.collect()
}

fn release_by_version(connection: &Connection, version: &str) -> rusqlite::Result<Option<ReleaseRow>> {
    connection
        .query_row(
            "SELECT version, channel, manifest_url, min_supported, mandatory, notes, enabled, created_at, updated_at FROM releases WHERE version=?1",
            [version],
            |row| {
                Ok(ReleaseRow {
                    version: row.get(0)?,
                    channel: row.get(1)?,
                    manifest_url: row.get(2)?,
                    min_supported: row.get(3)?,
                    mandatory: row.get::<_, i64>(4)? != 0,
                    notes: row.get(5)?,
                    enabled: row.get::<_, i64>(6)? != 0,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .optional()
}

pub fn ok_json<T: Serialize>(value: T) -> Value {
    json!({ "ok": true, "data": value })
}

/// 只保留数字和 `+`，用于手机号统一比较。
pub fn normalize_phone(phone: &str) -> String {
    phone.chars().filter(|character| character.is_ascii_digit() || *character == '+').collect()
}

fn hash_secret(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn user_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserRecord> {
    Ok(UserRecord {
        id: row.get(0)?,
        phone: row.get(1)?,
        display_name: row.get(2)?,
        sub2api_account_id: row.get(3)?,
        status: row.get(4)?,
        created_at: row.get(5)?,
        last_login_at: row.get(6)?,
        sub2api_balance: row.get(7)?,
        sub2api_status: row.get(8)?,
        sub2api_last_sync_at: row.get(9)?,
        credits: row.get(10)?,
        sub2api_usage_cost: row.get(11)?,
        sub2api_usage_requests: row.get(12)?,
        sub2api_usage_tokens: row.get(13)?,
        sub2api_usage_last_sync_at: row.get(14)?,
    })
}

fn user_by_id(connection: &Connection, id: i64) -> rusqlite::Result<Option<UserRecord>> {
    connection.query_row(
        "SELECT id, phone, display_name, sub2api_account_id, status, created_at, last_login_at, sub2api_balance, sub2api_status, sub2api_last_sync_at, credits, sub2api_usage_cost, sub2api_usage_requests, sub2api_usage_tokens, sub2api_usage_last_sync_at FROM users WHERE id=?1",
        [id],
        user_row,
    ).optional()
}

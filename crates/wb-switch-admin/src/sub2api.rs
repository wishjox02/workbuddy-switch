use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::RngCore;
use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;
use url::Url;

use crate::store::{AdminStore, Sub2ApiAdminVaultRecord, Sub2ApiUserKeyRecord, Sub2ApiVaultRecord, UserRecord};

const VAULT_VERSION: u8 = 1;
const ADMIN_VAULT_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelItem {
    pub id: String,
    pub object: Option<String>,
    pub owned_by: Option<String>,
    pub created: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig {
    pub configured: bool,
    pub base_url: String,
    pub api_key_last4: Option<String>,
    pub updated_at: Option<i64>,
    pub last_refresh_at: Option<i64>,
    pub model_count: usize,
    pub last_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInput {
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicAdminConfig {
    pub configured: bool,
    pub api_key_last4: Option<String>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSyncResult {
    pub user_id: i64,
    pub phone: String,
    pub email: String,
    pub sub2api_account_id: Option<String>,
    pub created: bool,
    pub synced: bool,
    pub error: Option<String>,
    pub balance: Option<f64>,
    pub remote_status: Option<String>,
    pub last_sync_at: Option<i64>,
    pub api_key_last4: Option<String>,
    pub api_key_ready: bool,
    pub model_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumptionSyncResult {
    pub user_id: i64,
    pub sub2api_user_id: String,
    pub usage_cost: f64,
    pub usage_requests: i64,
    pub usage_tokens: i64,
    pub consumed_delta: f64,
    pub credits_after: f64,
    pub sub2api_balance_target: f64,
    pub synced_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    version: u8,
    base_url: String,
    nonce: String,
    ciphertext: String,
    api_key_last4: String,
    updated_at: i64,
    last_refresh_at: Option<i64>,
    models: Vec<ModelItem>,
    last_error: Option<String>,
}

pub struct Sub2ApiService {
    store: Arc<AdminStore>,
    master_key: [u8; 32],
    client: Client,
}

impl Sub2ApiService {
    pub fn from_env(store: Arc<AdminStore>) -> Result<Self, String> {
        let raw_key = std::env::var("WB_ADMIN_MASTER_KEY")
            .map_err(|_| "未设置 WB_ADMIN_MASTER_KEY（需要 32 字节 base64 或 64 位 hex 密钥）".to_string())?;
        let master_key = decode_master_key(&raw_key)?;
        let client = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|error| format!("创建 Sub2API HTTP 客户端失败：{error}"))?;
        Ok(Self { store, master_key, client })
    }

    pub fn public_config(&self) -> Result<PublicConfig, String> {
        let vault = self.load()?;
        Ok(match vault {
            Some(vault) => PublicConfig {
                configured: true,
                base_url: vault.base_url,
                api_key_last4: None,
                updated_at: Some(vault.updated_at),
                last_refresh_at: vault.last_refresh_at,
                model_count: vault.models.len(),
                last_error: vault.last_error,
            },
            None => PublicConfig {
                configured: false,
                base_url: String::new(),
                api_key_last4: None,
                updated_at: None,
                last_refresh_at: None,
                model_count: 0,
                last_error: None,
            },
        })
    }

    pub fn cached_models(&self) -> Result<Vec<ModelItem>, String> {
        Ok(self.load()?.map(|vault| vault.models).unwrap_or_default())
    }

    pub fn public_admin_config(&self) -> Result<PublicAdminConfig, String> {
        let record = self.store.load_sub2api_admin_vault()
            .map_err(|error| format!("读取 Sub2API 管理密钥配置失败：{error}"))?;
        Ok(match record {
            Some(record) => PublicAdminConfig {
                configured: true,
                api_key_last4: Some(record.api_key_last4),
                updated_at: Some(record.updated_at),
            },
            None => PublicAdminConfig { configured: false, api_key_last4: None, updated_at: None },
        })
    }

    pub fn save_admin_config(&self, api_key: &str) -> Result<PublicAdminConfig, String> {
        let api_key = api_key.trim();
        if api_key.is_empty() || api_key.len() > 4096 {
            return Err("Sub2API 管理 API Key 不能为空或过长".to_string());
        }
        let (nonce, ciphertext) = encrypt(&self.master_key, api_key.as_bytes())?;
        let last4 = api_key.chars().rev().take(4).collect::<String>().chars().rev().collect();
        self.store.save_sub2api_admin_vault(&Sub2ApiAdminVaultRecord {
            version: ADMIN_VAULT_VERSION,
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
            api_key_last4: last4,
            updated_at: now_secs(),
        }).map_err(|error| format!("保存 Sub2API 管理密钥失败：{error}"))?;
        self.public_admin_config()
    }

    pub async fn test_admin_connection(&self) -> Result<usize, String> {
        Ok(self.list_admin_users().await?.len())
    }

    pub async fn token_users(&self) -> Result<Vec<Value>, String> {
        let mut users = Vec::new();
        for remote in self.list_admin_users().await? {
            let Some(id) = user_id(&remote) else { continue; };
            users.push(serde_json::json!({
                "id": id,
                "email": remote.get("email").or_else(|| remote.get("username")).and_then(Value::as_str).unwrap_or(""),
                "name": remote.get("name").or_else(|| remote.get("display_name")).and_then(Value::as_str).unwrap_or(""),
                "status": remote.get("status").and_then(Value::as_str).unwrap_or("unknown"),
                "balance": number_value(remote.get("balance").or_else(|| remote.get("available_balance"))),
            }));
        }
        Ok(users)
    }

    pub async fn token_user_usage_records(&self, account_id: &str, model: Option<&str>, start_date: Option<&str>, end_date: Option<&str>, page: u32, page_size: u32) -> Result<Value, String> {
        let admin_key = self.decrypt_admin_key()?;
        let base_url = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?.base_url;
        let user = self.get_admin_user(&admin_key, account_id).await?;
        let page = page.max(1);
        let page_size = page_size.clamp(1, 100);
        let mut url = Url::parse(&admin_usage_url(&base_url)).map_err(|_| "Sub2API 用量接口地址无效".to_string())?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("user_id", account_id).append_pair("page", &page.to_string()).append_pair("page_size", &page_size.to_string());
            if let Some(model) = model.filter(|value| !value.trim().is_empty()) { query.append_pair("model", model.trim()); }
            if let Some(start_date) = start_date.filter(|value| !value.trim().is_empty()) { query.append_pair("start_date", start_date.trim()); }
            if let Some(end_date) = end_date.filter(|value| !value.trim().is_empty()) { query.append_pair("end_date", end_date.trim()); }
        }
        let records_response = self.client.get(url).header("x-api-key", &admin_key).header(header::ACCEPT, "application/json").send().await
            .map_err(|error| format!("读取 Sub2API 用量记录失败：{error}"))?;
        let records_status = records_response.status();
        let records_value: Value = records_response.json().await.map_err(|error| format!("解析 Sub2API 用量记录失败：{error}"))?;
        if !records_status.is_success() { return Err(admin_api_error(records_status, &records_value)); }
        let envelope = records_value.get("data").unwrap_or(&records_value);
        let records = extract_items(&records_value);
        let total = envelope.get("total").or_else(|| records_value.get("total")).and_then(Value::as_u64).unwrap_or(records.len() as u64);

        let user = user.get("user").unwrap_or(&user);
        let records = records.into_iter().map(|record| serde_json::json!({
            "id": record.get("id"),
            "model": record.get("model").or_else(|| record.get("model_name")),
            "prompt_tokens": record.get("prompt_tokens").or_else(|| record.get("input_tokens")),
            "completion_tokens": record.get("completion_tokens").or_else(|| record.get("output_tokens")),
            "total_tokens": record.get("total_tokens"),
            "actual_cost": record.get("actual_cost").or_else(|| record.get("cost")),
            "created_at": record.get("created_at").or_else(|| record.get("createdAt")),
            "status_code": record.get("status_code").or_else(|| record.get("statusCode")),
            "request_type": record.get("request_type").or_else(|| record.get("requestType")),
        })).collect::<Vec<_>>();
        let mut stats_url = Url::parse(&format!("{}/stats", admin_usage_url(&base_url))).map_err(|_| "Sub2API 用量统计接口地址无效".to_string())?;
        {
            let mut query = stats_url.query_pairs_mut();
            query.append_pair("user_id", account_id);
            if let Some(model) = model.filter(|value| !value.trim().is_empty()) { query.append_pair("model", model.trim()); }
            if let Some(start_date) = start_date.filter(|value| !value.trim().is_empty()) { query.append_pair("start_date", start_date.trim()); }
            if let Some(end_date) = end_date.filter(|value| !value.trim().is_empty()) { query.append_pair("end_date", end_date.trim()); }
        }
        let stats_response = self.client.get(stats_url).header("x-api-key", &admin_key).header(header::ACCEPT, "application/json").send().await
            .map_err(|error| format!("读取 Sub2API 用户消耗统计失败：{error}"))?;
        let stats_status = stats_response.status();
        let stats_value: Value = stats_response.json().await.map_err(|error| format!("解析 Sub2API 用户消耗统计失败：{error}"))?;
        if !stats_status.is_success() { return Err(admin_api_error(stats_status, &stats_value)); }
        let stats = stats_value.get("data").cloned().unwrap_or(stats_value);
        Ok(serde_json::json!({
            "user": {
                "id": account_id,
                "email": user.get("email").and_then(Value::as_str).unwrap_or(""),
                "name": user.get("name").or_else(|| user.get("display_name")).and_then(Value::as_str).unwrap_or(""),
                "status": user.get("status").and_then(Value::as_str).unwrap_or("unknown"),
                "balance": number_value(user.get("balance").or_else(|| user.get("available_balance"))),
            },
            "usage": stats,
            "records": records,
            "page": page,
            "pageSize": page_size,
            "total": total,
        }))
    }

    pub async fn token_usage_page(&self, model: Option<&str>, start_date: Option<&str>, end_date: Option<&str>, page: u32, page_size: u32) -> Result<Value, String> {
        let admin_key = self.decrypt_admin_key()?;
        let base_url = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?.base_url;
        let page = page.max(1);
        let page_size = page_size.clamp(1, 100);
        let mut logs_url = Url::parse(&admin_usage_url(&base_url)).map_err(|_| "Sub2API 用量接口地址无效".to_string())?;
        {
            let mut query = logs_url.query_pairs_mut();
            query.append_pair("page", &page.to_string()).append_pair("page_size", &page_size.to_string());
            if let Some(model) = model.filter(|value| !value.trim().is_empty()) { query.append_pair("model", model.trim()); }
            if let Some(start_date) = start_date.filter(|value| !value.trim().is_empty()) { query.append_pair("start_date", start_date.trim()); }
            if let Some(end_date) = end_date.filter(|value| !value.trim().is_empty()) { query.append_pair("end_date", end_date.trim()); }
        }
        let logs_response = self.client.get(logs_url).header("x-api-key", &admin_key).header(header::ACCEPT, "application/json").send().await
            .map_err(|error| format!("读取 Sub2API 消耗记录失败：{error}"))?;
        let logs_status = logs_response.status();
        let logs_value: Value = logs_response.json().await.map_err(|error| format!("解析 Sub2API 消耗记录失败：{error}"))?;
        if !logs_status.is_success() { return Err(admin_api_error(logs_status, &logs_value)); }
        let envelope = logs_value.get("data").unwrap_or(&logs_value);
        let records = extract_items(&logs_value).into_iter().map(|record| serde_json::json!({
            "id": record.get("id"),
            "user_id": record.get("user_id").or_else(|| record.get("userId")),
            "user_email": record.get("user_email").or_else(|| record.get("email")),
            "model": record.get("model").or_else(|| record.get("model_name")),
            "prompt_tokens": record.get("prompt_tokens").or_else(|| record.get("input_tokens")),
            "completion_tokens": record.get("completion_tokens").or_else(|| record.get("output_tokens")),
            "total_tokens": record.get("total_tokens"),
            "actual_cost": record.get("actual_cost").or_else(|| record.get("cost")),
            "created_at": record.get("created_at").or_else(|| record.get("createdAt")),
            "status_code": record.get("status_code").or_else(|| record.get("statusCode")),
            "request_type": record.get("request_type").or_else(|| record.get("requestType")),
        })).collect::<Vec<_>>();
        let total = envelope.get("total").or_else(|| envelope.get("total_count")).and_then(Value::as_u64).unwrap_or(records.len() as u64);

        let mut stats_url = Url::parse(&format!("{}/stats", admin_usage_url(&base_url))).map_err(|_| "Sub2API 用量统计接口地址无效".to_string())?;
        {
            let mut query = stats_url.query_pairs_mut();
            if let Some(model) = model.filter(|value| !value.trim().is_empty()) { query.append_pair("model", model.trim()); }
            if let Some(start_date) = start_date.filter(|value| !value.trim().is_empty()) { query.append_pair("start_date", start_date.trim()); }
            if let Some(end_date) = end_date.filter(|value| !value.trim().is_empty()) { query.append_pair("end_date", end_date.trim()); }
        }
        let stats_response = self.client.get(stats_url).header("x-api-key", &admin_key).header(header::ACCEPT, "application/json").send().await
            .map_err(|error| format!("读取 Sub2API 消耗统计失败：{error}"))?;
        let stats_status = stats_response.status();
        let stats_value: Value = stats_response.json().await.map_err(|error| format!("解析 Sub2API 消耗统计失败：{error}"))?;
        if !stats_status.is_success() { return Err(admin_api_error(stats_status, &stats_value)); }

        Ok(serde_json::json!({
            "records": records,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "stats": stats_value.get("data").cloned().unwrap_or(stats_value),
        }))
    }

    pub async fn token_usage_models(&self) -> Result<Vec<String>, String> {
        let admin_key = self.decrypt_admin_key()?;
        let base_url = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?.base_url;
        let url = admin_dashboard_models_url(&base_url);
        let response = self.client.get(url).header("x-api-key", &admin_key).header(header::ACCEPT, "application/json").send().await
            .map_err(|error| format!("读取 Sub2API 模型用量列表失败：{error}"))?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|error| format!("解析 Sub2API 模型用量列表失败：{error}"))?;
        if !status.is_success() { return Err(admin_api_error(status, &value)); }
        let data = value.get("data").unwrap_or(&value);
        let models = data.get("models").and_then(Value::as_array).or_else(|| data.as_array()).cloned().unwrap_or_default();
        let mut names = models.into_iter().filter_map(|model| model.get("model").or_else(|| model.get("name")).or_else(|| model.get("id")).and_then(Value::as_str).map(str::to_string)).collect::<Vec<_>>();
        names.sort_unstable();
        names.dedup();
        Ok(names)
    }

    pub async fn sync_all_users(&self) -> Result<Vec<UserSyncResult>, String> {
        let users = self.store.list_users().map_err(|error| format!("读取本地用户失败：{error}"))?;
        let mut results = Vec::with_capacity(users.len());
        for user in users {
            match self.sync_user(&user).await {
                Ok(result) => results.push(result),
                Err(error) => results.push(UserSyncResult {
                    user_id: user.id,
                    phone: user.phone.clone(),
                    email: sync_email(&user.phone),
                    sub2api_account_id: user.sub2api_account_id.clone(),
                    created: false,
                    synced: false,
                    error: Some(error),
                    balance: user.sub2api_balance,
                    remote_status: user.sub2api_status.clone(),
                    last_sync_at: user.sub2api_last_sync_at,
                    api_key_last4: None,
                    api_key_ready: false,
                    model_count: 0,
                }),
            }
        }
        Ok(results)
    }

    pub async fn sync_user_after_login(&self, user: &UserRecord) -> UserSyncResult {
        match self.sync_user(user).await {
            Ok(result) => result,
            Err(error) => UserSyncResult {
                user_id: user.id,
                phone: user.phone.clone(),
                email: sync_email(&user.phone),
                sub2api_account_id: user.sub2api_account_id.clone(),
                created: false,
                synced: false,
                error: Some(error),
                balance: user.sub2api_balance,
                remote_status: user.sub2api_status.clone(),
                last_sync_at: user.sub2api_last_sync_at,
                api_key_last4: None,
                api_key_ready: false,
                model_count: 0,
            },
        }
    }

    async fn sync_user(&self, user: &UserRecord) -> Result<UserSyncResult, String> {
        let email = sync_email(&user.phone);
        let admin_key = self.decrypt_admin_key()?;
        let existing = self.find_admin_user(&admin_key, &email).await?;
        let (account_id, created) = match existing {
            Some(id) => (id, false),
            None => (self.create_admin_user(&admin_key, &email).await?, true),
        };
        let saved = self.store.bind_user_sub2api(user.id, Some(&account_id))
            .map_err(|error| format!("保存本地用户绑定关系失败：{error}"))?;
        if saved.is_none() {
            return Err("本地用户不存在，无法保存 Sub2API 绑定关系".to_string());
        }
        let remote = self.get_admin_user(&admin_key, &account_id).await?;
        let balance = remote.get("balance").and_then(Value::as_f64);
        let remote_status = remote.get("status").and_then(Value::as_str).map(str::to_string);
        self.store.save_sub2api_snapshot(user.id, balance, remote_status.as_deref()).map_err(|error| error.to_string())?;
        if matches!(remote_status.as_deref(), Some("active" | "disabled")) {
            self.store.set_user_status(user.id, remote_status.as_deref().unwrap_or("active")).map_err(|error| error.to_string())?;
        }
        let saved = self.store.user_by_id(user.id).map_err(|error| error.to_string())?
            .ok_or_else(|| "本地用户不存在，无法保存 Sub2API 余额".to_string())?;
        let (api_key_last4, api_key_ready, model_count) = self.ensure_user_api_key(user.id, &account_id).await?;
        Ok(UserSyncResult {
            user_id: user.id,
            phone: user.phone.clone(),
            email,
            sub2api_account_id: Some(account_id),
            created,
            synced: true,
            error: None,
            balance: saved.sub2api_balance,
            remote_status: saved.sub2api_status,
            last_sync_at: saved.sub2api_last_sync_at,
            api_key_last4: Some(api_key_last4),
            api_key_ready,
            model_count,
        })
    }

    pub async fn set_user_enabled(&self, user: &UserRecord, enabled: bool) -> Result<UserSyncResult, String> {
        let admin_key = self.decrypt_admin_key()?;
        let account_id = if let Some(id) = user.sub2api_account_id.clone() {
            id
        } else {
            let synced = self.sync_user(user).await?;
            synced.sub2api_account_id.ok_or_else(|| "用户尚未绑定 Sub2API 账号".to_string())?
        };
        let base_url = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?.base_url;
        let response = self.client.put(admin_user_url(&base_url, &account_id))
            .header("x-api-key", &admin_key)
            .header(header::CONTENT_TYPE, "application/json")
            .json(&serde_json::json!({ "status": if enabled { "active" } else { "disabled" } }))
            .send().await.map_err(|error| format!("更新 Sub2API 用户状态失败：{error}"))?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|error| format!("解析 Sub2API 用户状态响应失败：{error}"))?;
        if !status.is_success() { return Err(admin_api_error(status, &value)); }
        let remote = self.get_admin_user(&admin_key, &account_id).await?;
        let balance = remote.get("balance").and_then(Value::as_f64);
        let remote_status = remote.get("status").and_then(Value::as_str).map(str::to_string);
        self.store.save_sub2api_snapshot(user.id, balance, remote_status.as_deref()).map_err(|error| error.to_string())?;
        let saved = self.store.set_user_status(user.id, if enabled { "active" } else { "disabled" }).map_err(|error| error.to_string())?
            .ok_or_else(|| "本地用户不存在，无法保存本地状态".to_string())?;
        Ok(UserSyncResult {
            user_id: saved.id,
            phone: saved.phone.clone(),
            email: sync_email(&saved.phone),
            sub2api_account_id: saved.sub2api_account_id.clone(),
            created: false,
            synced: true,
            error: None,
            balance: saved.sub2api_balance,
            remote_status: saved.sub2api_status.clone(),
            last_sync_at: saved.sub2api_last_sync_at,
            api_key_last4: self.store.load_sub2api_user_key(saved.id).ok().flatten().map(|key| key.api_key_last4),
            api_key_ready: self.store.load_sub2api_user_key(saved.id).ok().flatten().is_some(),
            model_count: 0,
        })
    }

    async fn get_admin_user(&self, admin_key: &str, account_id: &str) -> Result<Value, String> {
        let base_url = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?.base_url;
        let response = self.client.get(admin_user_url(&base_url, account_id))
            .header("x-api-key", admin_key).header(header::ACCEPT, "application/json").send().await
            .map_err(|error| format!("读取 Sub2API 用户详情失败：{error}"))?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|error| format!("解析 Sub2API 用户详情失败：{error}"))?;
        if !status.is_success() { return Err(admin_api_error(status, &value)); }
        Ok(value.get("data").cloned().unwrap_or(value))
    }

    pub async fn user_models(&self, user: &UserRecord) -> Result<Vec<ModelItem>, String> {
        let key = self.decrypt_user_key(user.id)?;
        self.fetch_models_with_key(&key).await
    }

    pub async fn user_models_speed(&self, user: &UserRecord) -> Result<(Vec<ModelItem>, u128), String> {
        let started = Instant::now();
        let models = self.user_models(user).await?;
        Ok((models, started.elapsed().as_millis()))
    }

    pub async fn sync_user_consumption(&self, user: &UserRecord) -> Result<ConsumptionSyncResult, String> {
        let account_id = user.sub2api_account_id.clone().ok_or_else(|| "用户尚未绑定 Sub2API 账号".to_string())?;
        let admin_key = self.decrypt_admin_key()?;
        let base_url = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?.base_url;
        let response = self.client.get(format!("{}/usage", admin_user_url(&base_url, &account_id)))
            .header("x-api-key", &admin_key).header(header::ACCEPT, "application/json").send().await
            .map_err(|error| format!("读取 Sub2API 用户消费失败：{error}"))?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|error| format!("解析 Sub2API 用户消费失败：{error}"))?;
        if !status.is_success() { return Err(admin_api_error(status, &value)); }
        let data = value.get("data").unwrap_or(&value);
        let usage_cost = number_value(data.get("total_cost").or_else(|| data.get("totalCost"))).ok_or_else(|| "Sub2API 用量响应缺少 total_cost".to_string())?;
        let usage_requests = number_value(data.get("total_requests").or_else(|| data.get("totalRequests"))).unwrap_or(0.0) as i64;
        let usage_tokens = number_value(data.get("total_tokens").or_else(|| data.get("totalTokens"))).unwrap_or(0.0) as i64;
        let consumed_delta = (usage_cost - user.sub2api_usage_cost).max(0.0);
        if consumed_delta > 0.0 {
            self.store.adjust_credits(user.id, -consumed_delta, "sub2api_usage", &format!("sub2api:{account_id}:{usage_cost:.8}"), "同步 Sub2API 消费", "sub2api")
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "用户不存在".to_string())?;
        }
        let updated = self.store.save_sub2api_usage_snapshot(user.id, usage_cost, usage_requests, usage_tokens).map_err(|error| error.to_string())?.ok_or_else(|| "保存消费快照失败".to_string())?;
        if consumed_delta > 0.0
            || usage_requests > user.sub2api_usage_requests
            || usage_tokens > user.sub2api_usage_tokens
        {
            let record = crate::store::TokenUsageRecord {
                id: 0,
                account_id: account_id.clone(),
                cost_delta: consumed_delta,
                cost_total: usage_cost,
                requests_delta: (usage_requests - user.sub2api_usage_requests).max(0),
                requests_total: usage_requests,
                tokens_delta: (usage_tokens - user.sub2api_usage_tokens).max(0),
                tokens_total: usage_tokens,
                credits_after: updated.credits,
                source: "sub2api_sync".to_string(),
                note: "同步 Sub2API 消费".to_string(),
                created_at: now_secs(),
            };
            if let Err(error) = self.store.insert_token_usage_record(&record, user.id) {
                eprintln!("记录用户 {} 的 Token 消耗失败：{error}", user.id);
            }
        }
        let target_balance = if updated.credits > 0.0 { 99_999_999.0 } else { 0.0 };
        self.set_sub2api_balance(&admin_key, &base_url, &account_id, target_balance).await?;
        Ok(ConsumptionSyncResult {
            user_id: user.id, sub2api_user_id: account_id, usage_cost, usage_requests, usage_tokens, consumed_delta, credits_after: updated.credits, sub2api_balance_target: target_balance, synced_at: now_secs(),
        })
    }

    async fn set_sub2api_balance(&self, admin_key: &str, base_url: &str, account_id: &str, balance: f64) -> Result<(), String> {
        let (amount, operation) = if balance <= 0.0 {
            let current = self.get_admin_user(admin_key, account_id).await?
                .get("balance").and_then(Value::as_f64).unwrap_or(0.0);
            if current <= 0.0 { return Ok(()); }
            (current, "subtract")
        } else {
            (balance, "set")
        };
        let response = self.client.post(format!("{}/balance", admin_user_url(base_url, account_id)))
            .header("x-api-key", admin_key).header(header::CONTENT_TYPE, "application/json")
            .header("Idempotency-Key", format!("wb-credit-sync-{account_id}-{}", now_secs()))
            .json(&serde_json::json!({ "balance": amount, "operation": operation, "notes": "WorkBuddy 消费积分同步" })).send().await
            .map_err(|error| format!("同步 Sub2API 用户余额失败：{error}"))?;
        let status = response.status();
        let value: Value = response.json().await.unwrap_or_else(|_| serde_json::json!({}));
        if !status.is_success() { return Err(admin_api_error(status, &value)); }
        Ok(())
    }

    pub fn user_api_key(&self, user_id: i64) -> Result<String, String> {
        self.decrypt_user_key(user_id)
    }

    async fn ensure_user_api_key(&self, user_id: i64, account_id: &str) -> Result<(String, bool, usize), String> {
        if let Some(record) = self.store.load_sub2api_user_key(user_id).map_err(|error| format!("读取用户 API Key 失败：{error}"))? {
            let key = self.decrypt_user_key(user_id)?;
            let model_count = match self.fetch_models_with_key(&key).await {
                Ok(models) => models.len(),
                Err(error) if error.contains("余额不足") || error.contains("INSUFFICIENT_BALANCE") => 0,
                Err(error) => return Err(error),
            };
            return Ok((record.api_key_last4, true, model_count));
        }
        let admin_key = self.decrypt_admin_key()?;
        let group_id = self.resolve_group_id(&admin_key, "China-models").await?;
        let base_url = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?.base_url;
        let response = self.client.post(format!("{}/{}", admin_user_url(&base_url, account_id), "api-keys"))
            .header("x-api-key", &admin_key)
            .header(header::CONTENT_TYPE, "application/json")
            .json(&serde_json::json!({ "name": format!("WorkBuddy user {user_id}"), "group_id": group_id }))
            .send().await.map_err(|error| format!("创建 Sub2API 用户 API Key 失败：{error}"))?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|error| format!("解析 Sub2API 用户 API Key 响应失败：{error}"))?;
        let api_key = if status == reqwest::StatusCode::NOT_FOUND {
            self.create_user_api_key_via_login(&admin_key, account_id, group_id).await?
        } else {
            if !status.is_success() { return Err(api_key_creation_error(status, &value)); }
            extract_api_key(&value).ok_or_else(|| "Sub2API 创建 API Key 成功，但响应未返回完整 Key；请检查 Sub2API 版本".to_string())?
        };
        let last4 = api_key.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>();
        let (nonce, ciphertext) = encrypt(&self.master_key, api_key.as_bytes())?;
        self.store.save_sub2api_user_key(&Sub2ApiUserKeyRecord {
            user_id, nonce: BASE64.encode(nonce), ciphertext: BASE64.encode(ciphertext), api_key_last4: last4.clone(), group_id: Some(group_id), updated_at: now_secs(),
        }).map_err(|error| format!("保存用户 API Key 失败：{error}"))?;
        let model_count = match self.fetch_models_with_key(&api_key).await {
            Ok(models) => models.len(),
            Err(error) if error.contains("余额不足") || error.contains("INSUFFICIENT_BALANCE") => 0,
            Err(error) => return Err(error),
        };
        Ok((last4, true, model_count))
    }

    async fn create_user_api_key_via_login(&self, admin_key: &str, account_id: &str, group_id: i64) -> Result<String, String> {
        let base_url = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?.base_url;
        let user = self.get_admin_user(admin_key, account_id).await?;
        let email = user.get("email").and_then(Value::as_str).ok_or_else(|| "Sub2API 用户详情缺少 email".to_string())?;
        let password = format!("WbSync-{}-a9", uuid::Uuid::new_v4().simple());
        let update = self.client.put(admin_user_url(&base_url, account_id))
            .header("x-api-key", admin_key).header(header::CONTENT_TYPE, "application/json")
            .json(&serde_json::json!({ "password": password })).send().await
            .map_err(|error| format!("准备 Sub2API 用户登录凭据失败：{error}"))?;
        let update_status = update.status();
        let update_value: Value = update.json().await.unwrap_or_else(|_| serde_json::json!({}));
        if !update_status.is_success() { return Err(admin_api_error(update_status, &update_value)); }
        let login = self.client.post(auth_login_url(&base_url))
            .header(header::CONTENT_TYPE, "application/json")
            .json(&serde_json::json!({ "email": email, "password": password })).send().await
            .map_err(|error| format!("Sub2API 用户登录失败：{error}"))?;
        let login_status = login.status();
        let login_value: Value = login.json().await.map_err(|error| format!("解析 Sub2API 用户登录响应失败：{error}"))?;
        if !login_status.is_success() { return Err(format!("Sub2API 用户登录失败：{}", login_value.get("message").and_then(Value::as_str).unwrap_or("请求失败"))); }
        let token = login_value.get("data").and_then(|data| data.get("access_token")).and_then(Value::as_str).ok_or_else(|| "Sub2API 登录响应缺少 access_token".to_string())?;
        let key_response = self.client.post(keys_url(&base_url))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .json(&serde_json::json!({ "name": format!("WorkBuddy {account_id}"), "group_id": group_id }))
            .send().await.map_err(|error| format!("创建 Sub2API 用户 API Key 失败：{error}"))?;
        let key_status = key_response.status();
        let key_value: Value = key_response.json().await.map_err(|error| format!("解析 Sub2API 用户 API Key 响应失败：{error}"))?;
        if !key_status.is_success() { return Err(api_key_creation_error(key_status, &key_value)); }
        extract_api_key(&key_value).ok_or_else(|| "Sub2API 用户 API Key 创建成功，但响应未返回完整 Key".to_string())
    }

    async fn resolve_group_id(&self, admin_key: &str, wanted: &str) -> Result<i64, String> {
        let base_url = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?.base_url;
        let response = self.client.get(admin_groups_url(&base_url)).header("x-api-key", admin_key).header(header::ACCEPT, "application/json").send().await
            .map_err(|error| format!("读取 Sub2API 分组失败：{error}"))?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|error| format!("解析 Sub2API 分组失败：{error}"))?;
        if !status.is_success() { return Err(admin_api_error(status, &value)); }
        for group in extract_items(&value) {
            if group.get("name").and_then(Value::as_str).map(|name| name.eq_ignore_ascii_case(wanted)).unwrap_or(false) {
                if let Some(id) = value_to_i64(group.get("id")) { return Ok(id); }
            }
        }
        Err(format!("Sub2API 中不存在分组 {wanted}，请先创建该分组"))
    }

    async fn list_admin_users(&self) -> Result<Vec<Value>, String> {
        let key = self.decrypt_admin_key()?;
        self.list_admin_users_with_key(&key).await
    }

    async fn list_admin_users_with_key(&self, admin_key: &str) -> Result<Vec<Value>, String> {
        let base_url = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?.base_url;
        let mut users = Vec::new();
        let mut seen = HashSet::new();
        for page in 1..=1000_u32 {
            let mut url = Url::parse(&admin_users_url(&base_url)).map_err(|_| "Sub2API 管理接口地址无效".to_string())?;
            url.query_pairs_mut().append_pair("page", &page.to_string()).append_pair("page_size", "100");
            let response = self.client.get(url).header("x-api-key", admin_key).header(header::ACCEPT, "application/json").send().await
                .map_err(|error| format!("连接 Sub2API 管理接口失败：{error}"))?;
            let status = response.status();
            let value: Value = response.json().await.map_err(|error| format!("解析 Sub2API 用户响应失败：{error}"))?;
            if !status.is_success() { return Err(admin_api_error(status, &value)); }
            let items = extract_items(&value);
            let item_count = items.len();
            let mut added = 0;
            for user in items {
                let key = user_id(&user).unwrap_or_else(|| format!("page:{page}:index:{added}"));
                if seen.insert(key) {
                    users.push(user);
                    added += 1;
                }
            }
            if item_count < 100 || added == 0 { break; }
        }
        Ok(users)
    }

    async fn find_admin_user(&self, admin_key: &str, email: &str) -> Result<Option<String>, String> {
        let users = self.list_admin_users_with_key(admin_key).await?;
        Ok(users.into_iter().find_map(|user| {
            let matches = user.get("email").and_then(Value::as_str).map(|value| value.eq_ignore_ascii_case(email)).unwrap_or(false);
            matches.then(|| user_id(&user)).flatten()
        }))
    }

    async fn create_admin_user(&self, admin_key: &str, email: &str) -> Result<String, String> {
        let base_url = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?.base_url;
        let url = admin_users_url(&base_url);
        let password = format!("WbSync-{}-a9", uuid::Uuid::new_v4().simple());
        let response = self.client.post(url).header("x-api-key", admin_key).header(header::CONTENT_TYPE, "application/json").json(&serde_json::json!({
            "email": email,
            "password": password,
            "allowed_groups": [],
            "restrict_public_groups": false,
        })).send().await.map_err(|error| format!("创建 Sub2API 用户失败：{error}"))?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|error| format!("解析 Sub2API 创建用户响应失败：{error}"))?;
        if !status.is_success() { return Err(admin_api_error(status, &value)); }
        user_id(&value).ok_or_else(|| "Sub2API 创建用户成功，但响应中没有用户 ID".to_string())
    }

    pub fn save_config(&self, input: &ConfigInput) -> Result<PublicConfig, String> {
        let base_url = normalize_base_url(&input.base_url)?;
        let previous = self.load()?;
        let api_key = input.api_key.as_deref().map(str::trim).filter(|key| !key.is_empty());
        let (nonce, ciphertext, last4) = if let Some(api_key) = api_key {
            if api_key.len() > 4096 { return Err("API Key 过长".to_string()); }
            let (nonce, ciphertext) = encrypt(&self.master_key, api_key.as_bytes())?;
            let last4 = api_key.chars().rev().take(4).collect::<String>().chars().rev().collect();
            (BASE64.encode(nonce), BASE64.encode(ciphertext), last4)
        } else if let Some(previous) = &previous {
            (previous.nonce.clone(), previous.ciphertext.clone(), previous.api_key_last4.clone())
        } else {
            (String::new(), String::new(), String::new())
        };
        let now = now_secs();
        let vault = VaultFile {
            version: VAULT_VERSION,
            base_url,
            nonce,
            ciphertext,
            api_key_last4: last4,
            updated_at: now,
            last_refresh_at: None,
            models: Vec::new(),
            last_error: None,
        };
        self.save(&vault)?;
        self.public_config()
    }

    pub async fn test_connection(&self) -> Result<(Vec<ModelItem>, u128), String> {
        if self.load()?.map(|vault| vault.ciphertext.is_empty()).unwrap_or(true) {
            return Err("后台只配置管理员 API Key；请先登录客户端后读取用户模型".to_string());
        }
        let started = Instant::now();
        let models = self.fetch_models().await?;
        Ok((models, started.elapsed().as_millis()))
    }

    pub async fn refresh_models(&self) -> Result<Vec<ModelItem>, String> {
        if self.load()?.map(|vault| vault.ciphertext.is_empty()).unwrap_or(true) {
            return Err("后台只配置管理员 API Key；请先登录客户端后读取用户模型".to_string());
        }
        let models = self.fetch_models().await?;
        let mut vault = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?;
        vault.models = models.clone();
        vault.last_refresh_at = Some(now_secs());
        vault.last_error = None;
        self.save(&vault)?;
        Ok(models)
    }

    pub async fn proxy_chat(&self, body: Vec<u8>) -> Result<reqwest::Response, String> {
        let vault = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?;
        let api_key = self.decrypt_key(&vault)?;
        let url = api_url(&vault.base_url, "/chat/completions");
        let response = self.client
            .post(url)
            .header(header::AUTHORIZATION, format!("Bearer {api_key}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|error| format!("请求 Sub2API 失败：{error}"))?;
        Ok(response)
    }

    async fn fetch_models(&self) -> Result<Vec<ModelItem>, String> {
        let vault = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?;
        let api_key = self.decrypt_key(&vault)?;
        let url = api_url(&vault.base_url, "/models");
        let response = self.client
            .get(url)
            .header(header::AUTHORIZATION, format!("Bearer {api_key}"))
            .header(header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| format!("连接 Sub2API 失败：{error}"))?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|error| format!("解析 Sub2API 模型响应失败：{error}"))?;
        if !status.is_success() {
            if status == reqwest::StatusCode::UNAUTHORIZED {
                return Err("Sub2API 返回 401：请使用用户 API Key（通常以 sk- 开头），不要使用管理员 API Key、登录 JWT 或后台密码".to_string());
            }
            if status == reqwest::StatusCode::FORBIDDEN {
                let detail = value.get("error").and_then(Value::as_str)
                    .or_else(|| value.get("message").and_then(Value::as_str))
                    .unwrap_or("API Key 已识别但没有模型目录权限");
                return Err(format!("Sub2API 返回 403：{detail}。请检查 Key 所属用户、分组权限、IP 白名单和账户状态"));
            }
            return Err(value.get("error").and_then(Value::as_str).unwrap_or("Sub2API 返回错误").to_string());
        }
        let models = value.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(models.into_iter().filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?.trim().to_string();
            if id.is_empty() { return None; }
            Some(ModelItem {
                id,
                object: item.get("object").and_then(Value::as_str).map(str::to_string),
                owned_by: item.get("owned_by").and_then(Value::as_str).map(str::to_string),
                created: item.get("created").and_then(Value::as_i64),
            })
        }).collect())
    }

    fn decrypt_key(&self, vault: &VaultFile) -> Result<String, String> {
        let nonce = decode_b64(&vault.nonce)?;
        let ciphertext = decode_b64(&vault.ciphertext)?;
        if nonce.len() != 12 { return Err("Sub2API 密钥 nonce 无效".to_string()); }
        let plaintext = Aes256Gcm::new_from_slice(&self.master_key)
            .map_err(|_| "Sub2API 加密主密钥无效".to_string())?
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|_| "Sub2API API Key 解密失败，可能需要重新配置主密钥".to_string())?;
        String::from_utf8(plaintext).map_err(|_| "Sub2API API Key 编码无效".to_string())
    }

    fn decrypt_user_key(&self, user_id: i64) -> Result<String, String> {
        let record = self.store.load_sub2api_user_key(user_id)
            .map_err(|error| format!("读取用户 API Key 失败：{error}"))?
            .ok_or_else(|| "用户尚未创建 Sub2API API Key".to_string())?;
        let nonce = decode_b64(&record.nonce)?;
        let ciphertext = decode_b64(&record.ciphertext)?;
        if nonce.len() != 12 { return Err("用户 API Key nonce 无效".to_string()); }
        let plaintext = Aes256Gcm::new_from_slice(&self.master_key)
            .map_err(|_| "Sub2API 加密主密钥无效".to_string())?
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|_| "用户 API Key 解密失败，可能需要重新同步".to_string())?;
        String::from_utf8(plaintext).map_err(|_| "用户 API Key 编码无效".to_string())
    }

    async fn fetch_models_with_key(&self, api_key: &str) -> Result<Vec<ModelItem>, String> {
        let vault = self.load()?.ok_or_else(|| "尚未配置 Sub2API".to_string())?;
        let response = self.client.get(api_url(&vault.base_url, "/models"))
            .header(header::AUTHORIZATION, format!("Bearer {api_key}"))
            .header(header::ACCEPT, "application/json")
            .send().await.map_err(|error| format!("连接 Sub2API 模型接口失败：{error}"))?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|error| format!("解析 Sub2API 模型响应失败：{error}"))?;
        if !status.is_success() { return Err(api_key_model_error(status, &value)); }
        Ok(parse_models(&value))
    }

    fn decrypt_admin_key(&self) -> Result<String, String> {
        let record = self.store.load_sub2api_admin_vault()
            .map_err(|error| format!("读取 Sub2API 管理密钥失败：{error}"))?
            .ok_or_else(|| "尚未配置 Sub2API 管理 API Key".to_string())?;
        let nonce = decode_b64(&record.nonce)?;
        let ciphertext = decode_b64(&record.ciphertext)?;
        if nonce.len() != 12 { return Err("Sub2API 管理密钥 nonce 无效".to_string()); }
        let plaintext = Aes256Gcm::new_from_slice(&self.master_key)
            .map_err(|_| "Sub2API 加密主密钥无效".to_string())?
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|_| "Sub2API 管理 API Key 解密失败，可能需要重新配置".to_string())?;
        String::from_utf8(plaintext).map_err(|_| "Sub2API 管理 API Key 编码无效".to_string())
    }

    fn load(&self) -> Result<Option<VaultFile>, String> {
        let Some(record) = self.store.load_sub2api_vault().map_err(|error| format!("读取 Sub2API 数据库配置失败：{error}"))? else {
            return Ok(None);
        };
        let models = serde_json::from_str(&record.models_json).unwrap_or_default();
        Ok(Some(VaultFile {
            version: record.version,
            base_url: record.base_url,
            nonce: record.nonce,
            ciphertext: record.ciphertext,
            api_key_last4: record.api_key_last4,
            updated_at: record.updated_at,
            last_refresh_at: record.last_refresh_at,
            models,
            last_error: record.last_error,
        }))
    }

    fn save(&self, vault: &VaultFile) -> Result<(), String> {
        let models_json = serde_json::to_string(&vault.models).map_err(|error| format!("序列化 Sub2API 模型缓存失败：{error}"))?;
        self.store.save_sub2api_vault(&Sub2ApiVaultRecord {
            version: vault.version,
            base_url: vault.base_url.clone(),
            nonce: vault.nonce.clone(),
            ciphertext: vault.ciphertext.clone(),
            api_key_last4: vault.api_key_last4.clone(),
            updated_at: vault.updated_at,
            last_refresh_at: vault.last_refresh_at,
            models_json,
            last_error: vault.last_error.clone(),
        }).map_err(|error| format!("保存 Sub2API 数据库配置失败：{error}"))
    }
}

fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let parsed = Url::parse(trimmed).map_err(|_| "Base URL 不是有效 URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Base URL 只支持 http/https 地址".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err("Base URL 不能包含用户名、密码或 fragment".to_string());
    }
    Ok(trimmed.to_string())
}

fn api_url(base_url: &str, path: &str) -> String {
    if base_url.trim_end_matches('/').ends_with("/v1") {
        format!("{}{}", base_url.trim_end_matches('/'), path)
    } else {
        format!("{}/v1{}", base_url.trim_end_matches('/'), path)
    }
}

fn admin_users_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let origin = base.strip_suffix("/api/v1").or_else(|| base.strip_suffix("/v1")).unwrap_or(base);
    format!("{origin}/api/v1/admin/users")
}

fn admin_usage_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let origin = base.strip_suffix("/api/v1").or_else(|| base.strip_suffix("/v1")).unwrap_or(base);
    format!("{origin}/api/v1/admin/usage")
}

fn admin_dashboard_models_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let origin = base.strip_suffix("/api/v1").or_else(|| base.strip_suffix("/v1")).unwrap_or(base);
    format!("{origin}/api/v1/admin/dashboard/models")
}

fn admin_groups_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let origin = base.strip_suffix("/api/v1").or_else(|| base.strip_suffix("/v1")).unwrap_or(base);
    format!("{origin}/api/v1/admin/groups/all")
}

fn auth_login_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let origin = base.strip_suffix("/api/v1").or_else(|| base.strip_suffix("/v1")).unwrap_or(base);
    format!("{origin}/api/v1/auth/login")
}

fn keys_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let origin = base.strip_suffix("/v1").unwrap_or(base);
    format!("{origin}/api/v1/keys")
}

fn admin_user_url(base_url: &str, account_id: &str) -> String {
    format!("{}/{}", admin_users_url(base_url).trim_end_matches("/users"), format!("users/{account_id}"))
}

fn sync_email(phone: &str) -> String {
    let normalized = phone.chars().filter(|character| character.is_ascii_digit()).collect::<String>();
    format!("{normalized}@users.workbuddy.local")
}

fn user_id(value: &Value) -> Option<String> {
    let candidates = [Some(value), value.get("data"), value.get("data").and_then(|data| data.get("user"))];
    candidates.into_iter().flatten().find_map(|item| {
        item.get("id").or_else(|| item.get("user_id")).or_else(|| item.get("userId")).map(|id| match id {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            _ => String::new(),
        }).filter(|id| !id.is_empty())
    })
}

fn extract_items(value: &Value) -> Vec<Value> {
    let candidates = [value.get("data"), value.get("items"), Some(value)];
    for candidate in candidates.into_iter().flatten() {
        if let Some(items) = candidate.as_array() { return items.clone(); }
        if let Some(items) = candidate.get("items").and_then(Value::as_array) { return items.clone(); }
        if let Some(items) = candidate.get("users").and_then(Value::as_array) { return items.clone(); }
    }
    Vec::new()
}

fn admin_api_error(status: reqwest::StatusCode, value: &Value) -> String {
    let code = value.get("code").and_then(Value::as_str).unwrap_or("");
    let message = value.get("message").and_then(Value::as_str)
        .or_else(|| value.get("error").and_then(Value::as_str))
        .unwrap_or("Sub2API 管理接口返回错误");
    if code == "INVALID_ADMIN_KEY" || status == reqwest::StatusCode::UNAUTHORIZED {
        return "Sub2API 管理 API Key 无效或已失效，请重新生成 Admin API Key".to_string();
    }
    format!("Sub2API 管理接口返回 {status}：{message}")
}

fn value_to_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse::<i64>().ok()))
}

fn number_value(value: Option<&Value>) -> Option<f64> {
    value.and_then(|value| value.as_f64().or_else(|| value.as_i64().map(|value| value as f64)).or_else(|| value.as_str()?.parse::<f64>().ok()))
}

fn extract_api_key(value: &Value) -> Option<String> {
    let candidates = [Some(value), value.get("data"), value.get("data").and_then(|data| data.get("api_key")), value.get("data").and_then(|data| data.get("key"))];
    candidates.into_iter().flatten().find_map(|item| {
        ["api_key", "apiKey", "key", "token"].into_iter().find_map(|field| item.get(field).and_then(Value::as_str).filter(|key| key.starts_with("sk-")).map(str::to_string))
    })
}

fn api_key_creation_error(status: reqwest::StatusCode, value: &Value) -> String {
    if status == reqwest::StatusCode::NOT_FOUND {
        return "当前 Sub2API 版本不支持管理员为用户创建 API Key（需要 /api/v1/admin/users/:id/api-keys），请升级 Sub2API 或改用用户自助创建接口".to_string();
    }
    admin_api_error(status, value)
}

fn api_key_model_error(status: reqwest::StatusCode, value: &Value) -> String {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return "用户 API Key 无效或已失效，请重新同步用户 API Key".to_string();
    }
    if value.get("code").and_then(Value::as_str) == Some("INSUFFICIENT_BALANCE") {
        return "用户 API Key 已创建，但 Sub2API 用户余额不足，暂时无法读取模型".to_string();
    }
    format!("Sub2API 用户模型接口返回 {status}：{}", value.get("message").and_then(Value::as_str).or_else(|| value.get("error").and_then(Value::as_str)).unwrap_or("请求失败"))
}

fn parse_models(value: &Value) -> Vec<ModelItem> {
    value.get("data").and_then(Value::as_array).into_iter().flatten().filter_map(|item| {
        let id = item.get("id").and_then(Value::as_str)?.trim().to_string();
        (!id.is_empty()).then_some(ModelItem {
            id,
            object: item.get("object").and_then(Value::as_str).map(str::to_string),
            owned_by: item.get("owned_by").and_then(Value::as_str).map(str::to_string),
            created: item.get("created").and_then(Value::as_i64),
        })
    }).collect()
}

fn decode_master_key(raw: &str) -> Result<[u8; 32], String> {
    let bytes = if raw.len() == 64 && raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        (0..32).map(|index| u8::from_str_radix(&raw[index * 2..index * 2 + 2], 16)).collect::<Result<Vec<_>, _>>().map_err(|_| "WB_ADMIN_MASTER_KEY hex 无效".to_string())?
    } else {
        BASE64.decode(raw).map_err(|_| "WB_ADMIN_MASTER_KEY 必须是 32 字节 base64 或 64 位 hex".to_string())?
    };
    bytes.try_into().map_err(|_| "WB_ADMIN_MASTER_KEY 必须正好是 32 字节".to_string())
}

fn decode_b64(value: &str) -> Result<Vec<u8>, String> {
    BASE64.decode(value).map_err(|_| "Sub2API 密钥库 base64 无效".to_string())
}

fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<([u8; 12], Vec<u8>), String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Sub2API 加密主密钥无效".to_string())?;
    let mut nonce = [0_u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce), plaintext).map_err(|_| "Sub2API API Key 加密失败".to_string())?;
    Ok((nonce, ciphertext))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|duration| duration.as_secs() as i64).unwrap_or_default()
}

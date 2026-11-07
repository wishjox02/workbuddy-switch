use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::cors::{Any, CorsLayer};

use crate::store::{AdminStore, Heartbeat, ModelServiceInput, ReleaseInput};
use crate::sub2api::{ConfigInput, Sub2ApiService};
use crate::workbuddy_models;

#[derive(Clone)]
pub struct AdminState {
    pub store: Arc<AdminStore>,
    pub admin_token: String,
    pub sub2api: Arc<Sub2ApiService>,
}

#[derive(Debug, Deserialize)]
pub struct InstallationQuery {
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenUsageQuery {
    page: Option<u32>,
    page_size: Option<u32>,
    model: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenUsageListQuery {
    page: Option<u32>,
    page_size: Option<u32>,
    model: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
}

pub fn router(state: AdminState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/telemetry/heartbeat", post(heartbeat))
        .route("/api/admin/overview", get(admin_overview))
        .route("/api/admin/installations", get(admin_installations))
        .route("/api/admin/releases", get(admin_releases).post(admin_upsert_release))
        .route("/api/admin/sub2api/config", get(admin_sub2api_config).post(admin_save_sub2api_config))
        .route("/api/admin/sub2api/admin-config", get(admin_sub2api_admin_config).post(admin_save_sub2api_admin_config))
        .route("/api/admin/sub2api/test", post(admin_sub2api_test))
        .route("/api/admin/sub2api/models/refresh", post(admin_refresh_sub2api_models))
        .route("/api/admin/sub2api/users/test", post(admin_test_sub2api_users))
        .route("/api/admin/sub2api/users/sync", post(admin_sync_sub2api_users))
        .route("/api/admin/model-services", get(admin_model_services).post(admin_add_model_service))
        .route("/api/admin/model-services/:id", post(admin_test_model_service).delete(admin_delete_model_service))
        .route("/api/admin/users", get(admin_users))
        .route("/api/admin/users/:id/sub2api", post(admin_bind_user_sub2api))
        .route("/api/admin/users/:id/sync", post(admin_sync_user_sub2api))
        .route("/api/admin/users/:id/status", post(admin_set_user_status))
        .route("/api/admin/users/:id/credits", get(admin_credit_history).post(admin_adjust_credits))
        .route("/api/admin/users/:id/consumption/sync", post(admin_sync_user_consumption))
        .route("/api/admin/sub2api/users/consumption-sync", post(admin_sync_all_consumption))
        .route("/api/admin/tokens/users", get(admin_token_users))
        .route("/api/admin/tokens/users/:id/records", get(admin_token_user_records))
        .route("/api/admin/tokens/usage", get(admin_token_usage))
        .route("/api/admin/tokens/usage/models", get(admin_token_usage_models))
        .route("/api/admin/tokens/sync", post(admin_sync_all_consumption))
        .route("/api/admin/sms/config", get(admin_sms_config))
        .route("/api/admin/sms/settings", get(admin_sms_settings_get).put(admin_sms_settings_put))
        .route("/api/admin/announcement", get(admin_announcement_get).post(admin_announcement_post))
        .route("/api/client/credits", get(client_credits))
        .route("/api/client/redeem", post(client_redeem))
        .route("/api/client/auth/sms/send", post(client_sms_send))
        .route("/api/client/auth/sms/login", post(client_sms_login))
        .route("/api/client/auth/me", get(client_auth_me))
        .route("/api/client/auth/logout", post(client_auth_logout))
        .route("/api/client/announcement", get(client_announcement))
        .route("/api/client/models", get(client_models))
        .route("/api/client/models/speed", get(client_models_speed))
        .route("/api/client/chat/completions", post(client_chat_completions))
        .route("/api/client/workbuddy/models", get(client_workbuddy_models).post(import_workbuddy_models))
        .route("/api/client/workbuddy/models/remove", post(remove_workbuddy_model))
        .route("/api/client/workbuddy/models/remove-all", post(remove_all_workbuddy_models))
        .route("/api/client/workbuddy/models/disable", post(disable_workbuddy_model))
        .route("/api/client/workbuddy/models/enable", post(enable_workbuddy_model))
        .route("/v1/models", get(openai_models))
        .route("/v1/chat/completions", post(openai_chat_completions))
        .route("/admin", get(admin_page))
        .route("/admin/overview", get(admin_page))
        .route("/admin/features", get(admin_page))
        .route("/admin/users", get(admin_page))
        .route("/admin/tokens", get(admin_page))
        .route("/admin/token-usage", get(admin_page))
        .route("/admin/sub2api", get(admin_page))
        .route("/admin/releases", get(admin_page))
        .route("/admin/settings", get(admin_page))
        .with_state(state)
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
}

async fn healthz() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "service": "wb-admin" }))
}

async fn client_announcement(State(state): State<AdminState>) -> Response {
    match state.store.load_announcement() {
        Ok(row) => Json(crate::store::ok_json(json!({
            "announcement": if row.enabled { row.announcement } else { String::new() }
        }))).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn admin_announcement_get(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.store.load_announcement() {
        Ok(row) => Json(crate::store::ok_json(json!({
            "announcement": row.announcement,
            "enabled": row.enabled,
            "updatedAt": row.updated_at
        }))).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn admin_announcement_post(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(input): Json<AnnouncementInput>,
) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    let announcement = input.announcement.trim();
    if announcement.chars().count() > 500 {
        return json_error(StatusCode::BAD_REQUEST, "公告不能超过 500 个字符".to_string());
    }
    let enabled = input.enabled.unwrap_or(true);
    if let Err(error) = state.store.save_announcement(announcement, enabled) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    Json(crate::store::ok_json(json!({ "announcement": announcement, "enabled": enabled }))).into_response()
}

async fn heartbeat(
    State(state): State<AdminState>,
    Json(payload): Json<Heartbeat>,
) -> Response {
    if let Err(error) = payload.validate() {
        return json_error(StatusCode::BAD_REQUEST, error);
    }
    match state.store.record_heartbeat(&payload) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SmsSendInput { phone: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SmsLoginInput { phone: String, challenge_id: String, verify_code: String }

#[derive(Debug, Deserialize)]
struct AnnouncementInput {
    #[serde(default)]
    announcement: String,
    enabled: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SmsSettingsInput {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    access_key_id: String,
    #[serde(default)]
    access_key_secret: Option<String>,
    #[serde(default)]
    clear_secret: bool,
    #[serde(default)]
    sign_name: String,
    #[serde(default)]
    template_code: String,
    #[serde(default)]
    scheme_name: String,
    #[serde(default)]
    endpoint: String,
}

struct ResolvedSms {
    config: Option<crate::sms::SmsConfig>,
    source: &'static str,
    error: Option<String>,
}

/// 解析当前生效的短信配置：环境变量优先，其次后台「系统设置」里保存的配置。
fn resolve_sms(store: &AdminStore) -> ResolvedSms {
    if let Some(config) = crate::sms::SmsConfig::from_env() {
        return ResolvedSms { config: Some(config), source: "environment", error: None };
    }
    let row = match store.load_sms_settings() {
        Ok(row) => row,
        Err(error) => {
            return ResolvedSms {
                config: None,
                source: "none",
                error: Some(format!("读取短信配置失败：{error}")),
            }
        }
    };
    let Some(row) = row else {
        return ResolvedSms { config: None, source: "none", error: None };
    };
    if !row.enabled {
        return ResolvedSms { config: None, source: "management", error: None };
    }
    if row.access_key_id.trim().is_empty() || row.sign_name.trim().is_empty() {
        return ResolvedSms { config: None, source: "management", error: None };
    }
    let secret = match crate::secrets::SecretVault::from_env()
        .and_then(|vault| vault.decrypt(&row.secret_nonce, &row.secret_ciphertext))
    {
        Ok(secret) => secret,
        Err(error) => {
            return ResolvedSms {
                config: None,
                source: "management",
                error: Some(format!("短信密钥不可用：{error}")),
            }
        }
    };
    let config = crate::sms::SmsConfig::from_parts(
        row.access_key_id,
        secret,
        row.sign_name,
        row.template_code,
        row.scheme_name,
        row.endpoint,
    );
    ResolvedSms { config, source: "management", error: None }
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer ")).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

async fn client_sms_send(State(state): State<AdminState>, Json(payload): Json<SmsSendInput>) -> Response {
    let phone = payload.phone.trim().to_string();
    if phone.len() < 6 || phone.len() > 32 { return json_error(StatusCode::BAD_REQUEST, "手机号格式不正确".to_string()); }
    let mode = std::env::var("WB_SMS_MODE").unwrap_or_default();
    let resolved = resolve_sms(&state.store);
    if mode == "production" && resolved.config.is_none() {
        let message = resolved.error.clone().unwrap_or_else(|| {
            "短信服务未配置：请在后台「系统设置 → 阿里云短信登录」填写 AccessKey、签名和模板，或设置 WB_SMS_ACCESS_KEY_ID / WB_SMS_ACCESS_KEY_SECRET / WB_SMS_SIGN_NAME 环境变量".to_string()
        });
        return json_error(StatusCode::NOT_IMPLEMENTED, message);
    }
    // 配置了阿里云 AccessKey（环境变量或后台保存）就真实下发，除非显式 WB_SMS_MODE=dev。
    if mode != "dev" {
        if let Some(config) = resolved.config.clone() {
            let out_id = uuid::Uuid::new_v4().to_string();
            return match config.send_verify_code(&phone, &out_id, 300).await {
                Ok(outcome) => match state.store.issue_sms_challenge_with(&phone, None, 300, "aliyun", &outcome.out_id) {
                    Ok(challenge_id) => Json(crate::store::ok_json(json!({
                        "challengeId": challenge_id,
                        "phoneMasked": mask_phone(&phone),
                        "expiresIn": 300,
                        "retryAfter": 60,
                        "provider": "aliyun",
                    }))).into_response(),
                    Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
                },
                Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
            };
        }
    }
    // 本地调试：固定验证码 123456
    let code = "123456";
    match state.store.issue_sms_challenge(&phone, code, 300) {
        Ok(challenge_id) => Json(crate::store::ok_json(json!({
            "challengeId": challenge_id,
            "phoneMasked": mask_phone(&phone),
            "expiresIn": 300,
            "retryAfter": 60,
            "provider": "local",
            "devCode": if mode == "dev" || mode.is_empty() { Some(code) } else { None },
        }))).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn client_sms_login(State(state): State<AdminState>, Json(payload): Json<SmsLoginInput>) -> Response {
    let now = crate::store::now_secs();
    let challenge = match state.store.sms_challenge(&payload.challenge_id) {
        Ok(Some(challenge)) => challenge,
        Ok(None) => return json_error(StatusCode::UNAUTHORIZED, "验证码不正确或已经失效".to_string()),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if !challenge.is_active(now) {
        return json_error(StatusCode::UNAUTHORIZED, "验证码不正确或已经失效".to_string());
    }
    if crate::store::normalize_phone(&payload.phone) != challenge.phone {
        return json_error(StatusCode::UNAUTHORIZED, "验证码不正确或已经失效".to_string());
    }

    if challenge.provider == "aliyun" {
        let resolved = resolve_sms(&state.store);
        let Some(config) = resolved.config else {
            let message = resolved.error.unwrap_or_else(|| {
                "短信服务未配置：请在后台「系统设置 → 阿里云短信登录」填写 AccessKey、签名和模板".to_string()
            });
            return json_error(StatusCode::SERVICE_UNAVAILABLE, message);
        };
        match config
            .check_verify_code(&payload.phone, &payload.verify_code, &challenge.out_id)
            .await
        {
            Ok(true) => { let _ = state.store.finish_sms_challenge(&payload.challenge_id, true); }
            Ok(false) => {
                let _ = state.store.finish_sms_challenge(&payload.challenge_id, false);
                return json_error(StatusCode::UNAUTHORIZED, "验证码不正确或已经失效".to_string());
            }
            Err(error) => {
                let _ = state.store.finish_sms_challenge(&payload.challenge_id, false);
                return json_error(StatusCode::BAD_GATEWAY, error);
            }
        }
    } else {
        match state.store.verify_sms_challenge(&payload.challenge_id, &payload.phone, &payload.verify_code) {
            Ok(true) => {}
            Ok(false) => return json_error(StatusCode::UNAUTHORIZED, "验证码不正确或已经失效".to_string()),
            Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        }
    }

    let token = uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().to_string();
    match state.store.create_user_session(&payload.phone, &token, 30 * 24 * 60 * 60) {
        Ok(user) => {
            if user.status == "disabled" {
                let _ = state.store.revoke_session(&token);
                return json_error(StatusCode::FORBIDDEN, "用户已被禁用，请联系管理员".to_string());
            }
            let sync = state.sub2api.sync_user_after_login(&user).await;
            let user = state.store.user_by_token(&token).ok().flatten().unwrap_or(user);
            Json(crate::store::ok_json(json!({ "sessionToken": token, "user": user, "sub2apiSync": sync }))).into_response()
        }
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// 读取后台保存的阿里云短信登录配置（密钥只回打码提示）。
async fn admin_sms_settings_get(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    let row = match state.store.load_sms_settings() {
        Ok(row) => row.unwrap_or_default(),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let resolved = resolve_sms(&state.store);
    let env_override = std::env::var("WB_SMS_ACCESS_KEY_ID")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    Json(crate::store::ok_json(json!({
        "provider": "aliyun",
        "enabled": row.enabled,
        "accessKeyId": row.access_key_id,
        "secretConfigured": row.secret_configured(),
        "keyHint": row.key_hint,
        "signName": row.sign_name,
        "templateCode": if row.template_code.is_empty() { "100001".to_string() } else { row.template_code },
        "schemeName": row.scheme_name,
        "endpoint": if row.endpoint.is_empty() { "dypnsapi.aliyuncs.com".to_string() } else { row.endpoint },
        "updatedAt": row.updated_at,
        "source": resolved.source,
        "configured": resolved.config.is_some(),
        "envOverride": env_override,
        "error": resolved.error,
    }))).into_response()
}

/// 保存阿里云短信登录配置。`accessKeySecret` 留空表示保持原有密钥。
async fn admin_sms_settings_put(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(input): Json<SmsSettingsInput>,
) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    let existing = match state.store.load_sms_settings() {
        Ok(row) => row.unwrap_or_default(),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let secret_input = input
        .access_key_secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (nonce, ciphertext, key_hint) = if input.clear_secret {
        (String::new(), String::new(), String::new())
    } else if let Some(secret) = secret_input {
        match crate::secrets::SecretVault::from_env().and_then(|vault| vault.encrypt(secret)) {
            Ok((nonce, ciphertext)) => (nonce, ciphertext, crate::secrets::hint(secret)),
            Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
        }
    } else {
        (
            existing.secret_nonce.clone(),
            existing.secret_ciphertext.clone(),
            existing.key_hint.clone(),
        )
    };
    let row = crate::store::SmsSettingsRow {
        enabled: input.enabled,
        access_key_id: input.access_key_id.trim().to_string(),
        secret_nonce: nonce,
        secret_ciphertext: ciphertext,
        key_hint,
        sign_name: input.sign_name.trim().to_string(),
        template_code: {
            let value = input.template_code.trim();
            if value.is_empty() { "100001".to_string() } else { value.to_string() }
        },
        scheme_name: input.scheme_name.trim().to_string(),
        endpoint: {
            let value = input.endpoint.trim();
            if value.is_empty() { "dypnsapi.aliyuncs.com".to_string() } else { value.to_string() }
        },
        updated_at: crate::store::now_secs(),
    };
    if let Err(error) = state.store.save_sms_settings(&row) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    admin_sms_settings_get(State(state), headers).await
}

/// 短信登录服务状态：是否已配置阿里云 PNVS、当前模式与脱敏配置。
async fn admin_sms_config(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    let mode = std::env::var("WB_SMS_MODE").unwrap_or_else(|_| "auto".to_string());
    match crate::sms::SmsConfig::from_env() {
        Some(config) => Json(crate::store::ok_json(json!({
            "provider": "aliyun",
            "mode": mode,
            "config": config.describe(),
        }))).into_response(),
        None => Json(crate::store::ok_json(json!({
            "provider": "local",
            "mode": mode,
            "config": { "configured": false },
            "hint": "未配置 WB_SMS_ACCESS_KEY_ID / WB_SMS_ACCESS_KEY_SECRET / WB_SMS_SIGN_NAME，当前使用本地调试验证码 123456",
        }))).into_response(),
    }
}

async fn client_auth_me(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    let Some(token) = session_token(&headers) else { return json_error(StatusCode::UNAUTHORIZED, "未登录".to_string()); };
    match state.store.user_by_token(&token) {
        Ok(Some(user)) => Json(crate::store::ok_json(json!({ "user": user }))).into_response(),
        Ok(None) => json_error(StatusCode::UNAUTHORIZED, "登录已过期".to_string()),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn client_auth_logout(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if let Some(token) = session_token(&headers) { let _ = state.store.revoke_session(&token); }
    Json(json!({ "ok": true })).into_response()
}

async fn admin_users(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.store.list_users() {
        Ok(users) => Json(crate::store::ok_json(users)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct UserBindingInput { sub2api_account_id: Option<String> }

async fn admin_bind_user_sub2api(State(state): State<AdminState>, headers: HeaderMap, Path(id): Path<i64>, Json(payload): Json<UserBindingInput>) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.store.bind_user_sub2api(id, payload.sub2api_account_id.as_deref()) {
        Ok(Some(user)) => Json(crate::store::ok_json(user)).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "用户不存在".to_string()),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

async fn admin_sync_user_sub2api(State(state): State<AdminState>, headers: HeaderMap, Path(id): Path<i64>) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    let user = match state.store.user_by_id(id) {
        Ok(Some(user)) => user,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "用户不存在".to_string()),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let result = state.sub2api.sync_user_after_login(&user).await;
    Json(crate::store::ok_json(result)).into_response()
}

#[derive(Debug, Deserialize)]
struct UserStatusInput { enabled: bool }

async fn admin_set_user_status(State(state): State<AdminState>, headers: HeaderMap, Path(id): Path<i64>, Json(payload): Json<UserStatusInput>) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    let user = match state.store.user_by_id(id) {
        Ok(Some(user)) => user,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "用户不存在".to_string()),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    match state.sub2api.set_user_enabled(&user, payload.enabled).await {
        Ok(result) => Json(crate::store::ok_json(result)).into_response(),
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreditAdjustInput {
    delta: f64,
    kind: Option<String>,
    reference: Option<String>,
    note: Option<String>,
    operator: Option<String>,
}

async fn admin_credit_history(State(state): State<AdminState>, headers: HeaderMap, Path(id): Path<i64>) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.store.credit_history(id, 200) {
        Ok(history) => Json(crate::store::ok_json(json!({ "history": history }))).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn admin_adjust_credits(State(state): State<AdminState>, headers: HeaderMap, Path(id): Path<i64>, Json(payload): Json<CreditAdjustInput>) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    if !payload.delta.is_finite() || payload.delta == 0.0 { return json_error(StatusCode::BAD_REQUEST, "积分变更必须是非零数字".to_string()); }
    match state.store.adjust_credits(id, payload.delta, payload.kind.as_deref().unwrap_or("manual"), payload.reference.as_deref().unwrap_or(""), payload.note.as_deref().unwrap_or(""), payload.operator.as_deref().unwrap_or("admin")) {
        Ok(Some(user)) => {
            let balance = user.credits;
            Json(crate::store::ok_json(json!({ "user": user, "balance": balance }))).into_response()
        },
        Ok(None) => json_error(StatusCode::NOT_FOUND, "用户不存在".to_string()),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

async fn client_credits(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    let Some(token) = session_token(&headers) else { return json_error(StatusCode::UNAUTHORIZED, "未登录".to_string()); };
    match state.store.user_by_token(&token) {
        Ok(Some(user)) => match state.store.credit_history(user.id, 100) {
            Ok(history) => Json(crate::store::ok_json(json!({ "credits": user.credits, "history": history }))).into_response(),
            Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        },
        Ok(None) => json_error(StatusCode::UNAUTHORIZED, "登录已过期".to_string()),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RedeemInput { code: String }

async fn client_redeem(State(state): State<AdminState>, headers: HeaderMap, Json(payload): Json<RedeemInput>) -> Response {
    let Some(token) = session_token(&headers) else { return json_error(StatusCode::UNAUTHORIZED, "未登录".to_string()); };
    let user = match state.store.user_by_token(&token) {
        Ok(Some(user)) => user,
        Ok(None) => return json_error(StatusCode::UNAUTHORIZED, "登录已过期".to_string()),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    match state.store.redeem_code(user.id, &payload.code) {
        Ok(Some((credits, balance))) => Json(crate::store::ok_json(json!({ "credits": credits, "balance": balance }))).into_response(),
        Ok(None) => json_error(StatusCode::UNAUTHORIZED, "用户不存在".to_string()),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error),
    }
}

async fn admin_sync_user_consumption(State(state): State<AdminState>, headers: HeaderMap, Path(id): Path<i64>) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    let user = match state.store.user_by_id(id) {
        Ok(Some(user)) => user,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "用户不存在".to_string()),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    match state.sub2api.sync_user_consumption(&user).await {
        Ok(result) => Json(crate::store::ok_json(result)).into_response(),
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

async fn admin_sync_all_consumption(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    let users = match state.store.list_users() {
        Ok(users) => users,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let mut results = Vec::new();
    for user in users {
        if user.sub2api_account_id.is_none() { continue; }
        match state.sub2api.sync_user_consumption(&user).await {
            Ok(result) => results.push(json!({ "ok": true, "result": result })),
            Err(error) => results.push(json!({ "ok": false, "userId": user.id, "error": error })),
        }
    }
    Json(crate::store::ok_json(json!({ "results": results }))).into_response()
}

async fn admin_token_users(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.sub2api.token_users().await {
        Ok(users) => {
            let totals = json!({
                "users": users.len(),
                "balance": users.iter().filter_map(|user| user.get("balance").and_then(Value::as_f64)).sum::<f64>(),
            });
            Json(crate::store::ok_json(json!({ "users": users, "totals": totals }))).into_response()
        }
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

async fn admin_token_user_records(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<TokenUsageQuery>,
) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    if let (Some(start), Some(end)) = (query.start_date.as_deref(), query.end_date.as_deref()) {
        if start > end { return json_error(StatusCode::BAD_REQUEST, "开始日期不能晚于结束日期".to_string()); }
    }
    match state.sub2api.token_user_usage_records(&id, query.model.as_deref(), query.start_date.as_deref(), query.end_date.as_deref(), query.page.unwrap_or(1), query.page_size.unwrap_or(50)).await {
        Ok(data) => Json(crate::store::ok_json(data)).into_response(),
        Err(error) if error.contains("用户不存在") => json_error(StatusCode::NOT_FOUND, error),
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

async fn admin_token_usage(State(state): State<AdminState>, headers: HeaderMap, Query(query): Query<TokenUsageListQuery>) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    if let (Some(start), Some(end)) = (query.start_date.as_deref(), query.end_date.as_deref()) {
        if start > end { return json_error(StatusCode::BAD_REQUEST, "开始日期不能晚于结束日期".to_string()); }
    }
    match state.sub2api.token_usage_page(query.model.as_deref(), query.start_date.as_deref(), query.end_date.as_deref(), query.page.unwrap_or(1), query.page_size.unwrap_or(50)).await {
        Ok(data) => Json(crate::store::ok_json(data)).into_response(),
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

async fn admin_token_usage_models(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.sub2api.token_usage_models().await {
        Ok(models) => Json(crate::store::ok_json(json!({ "models": models }))).into_response(),
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

fn mask_phone(phone: &str) -> String {
    let chars: Vec<char> = phone.chars().collect();
    if chars.len() <= 7 { return "***".to_string(); }
    format!("{}****{}", chars[..3].iter().collect::<String>(), chars[chars.len()-4..].iter().collect::<String>())
}

async fn admin_overview(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) {
        return unauthorized();
    }
    match state.store.overview() {
        Ok(data) => Json(crate::store::ok_json(data)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn admin_installations(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Query(query): Query<InstallationQuery>,
) -> Response {
    if !authorized(&headers, &state.admin_token) {
        return unauthorized();
    }
    match state.store.installations(query.limit.unwrap_or(100)) {
        Ok(data) => Json(crate::store::ok_json(data)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn admin_releases(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) {
        return unauthorized();
    }
    match state.store.releases() {
        Ok(data) => Json(crate::store::ok_json(data)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn admin_upsert_release(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(payload): Json<ReleaseInput>,
) -> Response {
    if !authorized(&headers, &state.admin_token) {
        return unauthorized();
    }
    if payload.version.trim().is_empty() || payload.version.len() > 64 {
        return json_error(StatusCode::BAD_REQUEST, "version 无效".to_string());
    }
    match state.store.upsert_release(&payload) {
        Ok(data) => Json(crate::store::ok_json(data)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn admin_sub2api_config(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.sub2api.public_config() {
        Ok(data) => Json(crate::store::ok_json(data)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn admin_save_sub2api_config(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(payload): Json<ConfigInput>,
) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.sub2api.save_config(&payload) {
        Ok(data) => Json(crate::store::ok_json(data)).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error),
    }
}

async fn admin_sub2api_admin_config(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.sub2api.public_admin_config() {
        Ok(data) => Json(crate::store::ok_json(data)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminKeyInput { api_key: String }

async fn admin_save_sub2api_admin_config(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(payload): Json<AdminKeyInput>,
) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.sub2api.save_admin_config(&payload.api_key) {
        Ok(data) => Json(crate::store::ok_json(data)).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error),
    }
}

async fn admin_sub2api_test(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.sub2api.test_connection().await {
        Ok((models, duration_ms)) => {
            let count = models.len();
            Json(crate::store::ok_json(json!({ "models": models, "count": count, "durationMs": duration_ms }))).into_response()
        }
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

async fn admin_refresh_sub2api_models(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.sub2api.refresh_models().await {
        Ok(models) => {
            let count = models.len();
            Json(crate::store::ok_json(json!({ "models": models, "count": count }))).into_response()
        }
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

async fn admin_test_sub2api_users(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.sub2api.test_admin_connection().await {
        Ok(count) => Json(crate::store::ok_json(json!({ "count": count }))).into_response(),
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

async fn admin_sync_sub2api_users(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.sub2api.sync_all_users().await {
        Ok(results) => {
            let synced = results.iter().filter(|item| item.synced).count();
            let failed = results.len().saturating_sub(synced);
            Json(crate::store::ok_json(json!({ "results": results, "synced": synced, "failed": failed }))).into_response()
        },
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

async fn client_models(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if let Some(token) = session_token(&headers) {
        match state.store.user_by_token(&token) {
            Ok(Some(user)) => match state.sub2api.user_models(&user).await {
                Ok(models) => {
                    let models = models.into_iter().map(|model| json!({
                        "id": model.id,
                        "displayName": model.id,
                        "modelType": model.owned_by,
                        "object": model.object,
                        "enabled": true,
                    })).collect::<Vec<_>>();
                    return Json(crate::store::ok_json(json!({ "models": models, "source": "user-api-key" }))).into_response();
                }
                Err(error) => return json_error(StatusCode::BAD_GATEWAY, error),
            },
            Ok(None) => return json_error(StatusCode::UNAUTHORIZED, "登录已过期".to_string()),
            Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        }
    }
    match state.store.list_model_services() {
        Ok(mut services) => {
            if services.is_empty() {
                if let Ok(cached) = state.sub2api.cached_models() {
                    for model in cached {
                        let _ = state.store.add_model_service(&ModelServiceInput {
                            model_type: model.owned_by.clone().unwrap_or_else(|| "sub2api".to_string()),
                            model_id: model.id.clone(),
                            display_name: model.id.clone(),
                            enabled: Some(true),
                        });
                    }
                    services = state.store.list_model_services().unwrap_or_default();
                }
            }
            let models = services.into_iter().filter(|service| service.enabled).map(|service| json!({
                "id": service.model_id,
                "displayName": service.display_name,
                "modelType": service.model_type,
                "enabled": service.enabled,
            })).collect::<Vec<_>>();
            Json(crate::store::ok_json(json!({ "models": models }))).into_response()
        }
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn admin_model_services(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.store.list_model_services() {
        Ok(data) => Json(crate::store::ok_json(data)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn admin_add_model_service(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(payload): Json<ModelServiceInput>,
) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    if payload.model_type.trim().is_empty() || payload.model_id.trim().is_empty() || payload.display_name.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "模型类型、模型 ID 和名称不能为空".to_string());
    }
    match state.store.add_model_service(&payload) {
        Ok(data) => Json(crate::store::ok_json(data)).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

async fn admin_delete_model_service(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    match state.store.delete_model_service(id) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "模型服务不存在".to_string()),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn admin_test_model_service(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    if !authorized(&headers, &state.admin_token) { return unauthorized(); }
    let service = match state.store.list_model_services() {
        Ok(items) => match items.into_iter().find(|item| item.id == id) {
            Some(item) => item,
            None => return json_error(StatusCode::NOT_FOUND, "模型服务不存在".to_string()),
        },
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    match state.sub2api.test_connection().await {
        Ok((models, duration_ms)) => {
            let available = models.iter().any(|model| model.id == service.model_id);
            Json(crate::store::ok_json(json!({ "available": available, "durationMs": duration_ms, "modelId": service.model_id }))).into_response()
        }
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

async fn client_models_speed(State(state): State<AdminState>, headers: HeaderMap) -> Response {
    if let Some(token) = session_token(&headers) {
        match state.store.user_by_token(&token) {
            Ok(Some(user)) => return match state.sub2api.user_models_speed(&user).await {
                Ok((models, duration_ms)) => Json(crate::store::ok_json(json!({ "count": models.len(), "durationMs": duration_ms, "source": "user-api-key" }))).into_response(),
                Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
            },
            Ok(None) => return json_error(StatusCode::UNAUTHORIZED, "登录已过期".to_string()),
            Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        }
    }
    match state.sub2api.test_connection().await {
        Ok((models, duration_ms)) => Json(crate::store::ok_json(json!({ "count": models.len(), "durationMs": duration_ms }))).into_response(),
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkBuddyModelsInput {
    models: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct WorkBuddyModelRemoveInput {
    id: String,
}

fn proxy_base_url(headers: &HeaderMap) -> String {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("127.0.0.1:57900");
    let host = host.strip_prefix("[").and_then(|value| value.split_once(']')).map(|(value, _)| value).unwrap_or(host);
    let host = if host.contains(':') { host } else { "127.0.0.1:57900" };
    format!("http://{host}/v1")
}

async fn client_workbuddy_models() -> Response {
    match workbuddy_models::public_models() {
        Ok(models) => Json(crate::store::ok_json(json!({
            "models": models,
            "path": workbuddy_models::models_path().to_string_lossy(),
        }))).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn import_workbuddy_models(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(payload): Json<WorkBuddyModelsInput>,
) -> Response {
    let mut managed_user_id = None;
    let (endpoint_url, api_key) = if let Some(token) = session_token(&headers) {
        let user = match state.store.user_by_token(&token) {
            Ok(Some(user)) => user,
            Ok(None) => return json_error(StatusCode::UNAUTHORIZED, "登录已过期".to_string()),
            Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
        let config = match state.sub2api.public_config() { Ok(config) => config, Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error) };
        let key = match state.sub2api.user_api_key(user.id) { Ok(key) => key, Err(error) => return json_error(StatusCode::BAD_REQUEST, error) };
        managed_user_id = Some(user.id);
        (format!("{}/v1", config.base_url.trim_end_matches('/').trim_end_matches("/v1")), Some(key))
    } else {
        (proxy_base_url(&headers), None)
    };
    match workbuddy_models::import(&payload.models, &endpoint_url, api_key.as_deref(), managed_user_id) {
        Ok(models) => Json(crate::store::ok_json(json!({
            "models": models,
            "path": workbuddy_models::models_path().to_string_lossy(),
            "proxyUrl": endpoint_url,
        }))).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn remove_workbuddy_model(Json(payload): Json<WorkBuddyModelRemoveInput>) -> Response {
    match workbuddy_models::remove(&payload.id) {
        Ok(models) => Json(crate::store::ok_json(json!({
            "models": models,
            "path": workbuddy_models::models_path().to_string_lossy(),
        }))).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn remove_all_workbuddy_models() -> Response {
    match workbuddy_models::remove_all() {
        Ok((models, removed)) => Json(crate::store::ok_json(json!({
            "models": models,
            "removed": removed,
            "path": workbuddy_models::models_path().to_string_lossy(),
        }))).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn disable_workbuddy_model(Json(payload): Json<WorkBuddyModelRemoveInput>) -> Response {
    match workbuddy_models::disable(&payload.id) {
        Ok(models) => Json(crate::store::ok_json(json!({
            "models": models,
            "path": workbuddy_models::models_path().to_string_lossy(),
        }))).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn enable_workbuddy_model(Json(payload): Json<WorkBuddyModelRemoveInput>) -> Response {
    match workbuddy_models::enable(&payload.id) {
        Ok(models) => Json(crate::store::ok_json(json!({
            "models": models,
            "path": workbuddy_models::models_path().to_string_lossy(),
        }))).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn openai_models(State(state): State<AdminState>) -> Response {
    match state.store.list_model_services() {
        Ok(mut services) => {
            if services.is_empty() {
                if let Ok(cached) = state.sub2api.cached_models() {
                    for model in cached {
                        let _ = state.store.add_model_service(&ModelServiceInput {
                            model_type: model.owned_by.clone().unwrap_or_else(|| "sub2api".to_string()),
                            model_id: model.id.clone(),
                            display_name: model.id.clone(),
                            enabled: Some(true),
                        });
                    }
                    services = state.store.list_model_services().unwrap_or_default();
                }
            }
            let data = services.into_iter().filter(|service| service.enabled).map(|service| json!({
                "id": service.model_id,
                "object": "model",
                "owned_by": service.model_type,
            })).collect::<Vec<_>>();
            Json(json!({ "object": "list", "data": data })).into_response()
        }
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn openai_chat_completions(
    State(state): State<AdminState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let token = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).unwrap_or("");
    if token != format!("Bearer {}", workbuddy_models::proxy_key()) {
        return json_error(StatusCode::UNAUTHORIZED, "WorkBuddy 本地代理凭据无效".to_string());
    }
    match state.sub2api.proxy_chat(body.to_vec()).await {
        Ok(upstream) => {
            let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let content_type = upstream.headers().get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).map(str::to_string);
            let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
            *response.status_mut() = status;
            if let Some(value) = content_type.and_then(|value| HeaderValue::from_str(&value).ok()) {
                response.headers_mut().insert(header::CONTENT_TYPE, value);
            }
            response
        }
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

async fn client_chat_completions(
    State(state): State<AdminState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if headers.get("x-installation-id").and_then(|value| value.to_str().ok()).map(str::trim).filter(|value| !value.is_empty()).is_none() {
        return json_error(StatusCode::UNAUTHORIZED, "缺少客户端安装标识".to_string());
    }
    match state.sub2api.proxy_chat(body.to_vec()).await {
        Ok(upstream) => {
            let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let content_type = upstream.headers().get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).map(str::to_string);
            let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
            *response.status_mut() = status;
            if let Some(content_type) = content_type.and_then(|value| HeaderValue::from_str(&value).ok()) {
                response.headers_mut().insert(header::CONTENT_TYPE, content_type);
            }
            response
        }
        Err(error) => json_error(StatusCode::BAD_GATEWAY, error),
    }
}

fn authorized(headers: &HeaderMap, expected: &str) -> bool {
    let Some(value) = headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    value.strip_prefix("Bearer ").map(str::trim) == Some(expected)
}

fn unauthorized() -> Response {
    json_error(StatusCode::UNAUTHORIZED, "需要管理员令牌".to_string())
}

fn json_error(status: StatusCode, error: String) -> Response {
    (status, Json(json!({ "ok": false, "error": error }))).into_response()
}

async fn admin_page() -> Html<&'static str> {
    Html(include_str!("../public/admin.html"))
}

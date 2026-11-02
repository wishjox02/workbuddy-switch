//! 阿里云号码认证服务（PNVS）短信验证码对接。
//!
//! 与 video_flow 项目的 `management/sms_auth.py` 保持一致：调用 dypnsapi 的
//! `SendSmsVerifyCode` 下发验证码、`CheckSmsVerifyCode` 核销验证码，验证码内容
//! 由阿里云生成，服务端不保存明文。
//!
//! 配置全部来自环境变量，未配置时调用方应回退到本地调试验证码：
//!
//! | 变量 | 说明 |
//! | --- | --- |
//! | `WB_SMS_ACCESS_KEY_ID` | 阿里云 AccessKeyId |
//! | `WB_SMS_ACCESS_KEY_SECRET` | 阿里云 AccessKeySecret |
//! | `WB_SMS_SIGN_NAME` | 短信签名 |
//! | `WB_SMS_TEMPLATE_CODE` | 模板号，默认 `100001`（阿里云 PNVS 通用模板） |
//! | `WB_SMS_SCHEME_NAME` | 可选，号码认证方案名称 |
//! | `WB_SMS_ENDPOINT` | 可选，默认 `dypnsapi.aliyuncs.com` |

use reqwest::Client;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

const API_VERSION: &str = "2017-05-25";
const SIGN_ALGORITHM: &str = "ACS3-HMAC-SHA256";
const DEFAULT_ENDPOINT: &str = "dypnsapi.aliyuncs.com";
const DEFAULT_TEMPLATE_CODE: &str = "100001";

/// 短信发送结果，返回给调用方用于记录和日志。
#[derive(Debug, Clone, Default)]
pub struct SmsSendOutcome {
    pub biz_id: String,
    pub out_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone)]
pub struct SmsConfig {
    pub access_key_id: String,
    pub access_key_secret: String,
    pub sign_name: String,
    pub template_code: String,
    pub scheme_name: String,
    pub endpoint: String,
    client: Client,
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

impl SmsConfig {
    /// 读取环境变量配置；AccessKey、签名缺失时返回 None，调用方回退到本地模式。
    pub fn from_env() -> Option<Self> {
        let access_key_id = env_value("WB_SMS_ACCESS_KEY_ID")?;
        let access_key_secret = env_value("WB_SMS_ACCESS_KEY_SECRET")?;
        let sign_name = env_value("WB_SMS_SIGN_NAME")?;
        let template_code = env_value("WB_SMS_TEMPLATE_CODE")
            .unwrap_or_else(|| DEFAULT_TEMPLATE_CODE.to_string());
        let scheme_name = env_value("WB_SMS_SCHEME_NAME").unwrap_or_default();
        let endpoint = env_value("WB_SMS_ENDPOINT").unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .ok()?;
        Some(Self {
            access_key_id,
            access_key_secret,
            sign_name,
            template_code,
            scheme_name,
            endpoint,
            client,
        })
    }

    /// 用后台保存（或环境变量）的字段构造客户端；必填项缺失时返回 None。
    pub fn from_parts(
        access_key_id: String,
        access_key_secret: String,
        sign_name: String,
        template_code: String,
        scheme_name: String,
        endpoint: String,
    ) -> Option<Self> {
        let access_key_id = access_key_id.trim().to_string();
        let sign_name = sign_name.trim().to_string();
        if access_key_id.is_empty() || access_key_secret.trim().is_empty() || sign_name.is_empty() {
            return None;
        }
        let template_code = {
            let value = template_code.trim();
            if value.is_empty() { DEFAULT_TEMPLATE_CODE.to_string() } else { value.to_string() }
        };
        let endpoint = {
            let value = endpoint.trim();
            if value.is_empty() { DEFAULT_ENDPOINT.to_string() } else { value.to_string() }
        };
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .ok()?;
        Some(Self {
            access_key_id,
            access_key_secret,
            sign_name,
            template_code,
            scheme_name: scheme_name.trim().to_string(),
            endpoint,
            client,
        })
    }

    /// 对外暴露的脱敏配置，便于后台展示。
    pub fn describe(&self) -> Value {
        let last4: String = {
            let chars: Vec<char> = self.access_key_id.chars().collect();
            let start = chars.len().saturating_sub(4);
            chars[start..].iter().collect()
        };
        serde_json::json!({
            "configured": true,
            "signName": self.sign_name,
            "templateCode": self.template_code,
            "schemeName": self.scheme_name,
            "endpoint": self.endpoint,
            "accessKeyIdLast4": last4,
        })
    }

    /// 下发短信验证码。
    pub async fn send_verify_code(
        &self,
        phone: &str,
        out_id: &str,
        valid_seconds: u32,
    ) -> Result<SmsSendOutcome, String> {
        let valid = valid_seconds.clamp(60, 900);
        let minutes = std::cmp::max(1, valid / 60);
        let template_param = format!(
            "{{\"code\":\"##code##\",\"min\":\"{}\"}}",
            minutes
        );
        let mut params: Vec<(String, String)> = vec![
            ("PhoneNumber".into(), phone.to_string()),
            ("SignName".into(), self.sign_name.clone()),
            ("TemplateCode".into(), self.template_code.clone()),
            ("TemplateParam".into(), template_param),
            ("CountryCode".into(), "86".into()),
            ("OutId".into(), out_id.to_string()),
            ("Interval".into(), "60".into()),
            ("ValidTime".into(), valid.to_string()),
            ("ReturnVerifyCode".into(), "false".into()),
            ("CodeType".into(), "1".into()),
        ];
        if !self.scheme_name.is_empty() {
            params.push(("SchemeName".into(), self.scheme_name.clone()));
        }

        let body = self.call("SendSmsVerifyCode", params).await?;
        if !body_ok(&body) {
            return Err(format!(
                "短信验证码发送失败：{}",
                body_message(&body, "阿里云拒绝发送")
            ));
        }
        let model = pick(&body, "Model");
        Ok(SmsSendOutcome {
            biz_id: pick_string(&model, "BizId"),
            out_id: {
                let value = pick_string(&model, "OutId");
                if value.is_empty() {
                    out_id.to_string()
                } else {
                    value
                }
            },
            request_id: pick_string(&body, "RequestId"),
        })
    }

    /// 核销短信验证码，返回校验是否通过。
    pub async fn check_verify_code(
        &self,
        phone: &str,
        verify_code: &str,
        out_id: &str,
    ) -> Result<bool, String> {
        let mut params: Vec<(String, String)> = vec![
            ("PhoneNumber".into(), phone.to_string()),
            ("VerifyCode".into(), verify_code.to_string()),
            ("CountryCode".into(), "86".into()),
            ("OutId".into(), out_id.to_string()),
            ("CaseAuthPolicy".into(), "1".into()),
        ];
        if !self.scheme_name.is_empty() {
            params.push(("SchemeName".into(), self.scheme_name.clone()));
        }

        let body = self.call("CheckSmsVerifyCode", params).await?;
        let code = pick_string(&body, "Code");
        if code != "OK" {
            return Err(format!(
                "验证码核验失败：{}",
                body_message(&body, "阿里云核验失败")
            ));
        }
        let model = pick(&body, "Model");
        Ok(pick_string(&model, "VerifyResult").to_uppercase() == "PASS")
    }

    /// 以 ACS3-HMAC-SHA256 签名调用 RPC 接口。
    async fn call(&self, action: &str, mut params: Vec<(String, String)>) -> Result<Value, String> {
        params.sort_by(|left, right| left.0.cmp(&right.0));
        let body = params
            .iter()
            .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
            .collect::<Vec<_>>()
            .join("&");

        let payload_hash = sha256_hex(body.as_bytes());
        let date = iso8601_now();
        let nonce = uuid::Uuid::new_v4().to_string();
        let content_type = "application/x-www-form-urlencoded";

        let headers: Vec<(&str, String)> = vec![
            ("content-type", content_type.to_string()),
            ("host", self.endpoint.clone()),
            ("x-acs-action", action.to_string()),
            ("x-acs-content-sha256", payload_hash.clone()),
            ("x-acs-date", date),
            ("x-acs-signature-nonce", nonce),
            ("x-acs-version", API_VERSION.to_string()),
        ];
        let canonical_headers = headers
            .iter()
            .map(|(name, value)| format!("{name}:{value}\n"))
            .collect::<String>();
        let signed_headers = headers
            .iter()
            .map(|(name, _)| *name)
            .collect::<Vec<_>>()
            .join(";");

        let canonical_request = format!(
            "POST\n/\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        );
        let string_to_sign = format!(
            "{SIGN_ALGORITHM}\n{}",
            sha256_hex(canonical_request.as_bytes())
        );
        let signature = hex_lower(&hmac_sha256(
            self.access_key_secret.as_bytes(),
            string_to_sign.as_bytes(),
        ));
        let authorization = format!(
            "{SIGN_ALGORITHM} Credential={},SignedHeaders={},Signature={}",
            self.access_key_id, signed_headers, signature
        );

        let url = format!("https://{}/", self.endpoint);
        let mut request = self.client.post(&url);
        for (name, value) in &headers {
            request = request.header(*name, value);
        }
        request = request.header("authorization", authorization);

        let response = request
            .body(body)
            .send()
            .await
            .map_err(|error| format!("短信服务请求失败：{error}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| format!("读取短信服务响应失败：{error}"))?;
        let parsed: Value = serde_json::from_str(&text).unwrap_or_else(|_| {
            serde_json::json!({ "Code": "InvalidResponse", "Message": text })
        });
        if !status.is_success() && pick_string(&parsed, "Code").is_empty() {
            return Err(format!("短信服务返回 HTTP {status}"));
        }
        Ok(parsed)
    }
}

fn pick(value: &Value, key: &str) -> Value {
    value
        .get(key)
        .or_else(|| value.get(&lower_first(key)))
        .cloned()
        .unwrap_or(Value::Null)
}

fn pick_string(value: &Value, key: &str) -> String {
    let raw = pick(value, key);
    match raw {
        Value::String(text) => text,
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn lower_first(key: &str) -> String {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn body_ok(body: &Value) -> bool {
    let code = pick_string(body, "Code");
    let success = match pick(body, "Success") {
        Value::Bool(flag) => flag,
        Value::String(text) => text.eq_ignore_ascii_case("true"),
        _ => false,
    };
    code == "OK" && success
}

fn body_message(body: &Value, fallback: &str) -> String {
    let message = pick_string(body, "Message");
    let code = pick_string(body, "Code");
    let text = if message.is_empty() { fallback.to_string() } else { message };
    let text = if code.is_empty() || code == "OK" {
        text
    } else {
        format!("{text}（{code}）")
    };
    text.chars().take(300).collect()
}

/// RFC 3986 百分号编码（阿里云签名要求）。
pub fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn sha256_hex(data: &[u8]) -> String {
    hex_lower(&Sha256::digest(data))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
    const BLOCK: usize = 64;
    let mut block_key = if key.len() > BLOCK {
        Sha256::digest(key).to_vec()
    } else {
        key.to_vec()
    };
    block_key.resize(BLOCK, 0);
    let mut inner_pad = vec![0u8; BLOCK];
    let mut outer_pad = vec![0u8; BLOCK];
    for index in 0..BLOCK {
        inner_pad[index] = block_key[index] ^ 0x36;
        outer_pad[index] = block_key[index] ^ 0x5c;
    }
    let mut inner = Sha256::new();
    inner.update(&inner_pad);
    inner.update(message);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(&outer_pad);
    outer.update(&inner_hash);
    outer.finalize().to_vec()
}

fn iso8601_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);
    format_iso8601(seconds)
}

fn format_iso8601(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let remainder = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month,
        day,
        remainder / 3_600,
        (remainder % 3_600) / 60,
        remainder % 60
    )
}

/// Howard Hinnant 的 civil_from_days 算法，避免引入额外日期库。
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_sha256_matches_rfc4231_case1() {
        let key = vec![0x0b_u8; 20];
        let tag = hex_lower(&hmac_sha256(&key, b"Hi There"));
        assert_eq!(
            tag,
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn hmac_sha256_matches_rfc4231_case2() {
        let tag = hex_lower(&hmac_sha256(b"Jefe", b"what do ya want for nothing?"));
        assert_eq!(
            tag,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn percent_encode_follows_rfc3986() {
        assert_eq!(percent_encode("a b~c*d"), "a%20b~c%2Ad");
        assert_eq!(
            percent_encode("{\"code\":\"##code##\",\"min\":\"5\"}"),
            "%7B%22code%22%3A%22%23%23code%23%23%22%2C%22min%22%3A%225%22%7D"
        );
    }

    #[test]
    fn iso8601_formats_known_timestamps() {
        assert_eq!(format_iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_iso8601(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn canonical_request_shape_is_stable() {
        // 只校验换行结构，避免签名规则被无意改坏。
        let headers = vec![
            ("host", "dypnsapi.aliyuncs.com".to_string()),
            ("x-acs-action", "SendSmsVerifyCode".to_string()),
        ];
        let canonical_headers = headers
            .iter()
            .map(|(name, value)| format!("{name}:{value}\n"))
            .collect::<String>();
        let signed_headers = "host;x-acs-action";
        let request = format!("POST\n/\n\n{canonical_headers}\n{signed_headers}\nHASH");
        assert!(request.starts_with("POST\n/\n\nhost:dypnsapi.aliyuncs.com\n"));
        assert!(request.contains("\n\nhost;x-acs-action\nHASH"));
    }
}

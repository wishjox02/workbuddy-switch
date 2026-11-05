//! 后台敏感配置的对称加密。
//!
//! 使用 AES-256-GCM，主密钥来自 `WB_ADMIN_MASTER_KEY`（32 字节 base64 或 64 位 hex），
//! 与 Sub2API 密钥库共用同一把主密钥。数据库里只保存 base64 的 nonce 与密文，
//! 管理接口只回打码提示（例如 `LTA...9f2c`），不回明文。

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::RngCore;

pub struct SecretVault {
    key: [u8; 32],
}

impl SecretVault {
    /// 从环境变量读取主密钥。
    pub fn from_env() -> Result<Self, String> {
        let raw = std::env::var("WB_ADMIN_MASTER_KEY").map_err(|_| {
            "未设置 WB_ADMIN_MASTER_KEY（需要 32 字节 base64 或 64 位 hex 密钥）".to_string()
        })?;
        Ok(Self { key: decode_master_key(&raw)? })
    }

    /// 加密明文，返回 `(base64 nonce, base64 密文)`。
    pub fn encrypt(&self, plaintext: &str) -> Result<(String, String), String> {
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| "主密钥无效".to_string())?;
        let mut nonce = [0_u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
            .map_err(|_| "敏感配置加密失败".to_string())?;
        Ok((BASE64.encode(nonce), BASE64.encode(ciphertext)))
    }

    /// 解密数据库中的密文。
    pub fn decrypt(&self, nonce_b64: &str, ciphertext_b64: &str) -> Result<String, String> {
        if nonce_b64.is_empty() || ciphertext_b64.is_empty() {
            return Err("尚未保存密钥".to_string());
        }
        let nonce = BASE64.decode(nonce_b64).map_err(|_| "密文 nonce 不是有效 base64".to_string())?;
        if nonce.len() != 12 {
            return Err("密文 nonce 长度无效".to_string());
        }
        let ciphertext = BASE64.decode(ciphertext_b64).map_err(|_| "密文不是有效 base64".to_string())?;
        let plaintext = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|_| "主密钥无效".to_string())?
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|_| "解密失败，可能需要重新配置 WB_ADMIN_MASTER_KEY".to_string())?;
        String::from_utf8(plaintext).map_err(|_| "明文编码无效".to_string())
    }
}

/// 生成打码提示：保留前 3 位与后 4 位。
pub fn hint(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    if chars.len() <= 8 {
        return "••••".to_string();
    }
    let head: String = chars[..3].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}...{tail}")
}

fn decode_master_key(raw: &str) -> Result<[u8; 32], String> {
    let trimmed = raw.trim();
    let bytes = if trimmed.len() == 64 && trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        (0..32)
            .map(|index| u8::from_str_radix(&trimmed[index * 2..index * 2 + 2], 16))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "WB_ADMIN_MASTER_KEY hex 无效".to_string())?
    } else {
        BASE64
            .decode(trimmed)
            .map_err(|_| "WB_ADMIN_MASTER_KEY 必须是 32 字节 base64 或 64 位 hex".to_string())?
    };
    bytes.try_into().map_err(|_| "WB_ADMIN_MASTER_KEY 必须正好是 32 字节".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7_u8; 32];

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let vault = SecretVault { key: KEY };
        let (nonce, ciphertext) = vault.encrypt("LTAI-test-secret").expect("加密失败");
        assert!(!nonce.is_empty() && !ciphertext.is_empty());
        assert_ne!(ciphertext, "LTAI-test-secret");
        assert_eq!(vault.decrypt(&nonce, &ciphertext).expect("解密失败"), "LTAI-test-secret");
    }

    #[test]
    fn wrong_key_cannot_decrypt() {
        let vault = SecretVault { key: KEY };
        let (nonce, ciphertext) = vault.encrypt("secret-value").expect("加密失败");
        let other = SecretVault { key: [9_u8; 32] };
        assert!(other.decrypt(&nonce, &ciphertext).is_err());
    }

    #[test]
    fn hint_masks_middle() {
        assert_eq!(hint("LTAI5tAbCdEfGhIjKlMnOpQr9f2c"), "LTA...9f2c");
        assert_eq!(hint("short"), "••••");
        assert_eq!(hint(""), "");
    }

    #[test]
    fn decode_master_key_accepts_hex_and_base64() {
        let hex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        assert!(decode_master_key(hex).is_ok());
        let base64 = BASE64.encode([5_u8; 32]);
        assert!(decode_master_key(&base64).is_ok());
        assert!(decode_master_key("too-short").is_err());
    }
}

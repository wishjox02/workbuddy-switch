use serde_json::{json, Map, Value};
use std::path::PathBuf;

const LOCAL_PROXY_KEY: &str = "wb-switch-local";

pub fn models_path() -> PathBuf {
    let home = home_dir();
    home.join(".workbuddy").join("models.json")
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn disabled_models_path() -> PathBuf {
    home_dir().join(".workbuddy").join("models.disabled.json")
}

fn load_json_array(path: &PathBuf) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("读取 WorkBuddy 模型文件失败：{error}"))?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("WorkBuddy 模型文件格式无效：{error}"))?;
    Ok(value.as_array().cloned().unwrap_or_default())
}

fn write_json_array(path: &PathBuf, models: &[Value]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建 WorkBuddy 模型目录失败：{error}"))?;
    }
    let text = serde_json::to_string_pretty(models)
        .map_err(|error| format!("序列化 WorkBuddy 模型失败：{error}"))?;
    let tmp = path.with_extension("json.wb-switch-tmp");
    std::fs::write(&tmp, format!("{text}\n"))
        .map_err(|error| format!("写入 WorkBuddy 模型临时文件失败：{error}"))?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("替换 WorkBuddy 模型文件失败：{error}"));
    }
    Ok(())
}

pub fn disabled_models() -> Result<Vec<Value>, String> {
    Ok(load_json_array(&disabled_models_path())?
        .into_iter()
        .filter_map(|mut model| {
            let object = model.as_object_mut()?;
            object.remove("apiKey");
            Some(model)
        })
        .collect())
}

/// 禁用一个模型：从 models.json 移除并完整备份到 models.disabled.json。
/// 返回剩余模型列表。
pub fn disable(id: &str) -> Result<Vec<Value>, String> {
    let id = id.trim();
    let mut current = load()?;
    let Some(index) = current.iter().position(|item| item.get("id").and_then(Value::as_str) == Some(id)) else {
        return Err("模型不存在于 WorkBuddy 配置".to_string());
    };
    let removed = current.remove(index);
    let mut disabled = load_json_array(&disabled_models_path())?;
    if !disabled.iter().any(|item| item.get("id").and_then(Value::as_str) == Some(id)) {
        disabled.push(removed);
    }
    write_json_array(&disabled_models_path(), &disabled)?;
    save(&current)?;
    public_models()
}

/// 启用一个被禁用的模型：从 models.disabled.json 恢复回 models.json。
pub fn enable(id: &str) -> Result<Vec<Value>, String> {
    let id = id.trim();
    let mut disabled = load_json_array(&disabled_models_path())?;
    let Some(index) = disabled.iter().position(|item| item.get("id").and_then(Value::as_str) == Some(id)) else {
        return Err("该模型没有被禁用".to_string());
    };
    let restored = disabled.remove(index);
    write_json_array(&disabled_models_path(), &disabled)?;
    let mut current = load()?;
    if let Some(existing) = current.iter_mut().find(|item| item.get("id").and_then(Value::as_str) == Some(id)) {
        *existing = restored;
    } else {
        current.push(restored);
    }
    save(&current)?;
    public_models()
}

pub fn proxy_key() -> &'static str {
    LOCAL_PROXY_KEY
}

pub fn load() -> Result<Vec<Value>, String> {
    load_json_array(&models_path())
}

pub fn public_models() -> Result<Vec<Value>, String> {
    let disabled = load_json_array(&disabled_models_path())?;
    let disabled_ids: Vec<String> = disabled
        .iter()
        .filter_map(|model| model.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut result = Vec::new();
    for mut model in load()? {
        if let Some(object) = model.as_object_mut() {
            let managed = object.get("wbSwitchManaged").and_then(Value::as_bool).unwrap_or(false);
            let id = object.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_default();
            object.remove("apiKey");
            object.insert("managed".to_string(), json!(managed));
            object.insert("disabled".to_string(), json!(false));
            let _ = id;
            result.push(model);
        }
    }
    for mut model in disabled {
        if let Some(object) = model.as_object_mut() {
            let managed = object.get("wbSwitchManaged").and_then(Value::as_bool).unwrap_or(false);
            object.remove("apiKey");
            object.insert("managed".to_string(), json!(managed));
            object.insert("disabled".to_string(), json!(true));
            result.push(model);
        }
    }
    let _ = disabled_ids;
    Ok(result)
}

pub fn import(models: &[Value], endpoint_url: &str, api_key: Option<&str>, managed_user_id: Option<i64>) -> Result<Vec<Value>, String> {
    let mut current = load()?;
    for input in models {
        let Some(id) = input.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if id.is_empty() || id.len() > 256 {
            continue;
        }
        let name = input
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(id);
        let vendor = input
            .get("vendor")
            .or_else(|| input.get("provider"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Sub2API");
        let mut entry = Map::new();
        entry.insert("id".to_string(), json!(id));
        entry.insert("name".to_string(), json!(name));
        entry.insert("vendor".to_string(), json!(vendor));
        entry.insert("url".to_string(), json!(endpoint_url));
        entry.insert("apiKey".to_string(), json!(api_key.unwrap_or(LOCAL_PROXY_KEY)));
        entry.insert("wbSwitchManaged".to_string(), json!(managed_user_id.is_some()));
        if let Some(user_id) = managed_user_id {
            entry.insert("wbSwitchUserId".to_string(), json!(user_id));
        }
        entry.insert("supportsToolCall".to_string(), json!(true));
        entry.insert("supportsImages".to_string(), json!(false));
        entry.insert("supportsReasoning".to_string(), json!(false));
        entry.insert("useCustomProtocol".to_string(), json!(false));
        let value = Value::Object(entry);
        if let Some(existing) = current.iter_mut().find(|item| item.get("id").and_then(Value::as_str) == Some(id)) {
            *existing = value;
        } else {
            current.push(value);
        }
    }
    save(&current)?;
    public_models()
}

pub fn remove(id: &str) -> Result<Vec<Value>, String> {
    let id = id.trim();
    let mut current = load()?;
    let Some(index) = current.iter().position(|item| item.get("id").and_then(Value::as_str) == Some(id)) else {
        return Err("模型不存在于 WorkBuddy 配置".to_string());
    };
    if current[index].get("wbSwitchManaged").and_then(Value::as_bool) != Some(true) {
        return Err("该模型不是本工具导入的模型，不能删除；可以重新导入接管".to_string());
    }
    current.remove(index);
    save(&current)?;
    public_models()
}

/// 移除所有由本工具导入（`wbSwitchManaged` 为 true）的模型。
/// WorkBuddy 原有模型不受影响。返回 (剩余模型, 已移除数量)。
pub fn remove_all() -> Result<(Vec<Value>, usize), String> {
    let current = load()?;
    let mut remaining = Vec::with_capacity(current.len());
    let mut removed = 0usize;
    for model in current {
        let managed = model.get("wbSwitchManaged").and_then(Value::as_bool).unwrap_or(false);
        if managed { removed += 1; } else { remaining.push(model); }
    }
    save(&remaining)?;
    Ok((public_models()?, removed))
}

fn save(models: &[Value]) -> Result<(), String> {
    let path = models_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建 WorkBuddy 模型目录失败：{error}"))?;
    }
    let text = serde_json::to_string_pretty(models)
        .map_err(|error| format!("序列化 WorkBuddy 模型失败：{error}"))?;
    let tmp = path.with_extension("json.wb-switch-tmp");
    std::fs::write(&tmp, format!("{text}\n"))
        .map_err(|error| format!("写入 WorkBuddy 模型临时文件失败：{error}"))?;
    if let Err(error) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("替换 WorkBuddy 模型文件失败：{error}"));
    }
    Ok(())
}

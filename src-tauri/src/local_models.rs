use serde_json::{json, Value};
use serde_yaml::{Mapping as YamlMapping, Value as YamlValue};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const MANAGED_PROVIDER: &str = "wb-switch";

struct ModelPaths {
    workbuddy: PathBuf,
    workbuddy_disabled: PathBuf,
    workbuddy_templates: PathBuf,
    dsh: PathBuf,
    dsh_disabled: PathBuf,
}

impl ModelPaths {
    fn from_home(home: &Path) -> Self {
        let workbuddy = home.join(".workbuddy");
        let dsh = home.join(".dsh").join("profiles").join("desktop");
        Self {
            workbuddy: workbuddy.join("models.json"),
            workbuddy_disabled: workbuddy.join("models.disabled.json"),
            workbuddy_templates: workbuddy.join("models.wb-switch-templates.json"),
            dsh: dsh.join("cordis.patch.yml"),
            dsh_disabled: dsh.join("dsh-models.disabled.json"),
        }
    }
}

fn paths() -> ModelPaths {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    ModelPaths::from_home(&home)
}

fn read_json_array(path: &Path) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("读取模型文件失败：{error}"))?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|error| format!("模型文件格式无效：{error}"))
}

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建模型目录失败：{error}"))?;
    }
    wb_switch_core::modules::config::atomic_write(path, text)
        .map_err(|error| format!("写入模型文件失败：{error}"))
}

fn write_json_array(path: &Path, items: &[Value]) -> Result<(), String> {
    let text =
        serde_json::to_string_pretty(items).map_err(|error| format!("序列化模型失败：{error}"))?;
    write_text(path, &format!("{text}\n"))
}

fn model_id(model: &Value) -> Option<&str> {
    model.get("id").and_then(Value::as_str)
}

fn managed(model: &Value) -> bool {
    model.get("wbSwitchManaged").and_then(Value::as_bool) == Some(true)
}

fn managed_user_id(model: &Value) -> Option<i64> {
    model.get("wbSwitchUserId").and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str()?.parse::<i64>().ok())
    })
}

fn real_template(model: &Value) -> bool {
    let url = model
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let key = model
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    managed(model)
        && (url.starts_with("https://") || url.starts_with("http://"))
        && !url.contains("127.0.0.1:57900")
        && !url.contains("localhost:57900")
        && key.starts_with("sk-")
        && key.len() > 3
}

fn usable_template(model: &Value, user_id: i64) -> bool {
    real_template(model) && managed_user_id(model) == Some(user_id)
}

/// Keep a real connection template independent from the active/disabled model lists.
///
/// WorkBuddy's model file is also the source of truth for the models shown in the UI. If
/// the last managed model is removed, there is no longer an entry from which a later import
/// can copy the user's real endpoint and key. The separate template file intentionally stores
/// only managed, user-tagged entries with a real HTTP(S) endpoint and an `sk-` key. Invalid or
/// placeholder entries are ignored so they can never become an import fallback.
fn remember_workbuddy_template(paths: &ModelPaths, model: &Value) -> Result<(), String> {
    let Some(user_id) = managed_user_id(model) else {
        return Ok(());
    };
    if !usable_template(model, user_id) {
        return Ok(());
    }

    let mut templates = read_json_array(&paths.workbuddy_templates)?;
    let Some(index) = templates
        .iter()
        .position(|template| managed_user_id(template) == Some(user_id))
    else {
        templates.push(model.clone());
        return write_json_array(&paths.workbuddy_templates, &templates);
    };
    // Keep the most recently removed real connection for this user. A single user may have
    // several model entries, but they should all use the same endpoint/key in normal config.
    templates[index] = model.clone();
    write_json_array(&paths.workbuddy_templates, &templates)
}

fn public_workbuddy(paths: &ModelPaths) -> Result<Vec<Value>, String> {
    let active = read_json_array(&paths.workbuddy)?;
    let active_ids: HashSet<String> = active
        .iter()
        .filter_map(|model| model_id(model).map(str::to_string))
        .collect();
    let disabled = read_json_array(&paths.workbuddy_disabled)?;
    let mut result = Vec::new();
    for (models, is_disabled) in [(&active, false), (&disabled, true)] {
        for model in models {
            if is_disabled && model_id(model).is_some_and(|id| active_ids.contains(id)) {
                continue;
            }
            if let Some(mut object) = model.as_object().cloned() {
                object.remove("apiKey");
                object.insert("managed".into(), json!(managed(model)));
                object.insert("disabled".into(), json!(is_disabled));
                result.push(Value::Object(object));
            }
        }
    }
    Ok(result)
}

fn workbuddy_import(
    paths: &ModelPaths,
    models: Vec<Value>,
    user_id: i64,
) -> Result<Vec<Value>, String> {
    let mut active = read_json_array(&paths.workbuddy)?;
    let mut disabled = read_json_array(&paths.workbuddy_disabled)?;
    let templates = read_json_array(&paths.workbuddy_templates)?;
    let candidates: Vec<Value> = active
        .iter()
        .chain(disabled.iter())
        .chain(templates.iter())
        .filter(|model| real_template(model))
        .cloned()
        .collect();
    let template = candidates
        .iter()
        .find(|model| usable_template(model, user_id))
        .cloned();
    let mut changed = false;

    for input in models {
        let Some(id) = model_id(&input)
            .map(str::trim)
            .filter(|id| !id.is_empty() && id.len() <= 256)
        else {
            continue;
        };
        if let Some(existing) = active.iter().find(|model| model_id(model) == Some(id)) {
            if !managed(existing) || managed_user_id(existing) != Some(user_id) {
                return Err(format!("模型 {id} 已在本机配置中，不能接管或覆盖"));
            }
            continue;
        }
        if let Some(index) = disabled
            .iter()
            .position(|model| model_id(model) == Some(id))
        {
            if !managed(&disabled[index]) || managed_user_id(&disabled[index]) != Some(user_id) {
                return Err(format!("模型 {id} 已在本机禁用配置中，不能接管或覆盖"));
            }
            active.push(disabled.remove(index));
            changed = true;
            continue;
        }
        let mut entry = template.clone().ok_or_else(|| {
            "本机没有当前用户可用的 WorkBuddy 模型连接模板，无法安全导入新模型".to_string()
        })?;
        let object = entry.as_object_mut().ok_or("WorkBuddy 模型模板格式无效")?;
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
        object.insert("id".into(), json!(id));
        object.insert("name".into(), json!(name));
        object.insert("vendor".into(), json!(vendor));
        object.insert("wbSwitchUserId".into(), json!(user_id));
        active.push(entry);
        changed = true;
    }
    if changed {
        // Restoring from the disabled file writes the usable copy first.
        write_json_array(&paths.workbuddy, &active)?;
        write_json_array(&paths.workbuddy_disabled, &disabled)?;
    }
    public_workbuddy(paths)
}

fn workbuddy_update_connection(
    paths: &ModelPaths,
    user_id: i64,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<Value>, String> {
    let base_url = base_url.trim().trim_end_matches('/');
    let api_key = api_key.trim();
    if user_id <= 0
        || !real_template(&json!({
            "url": base_url,
            "apiKey": api_key,
            "wbSwitchManaged": true,
        }))
    {
        return Err("当前用户的模型连接参数无效".into());
    }

    let mut active = read_json_array(&paths.workbuddy)?;
    let mut disabled = read_json_array(&paths.workbuddy_disabled)?;
    let mut templates = read_json_array(&paths.workbuddy_templates)?;
    let original_active = active.clone();
    let original_disabled = disabled.clone();
    let original_templates = templates.clone();
    let mut template = active
        .iter()
        .chain(disabled.iter())
        .chain(templates.iter())
        .find(|model| managed(model))
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "id": "wb-switch-template",
                "name": "wb-switch-template",
                "vendor": "Sub2API",
                "maxInputTokens": 200000,
                "maxOutputTokens": 65536,
                "supportsImages": false,
                "supportsReasoning": false,
                "supportsToolCall": true,
                "useCustomProtocol": false,
                "wbSwitchManaged": true,
            })
        });
    for models in [&mut active, &mut disabled] {
        for model in models.iter_mut().filter(|model| managed(model)) {
            let object = model.as_object_mut().ok_or("WorkBuddy 模型格式无效")?;
            object.insert("url".into(), json!(base_url));
            object.insert("apiKey".into(), json!(api_key));
            object.insert("wbSwitchUserId".into(), json!(user_id));
        }
    }
    templates.retain(|model| !managed(model));
    let object = template
        .as_object_mut()
        .ok_or("WorkBuddy 模型模板格式无效")?;
    object.insert("url".into(), json!(base_url));
    object.insert("apiKey".into(), json!(api_key));
    object.insert("wbSwitchUserId".into(), json!(user_id));
    templates.push(template);

    if active != original_active {
        write_json_array(&paths.workbuddy, &active)?;
    }
    if disabled != original_disabled {
        write_json_array(&paths.workbuddy_disabled, &disabled)?;
    }
    if templates != original_templates {
        write_json_array(&paths.workbuddy_templates, &templates)?;
    }
    public_workbuddy(paths)
}

fn workbuddy_clear_connection(paths: &ModelPaths) -> Result<(), String> {
    for path in [
        &paths.workbuddy,
        &paths.workbuddy_disabled,
        &paths.workbuddy_templates,
    ] {
        let mut models = read_json_array(path)?;
        let mut changed = false;
        for model in models.iter_mut().filter(|model| managed(model)) {
            if let Some(object) = model.as_object_mut() {
                changed |= object.remove("apiKey").is_some();
                changed |= object.remove("wbSwitchUserId").is_some();
            }
        }
        if changed {
            write_json_array(path, &models)?;
        }
    }
    Ok(())
}

fn workbuddy_remove(paths: &ModelPaths, id: &str) -> Result<Vec<Value>, String> {
    let active = read_json_array(&paths.workbuddy)?;
    if let Some(index) = active.iter().position(|model| model_id(model) == Some(id)) {
        return if managed(&active[index]) {
            Err("Switch 管理模型只能禁用或启用，不能移除".into())
        } else {
            Err("第三方 WorkBuddy 模型请使用带 external 标记的移除命令".into())
        };
    }
    let disabled = read_json_array(&paths.workbuddy_disabled)?;
    if let Some(index) = disabled
        .iter()
        .position(|model| model_id(model) == Some(id))
    {
        return if managed(&disabled[index]) {
            Err("Switch 管理模型只能禁用或启用，不能移除".into())
        } else {
            Err("第三方 WorkBuddy 模型请使用带 external 标记的移除命令".into())
        };
    }
    Err("模型不存在于 WorkBuddy 配置".into())
}

fn workbuddy_remove_external(paths: &ModelPaths, id: &str) -> Result<Vec<Value>, String> {
    let mut active = read_json_array(&paths.workbuddy)?;
    if let Some(index) = active.iter().position(|model| model_id(model) == Some(id)) {
        if managed(&active[index]) {
            return Err("Switch 管理模型只能禁用或启用，不能移除".into());
        }
        active.remove(index);
        write_json_array(&paths.workbuddy, &active)?;
        return public_workbuddy(paths);
    }

    let mut disabled = read_json_array(&paths.workbuddy_disabled)?;
    if let Some(index) = disabled
        .iter()
        .position(|model| model_id(model) == Some(id))
    {
        if managed(&disabled[index]) {
            return Err("Switch 管理模型只能禁用或启用，不能移除".into());
        }
        disabled.remove(index);
        write_json_array(&paths.workbuddy_disabled, &disabled)?;
        return public_workbuddy(paths);
    }
    Err("模型不存在于 WorkBuddy 配置".into())
}

fn workbuddy_remove_all(paths: &ModelPaths) -> Result<(Vec<Value>, usize), String> {
    let _ = paths;
    Err("Switch 管理模型只能禁用或启用，不能批量移除".into())
}

fn workbuddy_disable(paths: &ModelPaths, id: &str) -> Result<Vec<Value>, String> {
    let mut active = read_json_array(&paths.workbuddy)?;
    let index = active
        .iter()
        .position(|model| model_id(model) == Some(id))
        .ok_or("模型不存在于 WorkBuddy 配置")?;
    remember_workbuddy_template(paths, &active[index])?;
    let model = active.remove(index);
    let mut disabled = read_json_array(&paths.workbuddy_disabled)?;
    if let Some(index) = disabled.iter().position(|item| model_id(item) == Some(id)) {
        disabled[index] = model;
    } else {
        disabled.push(model);
    }
    write_json_array(&paths.workbuddy_disabled, &disabled)?;
    write_json_array(&paths.workbuddy, &active)?;
    public_workbuddy(paths)
}

fn workbuddy_enable(paths: &ModelPaths, id: &str) -> Result<Vec<Value>, String> {
    let mut disabled = read_json_array(&paths.workbuddy_disabled)?;
    let index = disabled
        .iter()
        .position(|model| model_id(model) == Some(id))
        .ok_or("该模型没有被禁用")?;
    let mut active = read_json_array(&paths.workbuddy)?;
    if active.iter().any(|model| model_id(model) == Some(id)) {
        return Err("本机已有同名活动模型，不能覆盖".into());
    }
    active.push(disabled.remove(index));
    write_json_array(&paths.workbuddy, &active)?;
    write_json_array(&paths.workbuddy_disabled, &disabled)?;
    public_workbuddy(paths)
}

fn yaml_root(paths: &ModelPaths) -> Result<YamlValue, String> {
    if !paths.dsh.exists() {
        return Ok(YamlValue::Sequence(Vec::new()));
    }
    let text = std::fs::read_to_string(&paths.dsh)
        .map_err(|error| format!("读取 Harness 配置失败：{error}"))?;
    serde_yaml::from_str(&text).map_err(|error| format!("Harness 配置格式无效：{error}"))
}

fn yaml_key(key: &str) -> YamlValue {
    YamlValue::String(key.to_string())
}

fn dsh_providers(root: &YamlValue) -> Option<&YamlMapping> {
    let entry = root
        .as_sequence()?
        .iter()
        .find(|item| item.get("id").and_then(YamlValue::as_str) == Some("llm-pi-ai"))?;
    entry.get("config")?.get("providers")?.as_mapping()
}

fn dsh_provider_mut(root: &mut YamlValue) -> Result<Option<&mut YamlMapping>, String> {
    dsh_provider_mut_by_name(root, MANAGED_PROVIDER)
}

fn dsh_provider_mut_by_name<'a>(
    root: &'a mut YamlValue,
    provider_name: &str,
) -> Result<Option<&'a mut YamlMapping>, String> {
    let entries = root.as_sequence_mut().ok_or("Harness 配置根节点不是数组")?;
    let Some(entry) = entries
        .iter_mut()
        .find(|item| item.get("id").and_then(YamlValue::as_str) == Some("llm-pi-ai"))
    else {
        return Ok(None);
    };
    let config = entry
        .get_mut("config")
        .and_then(YamlValue::as_mapping_mut)
        .ok_or("Harness 配置缺少 config")?;
    let providers = config
        .get_mut(yaml_key("providers"))
        .and_then(YamlValue::as_mapping_mut)
        .ok_or("Harness 配置缺少 providers")?;
    Ok(providers
        .get_mut(yaml_key(provider_name))
        .and_then(YamlValue::as_mapping_mut))
}

fn dsh_provider_name_for_model(root: &YamlValue, id: &str) -> Option<String> {
    let providers = dsh_providers(root)?;

    // Prefer the managed provider when a model ID appears in more than one provider. The
    // existing disable command only receives an ID; using a stable preference keeps that
    // command from disabling an unrelated provider's duplicate model.
    if providers
        .get(yaml_key(MANAGED_PROVIDER))
        .and_then(|provider| provider.get("models"))
        .and_then(YamlValue::as_sequence)
        .into_iter()
        .flatten()
        .any(|model| dsh_model_id(model) == Some(id))
    {
        return Some(MANAGED_PROVIDER.to_string());
    }

    providers.iter().find_map(|(name, provider)| {
        let provider_name = name.as_str()?;
        if provider_name == MANAGED_PROVIDER {
            return None;
        }
        let found = provider
            .get("models")
            .and_then(YamlValue::as_sequence)
            .into_iter()
            .flatten()
            .any(|model| dsh_model_id(model) == Some(id));
        found.then(|| provider_name.to_string())
    })
}

fn usable_dsh_provider(provider: &YamlMapping) -> bool {
    let base = provider
        .get(yaml_key("baseURL"))
        .and_then(YamlValue::as_str)
        .unwrap_or("")
        .trim();
    let key_env = provider
        .get(yaml_key("apiKeyEnv"))
        .and_then(YamlValue::as_str)
        .unwrap_or("")
        .trim();
    (base.starts_with("https://") || base.starts_with("http://"))
        && !base.contains("127.0.0.1:57900")
        && !base.contains("localhost:57900")
        && !key_env.is_empty()
}

fn dsh_model_id(model: &YamlValue) -> Option<&str> {
    model.get("id").and_then(YamlValue::as_str)
}

fn dsh_managed(model: &YamlValue) -> bool {
    model.get("managed").and_then(YamlValue::as_bool) != Some(false)
}

fn dsh_disabled_provider_name(model: &Value) -> &str {
    model
        .get("providerName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(MANAGED_PROVIDER)
}

fn public_dsh(paths: &ModelPaths) -> Result<Vec<Value>, String> {
    let root = yaml_root(paths)?;
    let mut result = Vec::new();
    let mut active_model_keys = HashSet::new();
    if let Some(providers) = dsh_providers(&root) {
        for (name, provider) in providers {
            let provider_name = name.as_str().unwrap_or("unknown");
            let models = provider.get("models").and_then(YamlValue::as_sequence);
            for model in models.into_iter().flatten() {
                let Some(id) = dsh_model_id(model) else {
                    continue;
                };
                let name = model.get("name").and_then(YamlValue::as_str).unwrap_or(id);
                let managed = provider_name == MANAGED_PROVIDER && dsh_managed(model);
                active_model_keys.insert((provider_name.to_string(), id.to_string()));
                result.push(json!({"id": id, "name": name, "providerName": provider_name, "managed": managed, "disabled": false}));
            }
        }
    }
    let disabled = read_json_array(&paths.dsh_disabled)?;
    for model in &disabled {
        let Some(id) = model_id(&model) else {
            continue;
        };
        let provider_name = dsh_disabled_provider_name(&model);
        if !active_model_keys.insert((provider_name.to_string(), id.to_string())) {
            continue;
        }
        let name = model.get("name").and_then(Value::as_str).unwrap_or(id);
        let managed = provider_name == MANAGED_PROVIDER
            && disabled.iter().any(|item| {
                model_id(item) == Some(id)
                    && dsh_disabled_provider_name(item) == provider_name
                    && item.get("managed").and_then(Value::as_bool) != Some(false)
            });
        result.push(json!({"id": id, "name": name, "providerName": provider_name, "managed": managed, "disabled": true}));
    }
    Ok(result)
}

fn dsh_save(paths: &ModelPaths, root: &YamlValue) -> Result<(), String> {
    let text =
        serde_yaml::to_string(root).map_err(|error| format!("序列化 Harness 配置失败：{error}"))?;
    write_text(&paths.dsh, &text)
}

fn dsh_import(paths: &ModelPaths, models: Vec<Value>) -> Result<Vec<Value>, String> {
    let mut root = yaml_root(paths)?;
    let mut disabled = read_json_array(&paths.dsh_disabled)?;
    let provider = dsh_provider_mut(&mut root)?
        .ok_or("Harness 中不存在 wb-switch provider，不能创建缺少连接配置的 provider")?;
    if !usable_dsh_provider(provider) {
        return Err("Harness wb-switch provider 缺少有效 baseURL 或 apiKeyEnv".into());
    }
    let list = provider
        .get_mut(yaml_key("models"))
        .and_then(YamlValue::as_sequence_mut)
        .ok_or("Harness wb-switch models 不是数组")?;
    let mut changed = false;
    for input in models {
        let Some(id) = model_id(&input)
            .map(str::trim)
            .filter(|id| !id.is_empty() && id.len() <= 256)
        else {
            continue;
        };
        if let Some(existing) = list.iter().find(|model| dsh_model_id(model) == Some(id)) {
            if !dsh_managed(existing) {
                return Err(format!("模型 {id} 已在 Harness 中配置，不能接管或覆盖"));
            }
            continue;
        }
        if disabled.iter().any(|model| {
            model_id(model) == Some(id) && dsh_disabled_provider_name(model) == MANAGED_PROVIDER
        }) {
            if disabled.iter().any(|model| {
                model_id(model) == Some(id)
                    && dsh_disabled_provider_name(model) == MANAGED_PROVIDER
                    && model.get("managed").and_then(Value::as_bool) == Some(false)
            }) {
                return Err(format!("模型 {id} 是第三方或非托管的禁用配置，不能接管"));
            }
            let mut i = 0;
            while i < disabled.len() {
                if model_id(&disabled[i]) != Some(id)
                    || dsh_disabled_provider_name(&disabled[i]) != MANAGED_PROVIDER
                {
                    i += 1;
                    continue;
                }
                let mut restored = disabled.remove(i);
                if let Some(object) = restored.as_object_mut() {
                    object.remove("providerName");
                }
                list.push(
                    serde_yaml::to_value(restored)
                        .map_err(|error| format!("恢复 Harness 模型失败：{error}"))?,
                );
            }
        } else {
            let name = input
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(id);
            list.push(
                serde_yaml::to_value(json!({"id": id, "name": name, "managed": true}))
                    .map_err(|error| format!("写入 Harness 模型失败：{error}"))?,
            );
        }
        changed = true;
    }
    if changed {
        // A restored model is written to the active provider before its disabled copy is removed.
        dsh_save(paths, &root)?;
        write_json_array(&paths.dsh_disabled, &disabled)?;
    }
    public_dsh(paths)
}

fn dsh_remove(paths: &ModelPaths, id: &str) -> Result<Vec<Value>, String> {
    let root = yaml_root(paths)?;
    if let Some(provider_name) = dsh_provider_name_for_model(&root, id) {
        if provider_name == MANAGED_PROVIDER {
            if let Some(provider) = dsh_providers(&root).and_then(|providers| {
                providers
                    .get(yaml_key(MANAGED_PROVIDER))
                    .and_then(YamlValue::as_mapping)
            }) {
                if let Some(model) = provider
                    .get(yaml_key("models"))
                    .and_then(YamlValue::as_sequence)
                    .into_iter()
                    .flatten()
                    .find(|model| dsh_model_id(model) == Some(id))
                {
                    if dsh_managed(model) {
                        return Err("Switch 管理模型只能禁用或启用，不能移除".into());
                    }
                }
            }
        }
        return Err("第三方 Harness 模型请使用带 providerName 的移除命令".into());
    }

    let disabled = read_json_array(&paths.dsh_disabled)?;
    if let Some(model) = disabled.iter().find(|model| model_id(model) == Some(id)) {
        if dsh_disabled_provider_name(model) == MANAGED_PROVIDER
            && model.get("managed").and_then(Value::as_bool) != Some(false)
        {
            return Err("Switch 管理模型只能禁用或启用，不能移除".into());
        }
        return Err("第三方 Harness 模型请使用带 providerName 的移除命令".into());
    }
    Err("模型不存在于 Harness 配置".into())
}

fn dsh_remove_external(
    paths: &ModelPaths,
    id: &str,
    provider_name: &str,
) -> Result<Vec<Value>, String> {
    let provider_name = provider_name.trim();
    if provider_name.is_empty() {
        return Err("移除 Harness 第三方模型必须提供 providerName".into());
    }

    let mut root = yaml_root(paths)?;
    let mut disabled = read_json_array(&paths.dsh_disabled)?;
    if let Some(provider) = dsh_provider_mut_by_name(&mut root, provider_name)? {
        if let Some(models) = provider
            .get_mut(yaml_key("models"))
            .and_then(YamlValue::as_sequence_mut)
        {
            if models.iter().any(|model| dsh_model_id(model) == Some(id)) {
                if provider_name == MANAGED_PROVIDER
                    && models
                        .iter()
                        .any(|model| dsh_model_id(model) == Some(id) && dsh_managed(model))
                {
                    return Err("Switch 管理模型只能禁用或启用，不能移除".into());
                }
                if provider_name == MANAGED_PROVIDER
                    && disabled.iter().any(|model| {
                        model_id(model) == Some(id)
                            && dsh_disabled_provider_name(model) == provider_name
                            && model.get("managed").and_then(Value::as_bool) != Some(false)
                    })
                {
                    return Err("Switch 管理模型只能禁用或启用，不能移除".into());
                }
                let previous_len = disabled.len();
                disabled.retain(|model| {
                    model_id(model) != Some(id)
                        || dsh_disabled_provider_name(model) != provider_name
                });
                if disabled.len() != previous_len {
                    write_json_array(&paths.dsh_disabled, &disabled)?;
                }
                models.retain(|model| dsh_model_id(model) != Some(id));
                dsh_save(paths, &root)?;
                return public_dsh(paths);
            }
        }
    }

    if disabled.iter().any(|model| {
        model_id(model) == Some(id) && dsh_disabled_provider_name(model) == provider_name
    }) {
        if provider_name == MANAGED_PROVIDER
            && disabled.iter().any(|model| {
                model_id(model) == Some(id)
                    && dsh_disabled_provider_name(model) == provider_name
                    && model.get("managed").and_then(Value::as_bool) != Some(false)
            })
        {
            return Err("Switch 管理模型只能禁用或启用，不能移除".into());
        }
        disabled.retain(|model| {
            model_id(model) != Some(id) || dsh_disabled_provider_name(model) != provider_name
        });
        write_json_array(&paths.dsh_disabled, &disabled)?;
        return public_dsh(paths);
    }

    Err("指定 provider 中不存在该 Harness 模型".into())
}

fn dsh_remove_all(paths: &ModelPaths) -> Result<(Vec<Value>, usize), String> {
    let _ = paths;
    Err("Switch 管理模型只能禁用或启用，不能批量移除".into())
}

fn dsh_disable_for_provider(
    paths: &ModelPaths,
    id: &str,
    provider_name: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut root = yaml_root(paths)?;
    let provider_name = provider_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| dsh_provider_name_for_model(&root, id))
        .ok_or("模型不存在于 Harness provider")?;
    let provider = dsh_provider_mut_by_name(&mut root, &provider_name)?
        .ok_or("Harness 中不存在目标 provider")?;
    let models = provider
        .get_mut(yaml_key("models"))
        .and_then(YamlValue::as_sequence_mut)
        .ok_or("Harness wb-switch models 不是数组")?;
    if !models.iter().any(|model| dsh_model_id(model) == Some(id)) {
        return Err("模型不存在于 Harness provider".into());
    }
    let mut disabled = read_json_array(&paths.dsh_disabled)?;
    let mut i = 0;
    while i < models.len() {
        if dsh_model_id(&models[i]) != Some(id) {
            i += 1;
            continue;
        }
        let mut model = serde_json::to_value(models.remove(i))
            .map_err(|error| format!("备份 Harness 模型失败：{error}"))?;
        if let Some(object) = model.as_object_mut() {
            object.insert("providerName".into(), json!(provider_name));
        }
        disabled.push(model);
    }
    write_json_array(&paths.dsh_disabled, &disabled)?;
    dsh_save(paths, &root)?;
    public_dsh(paths)
}

fn dsh_enable_for_provider(
    paths: &ModelPaths,
    id: &str,
    provider_name: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut disabled = read_json_array(&paths.dsh_disabled)?;
    let provider_name = provider_name.map(str::trim).filter(|name| !name.is_empty());
    let index = disabled
        .iter()
        .position(|model| {
            model_id(model) == Some(id)
                && dsh_disabled_provider_name(model) == provider_name.unwrap_or(MANAGED_PROVIDER)
        })
        .or_else(|| {
            provider_name
                .is_none()
                .then(|| {
                    disabled
                        .iter()
                        .position(|model| model_id(model) == Some(id))
                })
                .flatten()
        })
        .ok_or("该模型没有被禁用")?;
    let provider_name = dsh_disabled_provider_name(&disabled[index]).to_string();
    let mut root = yaml_root(paths)?;
    let provider = dsh_provider_mut_by_name(&mut root, &provider_name)?
        .ok_or("Harness 中不存在被禁用模型的 provider")?;
    if provider_name == MANAGED_PROVIDER && !usable_dsh_provider(provider) {
        return Err("Harness wb-switch provider 缺少有效 baseURL 或 apiKeyEnv".into());
    }
    let models = provider
        .get_mut(yaml_key("models"))
        .and_then(YamlValue::as_sequence_mut)
        .ok_or("Harness wb-switch models 不是数组")?;
    if models.iter().any(|model| dsh_model_id(model) == Some(id)) {
        return Err("Harness 目标 provider 中已有同名活动模型，不能覆盖".into());
    }
    let mut i = 0;
    while i < disabled.len() {
        if model_id(&disabled[i]) != Some(id)
            || dsh_disabled_provider_name(&disabled[i]) != provider_name
        {
            i += 1;
            continue;
        }
        let mut restored = disabled.remove(i);
        if let Some(object) = restored.as_object_mut() {
            object.remove("providerName");
        }
        models.push(
            serde_yaml::to_value(restored)
                .map_err(|error| format!("恢复 Harness 模型失败：{error}"))?,
        );
    }
    dsh_save(paths, &root)?;
    write_json_array(&paths.dsh_disabled, &disabled)?;
    public_dsh(paths)
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_workbuddy_models() -> Result<Value, String> {
    Ok(json!({"models": public_workbuddy(&paths())?}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_workbuddy_import(models: Vec<Value>, user_id: Option<i64>) -> Result<Value, String> {
    let user_id = user_id.ok_or("请先登录个人中心，再导入 WorkBuddy 模型")?;
    Ok(json!({"models": workbuddy_import(&paths(), models, user_id)?}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_workbuddy_update_connection(
    user_id: i64,
    base_url: String,
    api_key: String,
) -> Result<Value, String> {
    Ok(json!({"models": workbuddy_update_connection(&paths(), user_id, &base_url, &api_key)?}))
}

#[tauri::command]
pub fn local_workbuddy_clear_connection() -> Result<(), String> {
    workbuddy_clear_connection(&paths())
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_workbuddy_remove(id: String) -> Result<Value, String> {
    Ok(json!({"models": workbuddy_remove(&paths(), &id)?}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_workbuddy_remove_external(id: String) -> Result<Value, String> {
    Ok(json!({"models": workbuddy_remove_external(&paths(), &id)?}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_workbuddy_remove_all() -> Result<Value, String> {
    let (models, removed) = workbuddy_remove_all(&paths())?;
    Ok(json!({"models": models, "removed": removed}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_workbuddy_disable(id: String) -> Result<Value, String> {
    Ok(json!({"models": workbuddy_disable(&paths(), &id)?}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_workbuddy_enable(id: String) -> Result<Value, String> {
    Ok(json!({"models": workbuddy_enable(&paths(), &id)?}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_dsh_models() -> Result<Value, String> {
    Ok(json!({"models": public_dsh(&paths())?}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_dsh_import(models: Vec<Value>) -> Result<Value, String> {
    Ok(json!({"models": dsh_import(&paths(), models)?}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_dsh_remove(id: String) -> Result<Value, String> {
    Ok(json!({"models": dsh_remove(&paths(), &id)?}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_dsh_remove_external(id: String, provider_name: String) -> Result<Value, String> {
    Ok(json!({"models": dsh_remove_external(&paths(), &id, &provider_name)?}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_dsh_remove_all() -> Result<Value, String> {
    let (models, removed) = dsh_remove_all(&paths())?;
    Ok(json!({"models": models, "removed": removed}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_dsh_disable(id: String, provider_name: Option<String>) -> Result<Value, String> {
    Ok(json!({"models": dsh_disable_for_provider(&paths(), &id, provider_name.as_deref())?}))
}

#[tauri::command(rename_all = "camelCase")]
pub fn local_dsh_enable(id: String, provider_name: Option<String>) -> Result<Value, String> {
    Ok(json!({"models": dsh_enable_for_provider(&paths(), &id, provider_name.as_deref())?}))
}

/// Restart the running DeepSeek Harness process tree so its Agent reloads the
/// updated `cordis.patch.yml` model providers.
#[tauri::command]
pub fn restart_deepseek_harness() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let (pid, executable) = unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err("无法扫描 DeepSeek Harness 进程".into());
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut found = None;
            let mut has_entry = Process32FirstW(snapshot, &mut entry) != 0;
            while has_entry {
                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|value| *value == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
                if name.eq_ignore_ascii_case("DeepSeek Harness.exe") {
                    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                    if process != 0 {
                        let mut buffer = [0u16; 32768];
                        let mut length = buffer.len() as u32;
                        if QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut length) != 0 {
                            found = Some((entry.th32ProcessID, PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize]))));
                        }
                        CloseHandle(process);
                    }
                    if found.is_some() {
                        break;
                    }
                }
                has_entry = Process32NextW(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
            found.ok_or_else(|| "DeepSeek Harness 未运行".to_string())?
        };

        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|error| format!("关闭 DeepSeek Harness 失败：{error}"))?;
        if !status.success() {
            return Err("关闭 DeepSeek Harness 失败".into());
        }
        std::thread::sleep(Duration::from_millis(800));
        Command::new(&executable)
            .spawn()
            .map_err(|error| format!("重新启动 DeepSeek Harness 失败：{error}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("当前平台暂不支持自动重启 DeepSeek Harness，请手动重启".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempModels {
        home: PathBuf,
        paths: ModelPaths,
    }

    impl TempModels {
        fn new() -> Self {
            let home =
                std::env::temp_dir().join(format!("wb-local-models-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&home).unwrap();
            let paths = ModelPaths::from_home(&home);
            Self { home, paths }
        }
    }

    impl Drop for TempModels {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.home);
        }
    }

    fn template() -> Value {
        json!({"id":"seed","name":"Seed","url":"https://models.example/v1","apiKey":"sk-valid-key","wbSwitchManaged":true,"wbSwitchUserId":7,"supportsImages":true})
    }

    fn external_workbuddy_model() -> Value {
        json!({"id":"external","name":"External","url":"https://external.example/v1","apiKey":"sk-external-key","vendor":"Other"})
    }

    fn dsh_fixture() -> &'static str {
        "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      my:\n        models:\n          - id: other\n            name: Other\n      wb-switch:\n        displayName: WorkBuddy Switch\n        apiKeyEnv: WB_SWITCH_API_KEY\n        api: openai-completions\n        baseURL: https://models.example/v1\n        models:\n          - id: seed\n            name: Seed\n            managed: true\n"
    }

    fn dsh_duplicate_fixture() -> &'static str {
        "- id: llm-pi-ai\n  config:\n    providers:\n      first:\n        models:\n          - id: duplicate\n            name: First\n      second:\n        models:\n          - id: duplicate\n            name: Second\n      wb-switch:\n        apiKeyEnv: WB_SWITCH_API_KEY\n        baseURL: https://models.example/v1\n        models:\n          - id: duplicate\n            name: Managed\n            managed: true\n"
    }

    #[test]
    fn workbuddy_rejects_takeover_and_missing_template() {
        let temp = TempModels::new();
        let original = json!([{"id":"original","name":"Original","apiKey":"own-key"}]);
        write_json_array(&temp.paths.workbuddy, original.as_array().unwrap()).unwrap();
        assert!(
            workbuddy_import(&temp.paths, vec![json!({"id":"original"})], 7)
                .unwrap_err()
                .contains("不能接管")
        );
        assert!(workbuddy_import(&temp.paths, vec![json!({"id":"new"})], 7)
            .unwrap_err()
            .contains("连接模板"));
        assert_eq!(
            read_json_array(&temp.paths.workbuddy).unwrap(),
            original.as_array().unwrap().clone()
        );
    }

    #[test]
    fn workbuddy_import_uses_only_current_user_real_credentials() {
        let temp = TempModels::new();
        write_json_array(
            &temp.paths.workbuddy,
            &[json!({"id":"fake","url":"http://127.0.0.1:57900/v1","apiKey":"wb-switch-local","wbSwitchManaged":true,"wbSwitchUserId":7})],
        )
        .unwrap();
        assert!(workbuddy_import(&temp.paths, vec![json!({"id":"new"})], 7)
            .unwrap_err()
            .contains("连接模板"));
        write_json_array(&temp.paths.workbuddy, &[template()]).unwrap();
        assert!(workbuddy_import(&temp.paths, vec![json!({"id":"new"})], 8)
            .unwrap_err()
            .contains("连接模板"));
        write_json_array(
            &temp.paths.workbuddy,
            &[template(), json!({"id":"second","url":"https://other.example/v1","apiKey":"sk-other-key","wbSwitchManaged":true,"wbSwitchUserId":9})],
        )
        .unwrap();
        assert!(
            workbuddy_import(&temp.paths, vec![json!({"id":"ambiguous"})], 10)
                .unwrap_err()
                .contains("连接模板")
        );
        write_json_array(&temp.paths.workbuddy, &[template()]).unwrap();
        workbuddy_import(&temp.paths, vec![json!({"id":"new","name":"New"})], 7).unwrap();
        let models = read_json_array(&temp.paths.workbuddy).unwrap();
        let new = models
            .iter()
            .find(|model| model_id(model) == Some("new"))
            .unwrap();
        assert_eq!(new["apiKey"], "sk-valid-key");
        assert_eq!(new["url"], "https://models.example/v1");
        assert_eq!(new["supportsImages"], true);
        assert_eq!(new["wbSwitchUserId"], 7);
    }

    #[test]
    fn workbuddy_connection_switches_all_managed_models_without_touching_third_party() {
        let temp = TempModels::new();
        let mut legacy = template();
        legacy["id"] = json!("legacy");
        legacy["wbSwitchUserId"] = json!(8);
        let other = json!({"id":"other","url":"https://other.example/v1","apiKey":"sk-other-key","wbSwitchManaged":true,"wbSwitchUserId":9});
        write_json_array(
            &temp.paths.workbuddy,
            &[template(), legacy, other, external_workbuddy_model()],
        )
        .unwrap();
        let mut disabled = template();
        disabled["id"] = json!("disabled");
        disabled["wbSwitchUserId"] = json!(42);
        write_json_array(&temp.paths.workbuddy_disabled, &[disabled]).unwrap();
        workbuddy_update_connection(&temp.paths, 7, "https://new.example/v1", "sk-new-key")
            .unwrap();

        let models = read_json_array(&temp.paths.workbuddy).unwrap();
        for id in ["seed", "legacy", "other"] {
            let model = models
                .iter()
                .find(|model| model_id(model) == Some(id))
                .unwrap();
            assert_eq!(model["url"], "https://new.example/v1");
            assert_eq!(model["apiKey"], "sk-new-key");
            assert_eq!(model["wbSwitchUserId"], 7);
        }
        let disabled = read_json_array(&temp.paths.workbuddy_disabled).unwrap();
        assert_eq!(disabled[0]["apiKey"], "sk-new-key");
        assert_eq!(disabled[0]["wbSwitchUserId"], 7);
        assert_eq!(models[3]["apiKey"], "sk-external-key");
        assert!(public_workbuddy(&temp.paths)
            .unwrap()
            .iter()
            .all(|model| model.get("apiKey").is_none()));
    }

    #[test]
    fn workbuddy_clear_removes_only_managed_credentials_and_allows_resync() {
        let temp = TempModels::new();
        let external = external_workbuddy_model();
        write_json_array(&temp.paths.workbuddy, &[template(), external.clone()]).unwrap();
        write_json_array(&temp.paths.workbuddy_disabled, &[template()]).unwrap();
        write_json_array(&temp.paths.workbuddy_templates, &[template()]).unwrap();

        workbuddy_clear_connection(&temp.paths).unwrap();
        for path in [
            &temp.paths.workbuddy,
            &temp.paths.workbuddy_disabled,
            &temp.paths.workbuddy_templates,
        ] {
            let models = read_json_array(path).unwrap();
            assert_eq!(models[0]["url"], "https://models.example/v1");
            assert!(models[0].get("apiKey").is_none());
            assert!(models[0].get("wbSwitchUserId").is_none());
        }
        assert_eq!(read_json_array(&temp.paths.workbuddy).unwrap()[1], external);
        assert!(workbuddy_import(&temp.paths, vec![json!({"id": "new"})], 8).is_err());

        workbuddy_update_connection(&temp.paths, 8, "https://new.example/v1", "sk-new-key")
            .unwrap();
        let models = read_json_array(&temp.paths.workbuddy).unwrap();
        assert_eq!(models[0]["apiKey"], "sk-new-key");
        assert_eq!(models[0]["wbSwitchUserId"], 8);
        assert_eq!(models[1], external);
    }

    #[test]
    fn workbuddy_connection_creates_a_template_for_first_import() {
        let temp = TempModels::new();
        workbuddy_update_connection(&temp.paths, 7, "https://new.example/v1", "sk-new-key")
            .unwrap();
        let templates = read_json_array(&temp.paths.workbuddy_templates).unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0]["wbSwitchUserId"], 7);
        workbuddy_import(&temp.paths, vec![json!({"id":"new-model"})], 7).unwrap();
        let models = read_json_array(&temp.paths.workbuddy).unwrap();
        assert_eq!(models[0]["apiKey"], "sk-new-key");
        assert_eq!(models[0]["url"], "https://new.example/v1");
    }

    #[test]
    fn workbuddy_managed_disabled_model_can_be_restored_but_not_removed() {
        let temp = TempModels::new();
        write_json_array(&temp.paths.workbuddy, &[template()]).unwrap();
        workbuddy_disable(&temp.paths, "seed").unwrap();
        assert!(read_json_array(&temp.paths.workbuddy).unwrap().is_empty());
        assert_eq!(
            read_json_array(&temp.paths.workbuddy_disabled)
                .unwrap()
                .len(),
            1
        );
        assert!(public_workbuddy(&temp.paths).unwrap()[0]["disabled"]
            .as_bool()
            .unwrap());
        workbuddy_enable(&temp.paths, "seed").unwrap();
        assert_eq!(read_json_array(&temp.paths.workbuddy).unwrap().len(), 1);
        workbuddy_disable(&temp.paths, "seed").unwrap();
        assert!(workbuddy_remove(&temp.paths, "seed")
            .unwrap_err()
            .contains("只能禁用或启用"));
        assert!(workbuddy_remove_external(&temp.paths, "seed")
            .unwrap_err()
            .contains("只能禁用或启用"));
    }

    #[test]
    fn workbuddy_external_can_disable_enable_remove_but_managed_cannot_remove() {
        let temp = TempModels::new();
        write_json_array(
            &temp.paths.workbuddy,
            &[template(), external_workbuddy_model()],
        )
        .unwrap();

        assert!(workbuddy_remove(&temp.paths, "seed")
            .unwrap_err()
            .contains("只能禁用或启用"));
        assert!(workbuddy_remove_external(&temp.paths, "seed")
            .unwrap_err()
            .contains("只能禁用或启用"));

        workbuddy_disable(&temp.paths, "external").unwrap();
        let disabled = public_workbuddy(&temp.paths)
            .unwrap()
            .into_iter()
            .find(|model| model_id(model) == Some("external"))
            .unwrap();
        assert_eq!(disabled["managed"], false);
        assert_eq!(disabled["disabled"], true);

        workbuddy_enable(&temp.paths, "external").unwrap();
        workbuddy_disable(&temp.paths, "external").unwrap();
        workbuddy_remove_external(&temp.paths, "external").unwrap();
        assert!(public_workbuddy(&temp.paths)
            .unwrap()
            .iter()
            .all(|model| model_id(model) != Some("external")));
    }

    #[test]
    fn workbuddy_remove_all_rejects_managed_and_preserves_original() {
        let temp = TempModels::new();
        write_json_array(
            &temp.paths.workbuddy,
            &[template(), json!({"id":"original"})],
        )
        .unwrap();
        workbuddy_disable(&temp.paths, "seed").unwrap();
        assert!(workbuddy_remove_all(&temp.paths)
            .unwrap_err()
            .contains("不能批量移除"));
        assert_eq!(
            read_json_array(&temp.paths.workbuddy).unwrap(),
            vec![json!({"id":"original"})]
        );
        assert_eq!(
            read_json_array(&temp.paths.workbuddy_disabled)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn workbuddy_template_survives_last_managed_disable_and_reimport() {
        let temp = TempModels::new();
        write_json_array(&temp.paths.workbuddy, &[template()]).unwrap();

        workbuddy_disable(&temp.paths, "seed").unwrap();
        assert!(read_json_array(&temp.paths.workbuddy).unwrap().is_empty());

        let templates = read_json_array(&temp.paths.workbuddy_templates).unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(managed_user_id(&templates[0]), Some(7));
        assert_eq!(templates[0]["url"], "https://models.example/v1");
        assert_eq!(templates[0]["apiKey"], "sk-valid-key");

        write_json_array(&temp.paths.workbuddy_disabled, &[]).unwrap();
        workbuddy_import(&temp.paths, vec![json!({"id":"restored"})], 7).unwrap();
        let active = read_json_array(&temp.paths.workbuddy).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0]["id"], "restored");
        assert_eq!(active[0]["url"], "https://models.example/v1");
        assert_eq!(active[0]["apiKey"], "sk-valid-key");
        assert_eq!(active[0]["wbSwitchUserId"], 7);
    }

    #[test]
    fn harness_requires_existing_complete_provider() {
        let temp = TempModels::new();
        let yaml = "- id: llm-pi-ai\n  config:\n    providers:\n      my:\n        models: []\n";
        write_text(&temp.paths.dsh, yaml).unwrap();
        assert!(dsh_import(&temp.paths, vec![json!({"id":"new"})])
            .unwrap_err()
            .contains("不存在 wb-switch provider"));
        assert_eq!(std::fs::read_to_string(&temp.paths.dsh).unwrap(), yaml);
    }

    #[test]
    fn harness_disable_restore_remove_and_preserve_other_provider() {
        let temp = TempModels::new();
        write_text(&temp.paths.dsh, dsh_fixture()).unwrap();
        dsh_disable_for_provider(&temp.paths, "seed", None).unwrap();
        let disabled = read_json_array(&temp.paths.dsh_disabled).unwrap();
        assert_eq!(disabled.len(), 1);
        assert!(public_dsh(&temp.paths)
            .unwrap()
            .iter()
            .any(|model| model["id"] == "seed" && model["disabled"] == true));
        dsh_enable_for_provider(&temp.paths, "seed", None).unwrap();
        assert!(read_json_array(&temp.paths.dsh_disabled)
            .unwrap()
            .is_empty());
        assert!(public_dsh(&temp.paths)
            .unwrap()
            .iter()
            .any(|model| model["id"] == "seed" && model["disabled"] == false));
        dsh_disable_for_provider(&temp.paths, "seed", None).unwrap();
        assert!(dsh_remove(&temp.paths, "seed")
            .unwrap_err()
            .contains("只能禁用或启用"));
        assert!(dsh_remove_external(&temp.paths, "seed", MANAGED_PROVIDER)
            .unwrap_err()
            .contains("只能禁用或启用"));
        assert!(dsh_remove_all(&temp.paths)
            .unwrap_err()
            .contains("不能批量移除"));
        assert!(public_dsh(&temp.paths)
            .unwrap()
            .iter()
            .any(|model| model["id"] == "seed" && model["disabled"] == true));
        assert!(public_dsh(&temp.paths)
            .unwrap()
            .iter()
            .any(|model| model["id"] == "other"));
    }

    #[test]
    fn harness_external_can_disable_enable_remove_and_managed_cannot_remove() {
        let temp = TempModels::new();
        write_text(&temp.paths.dsh, dsh_fixture()).unwrap();

        assert!(dsh_remove(&temp.paths, "seed")
            .unwrap_err()
            .contains("只能禁用或启用"));
        assert!(dsh_remove_external(&temp.paths, "seed", MANAGED_PROVIDER)
            .unwrap_err()
            .contains("只能禁用或启用"));

        dsh_disable_for_provider(&temp.paths, "other", None).unwrap();
        let disabled = public_dsh(&temp.paths)
            .unwrap()
            .into_iter()
            .find(|model| model["id"] == "other")
            .unwrap();
        assert_eq!(disabled["providerName"], "my");
        assert_eq!(disabled["managed"], false);
        assert_eq!(disabled["disabled"], true);

        dsh_enable_for_provider(&temp.paths, "other", None).unwrap();
        dsh_disable_for_provider(&temp.paths, "other", None).unwrap();
        dsh_remove_external(&temp.paths, "other", "my").unwrap();
        assert!(!public_dsh(&temp.paths)
            .unwrap()
            .iter()
            .any(|model| model["id"] == "other"));
    }

    #[test]
    fn harness_external_remove_uses_provider_name_for_duplicate_ids() {
        let temp = TempModels::new();
        write_text(&temp.paths.dsh, dsh_duplicate_fixture()).unwrap();

        dsh_remove_external(&temp.paths, "duplicate", "first").unwrap();
        let models = public_dsh(&temp.paths).unwrap();
        assert!(!models
            .iter()
            .any(|model| model["id"] == "duplicate" && model["providerName"] == "first"));
        assert!(models
            .iter()
            .any(|model| model["id"] == "duplicate" && model["providerName"] == "second"));
        assert!(models
            .iter()
            .any(|model| model["id"] == "duplicate" && model["providerName"] == MANAGED_PROVIDER));
    }

    #[test]
    fn harness_remove_clears_stale_disabled_copy_only_for_target_provider() {
        let temp = TempModels::new();
        write_text(&temp.paths.dsh, dsh_duplicate_fixture()).unwrap();
        write_json_array(
            &temp.paths.dsh_disabled,
            &[
                json!({"id": "duplicate", "providerName": "first", "managed": false}),
                json!({"id": "duplicate", "providerName": "second", "managed": false}),
            ],
        )
        .unwrap();

        let models = dsh_remove_external(&temp.paths, "duplicate", "first").unwrap();
        assert!(!models
            .iter()
            .any(|model| model["id"] == "duplicate" && model["providerName"] == "first"));
        assert!(models
            .iter()
            .any(|model| model["id"] == "duplicate" && model["providerName"] == "second"));
        let disabled = read_json_array(&temp.paths.dsh_disabled).unwrap();
        assert_eq!(disabled.len(), 1);
        assert_eq!(disabled[0]["providerName"], "second");
    }

    #[test]
    fn harness_external_remove_does_not_delete_managed_backup() {
        let temp = TempModels::new();
        let yaml = dsh_fixture().replace("managed: true", "managed: false");
        write_text(&temp.paths.dsh, &yaml).unwrap();
        write_json_array(
            &temp.paths.dsh_disabled,
            &[json!({"id": "seed", "providerName": MANAGED_PROVIDER, "managed": true})],
        )
        .unwrap();

        assert!(dsh_remove_external(&temp.paths, "seed", MANAGED_PROVIDER).is_err());
        assert_eq!(read_json_array(&temp.paths.dsh_disabled).unwrap().len(), 1);
        assert!(public_dsh(&temp.paths)
            .unwrap()
            .iter()
            .any(|model| model["id"] == "seed"));
    }

    #[test]
    fn harness_external_remove_clears_duplicate_active_and_disabled_records() {
        let temp = TempModels::new();
        let yaml = dsh_fixture().replace("- id: other\n            name: Other", "- id: other\n            name: Other\n          - id: other\n            name: Other duplicate");
        write_text(&temp.paths.dsh, &yaml).unwrap();
        write_json_array(
            &temp.paths.dsh_disabled,
            &[
                json!({"id":"other", "providerName":"my", "managed":false}),
                json!({"id":"other", "providerName":"my", "managed":false}),
                json!({"id":"other", "providerName":"elsewhere", "managed":false}),
            ],
        )
        .unwrap();
        dsh_remove_external(&temp.paths, "other", "my").unwrap();
        assert!(!public_dsh(&temp.paths)
            .unwrap()
            .iter()
            .any(|m| m["id"] == "other" && m["providerName"] == "my"));
        assert_eq!(read_json_array(&temp.paths.dsh_disabled).unwrap().len(), 1);
    }

    #[test]
    fn harness_external_remove_checks_all_disabled_duplicates_for_managed_items() {
        let temp = TempModels::new();
        write_text(&temp.paths.dsh, dsh_fixture()).unwrap();
        write_json_array(
            &temp.paths.dsh_disabled,
            &[
                json!({"id":"absent", "providerName":MANAGED_PROVIDER, "managed":false}),
                json!({"id":"absent", "providerName":MANAGED_PROVIDER, "managed":true}),
            ],
        )
        .unwrap();
        assert!(dsh_remove_external(&temp.paths, "absent", MANAGED_PROVIDER).is_err());
        assert_eq!(read_json_array(&temp.paths.dsh_disabled).unwrap().len(), 2);
        dsh_remove_external(&temp.paths, "absent", "my").unwrap_err();
        write_json_array(
            &temp.paths.dsh_disabled,
            &[
                json!({"id":"absent", "providerName":"my", "managed":false}),
                json!({"id":"absent", "providerName":"my", "managed":false}),
                json!({"id":"absent", "providerName":"other", "managed":false}),
            ],
        )
        .unwrap();
        dsh_remove_external(&temp.paths, "absent", "my").unwrap();
        assert_eq!(read_json_array(&temp.paths.dsh_disabled).unwrap().len(), 1);
    }

    #[test]
    fn harness_external_remove_checks_all_active_duplicates_for_managed_items() {
        let temp = TempModels::new();
        let yaml = dsh_fixture().replace("- id: seed\n            name: Seed\n            managed: true", "- id: seed\n            name: External\n            managed: false\n          - id: seed\n            name: Managed\n            managed: true");
        write_text(&temp.paths.dsh, &yaml).unwrap();
        assert!(dsh_remove_external(&temp.paths, "seed", MANAGED_PROVIDER).is_err());
        assert_eq!(
            public_dsh(&temp.paths)
                .unwrap()
                .iter()
                .filter(|m| m["id"] == "seed")
                .count(),
            2
        );
    }

    #[test]
    fn harness_external_toggle_uses_provider_name_for_duplicate_ids() {
        let temp = TempModels::new();
        write_text(&temp.paths.dsh, dsh_duplicate_fixture()).unwrap();

        dsh_disable_for_provider(&temp.paths, "duplicate", Some("first")).unwrap();
        let models = public_dsh(&temp.paths).unwrap();
        assert!(models.iter().any(|model| {
            model["id"] == "duplicate"
                && model["providerName"] == "first"
                && model["disabled"] == true
        }));
        for provider in ["second", MANAGED_PROVIDER] {
            assert!(models.iter().any(|model| {
                model["id"] == "duplicate"
                    && model["providerName"] == provider
                    && model["disabled"] == false
            }));
        }

        dsh_enable_for_provider(&temp.paths, "duplicate", Some("first")).unwrap();
        let models = public_dsh(&temp.paths).unwrap();
        assert!(models.iter().any(|model| {
            model["id"] == "duplicate"
                && model["providerName"] == "first"
                && model["disabled"] == false
        }));
        assert!(read_json_array(&temp.paths.dsh_disabled)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn harness_toggle_preserves_all_duplicate_models_and_other_providers() {
        let temp = TempModels::new();
        let yaml = dsh_fixture().replace("- id: seed\n            name: Seed\n            managed: true", "- id: seed\n            name: Seed\n            managed: true\n            context: 123\n          - id: seed\n            name: Second\n            managed: true\n            context: 456");
        write_text(&temp.paths.dsh, &yaml).unwrap();
        let models = dsh_disable_for_provider(&temp.paths, "seed", Some(MANAGED_PROVIDER)).unwrap();
        assert_eq!(
            models
                .iter()
                .filter(|m| m["id"] == "seed"
                    && m["providerName"] == MANAGED_PROVIDER
                    && m["disabled"] == true)
                .count(),
            1
        );
        assert_eq!(read_json_array(&temp.paths.dsh_disabled).unwrap().len(), 2);
        assert!(models
            .iter()
            .any(|m| m["id"] == "other" && m["providerName"] == "my"));
        dsh_enable_for_provider(&temp.paths, "seed", Some(MANAGED_PROVIDER)).unwrap();
        let root = yaml_root(&temp.paths).unwrap();
        let provider = dsh_providers(&root)
            .unwrap()
            .get(yaml_key(MANAGED_PROVIDER))
            .unwrap();
        let models = provider.get("models").unwrap().as_sequence().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(
            models[0].get("context").and_then(YamlValue::as_i64),
            Some(123)
        );
        assert_eq!(
            models[1].get("context").and_then(YamlValue::as_i64),
            Some(456)
        );
        assert!(read_json_array(&temp.paths.dsh_disabled)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn harness_remove_all_rejects_managed_and_preserves_other_provider() {
        let temp = TempModels::new();
        write_text(&temp.paths.dsh, dsh_fixture()).unwrap();
        dsh_import(&temp.paths, vec![json!({"id":"second"})]).unwrap();
        dsh_disable_for_provider(&temp.paths, "second", None).unwrap();
        assert!(dsh_remove_all(&temp.paths)
            .unwrap_err()
            .contains("不能批量移除"));
        let models = public_dsh(&temp.paths).unwrap();
        assert!(models.iter().any(|model| model["id"] == "other"));
        assert!(models.iter().any(|model| model["id"] == "seed"));
        assert!(models
            .iter()
            .any(|model| model["id"] == "second" && model["disabled"] == true));
    }
}

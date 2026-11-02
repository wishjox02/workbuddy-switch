//! wb-admin：WorkBuddy 安装统计与版本管理后台。
//!
//! 默认监听 `0.0.0.0:57900`，数据库默认放在当前目录的 `wb-admin.sqlite3`。
//! 部署时请设置 `WB_ADMIN_TOKEN`，管理接口使用 `Authorization: Bearer ...`。

mod api;
mod secrets;
mod sms;
mod sub2api;
mod store;
mod workbuddy_models;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use api::AdminState;
use sub2api::Sub2ApiService;
use store::AdminStore;

#[tokio::main]
async fn main() {
    let bind = std::env::var("WB_ADMIN_BIND").unwrap_or_else(|_| "0.0.0.0:57900".to_string());
    let db_path = std::env::var_os("WB_ADMIN_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("wb-admin.sqlite3"));
    let token = std::env::var("WB_ADMIN_TOKEN")
        .unwrap_or_else(|_| "dev-admin-token-change-me".to_string());
    let store = match AdminStore::open(&db_path) {
        Ok(store) => Arc::new(store),
        Err(error) => {
            eprintln!("初始化后台数据库失败：{error}");
            std::process::exit(1);
        }
    };
    let sub2api = match Sub2ApiService::from_env(store.clone()) {
        Ok(service) => Arc::new(service),
        Err(error) => {
            eprintln!("初始化 Sub2API 密钥服务失败：{error}");
            std::process::exit(1);
        }
    };

    let state = AdminState { store, admin_token: token, sub2api };
    let app = api::router(state);
    let addr: SocketAddr = match bind.parse() {
        Ok(addr) => addr,
        Err(error) => {
            eprintln!("后台监听地址无效：{error}");
            std::process::exit(1);
        }
    };

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("后台启动失败：{error}");
            std::process::exit(1);
        }
    };
    println!("wb-admin listening on http://{addr}");
    println!("admin panel: http://{addr}/admin/overview");
    axum::serve(listener, app).await.expect("后台服务异常退出");
}

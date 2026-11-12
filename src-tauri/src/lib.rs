//! NanoSSH 后端：基于 russh 的 SSH 会话池。
//!
//! 每个页签对应一个 Rust 侧会话，前端通过 Tauri command 发送输入/尺寸变化/关闭，
//! Rust 侧通过事件把远端字节流推给 xterm.js。字节流统一用 base64 传输，
//! 避免 UTF-8 多字节字符在数据包边界被截断。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

mod menu;

use anyhow::{anyhow, bail, Context, Result};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::{rngs::OsRng, RngCore};
use std::fs;
use std::path::PathBuf;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use russh::keys::*;
use russh::*;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::sync::Mutex;
use russh_sftp::client::SftpSession;

/* ==================== 数据结构 ==================== */

/// 前端传给后端的连接参数（JS 用 camelCase）
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectConfig {
    host: String,
    port: u16,
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    private_key: String,
    #[serde(default = "default_cols")]
    cols: u32,
    #[serde(default = "default_rows")]
    rows: u32,
}

fn default_cols() -> u32 { 80 }
fn default_rows() -> u32 { 24 }

/// 前端 -> 会话任务的指令
enum SessionCommand {
    Input(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

pub struct SshState {
    sessions: Mutex<HashMap<String, UnboundedSender<SessionCommand>>>,
    /// SSH 会话已认证的 Handle，供 SFTP 上传复用；本地终端不注册
    handles: Mutex<HashMap<String, Arc<Mutex<client::Handle<ClientHandler>>>>>,
    next_id: AtomicU64,
}

impl Default for SshState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            handles: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

/// 后台传输任务的控制位：分块循环高频读取，用原子量避免持锁
#[derive(Default)]
struct JobControl {
    paused: AtomicBool,
    canceled: AtomicBool,
}

impl JobControl {
    fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::Relaxed)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum JobSignal {
    Run,
    Canceled,
}

/// 分块循环入口：暂停时轮询等待恢复，取消时立即返回；None 用于单元测试直通
async fn wait_for_slot(control: Option<&JobControl>) -> JobSignal {
    let Some(c) = control else { return JobSignal::Run; };
    loop {
        if c.canceled.load(Ordering::Relaxed) {
            return JobSignal::Canceled;
        }
        if !c.paused.load(Ordering::Relaxed) {
            return JobSignal::Run;
        }
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
}

#[derive(Default)]
pub struct TransferState {
    jobs: Arc<std::sync::Mutex<HashMap<String, Arc<JobControl>>>>,
}

impl TransferState {
    fn start(&self, job: &str) -> Arc<JobControl> {
        let c = Arc::new(JobControl::default());
        self.jobs.lock().unwrap().insert(job.to_string(), c.clone());
        c
    }

    fn set_paused(&self, job: &str, value: bool) {
        if let Some(c) = self.jobs.lock().unwrap().get(job) {
            c.paused.store(value, Ordering::Relaxed);
        }
    }

    /// 取消并从表中摘除；后台 task 仍持有 Arc，能读到 canceled 并自行收尾
    fn cancel(&self, job: &str) {
        if let Some(c) = self.jobs.lock().unwrap().remove(job) {
            c.canceled.store(true, Ordering::Relaxed);
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct DataEvent {
    id: String,
    /// base64 编码的远端输出字节
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct ClosedEvent {
    id: String,
    reason: String,
}

/* ==================== SSH Handler ==================== */

struct ClientHandler;

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    /// 目前接受所有主机密钥（TOFU 未实现）。
    /// 生产使用应改为比对 ~/.ssh/known_hosts 并拒绝变更的指纹，见 README 安全说明。
    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/* ==================== Tauri Commands ==================== */

#[tauri::command]
async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshState>,
    config: ConnectConfig,
) -> std::result::Result<String, String> {
    connect_ssh(app, state, config)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// 测试连接：只做 TCP + 密钥交换 + 认证，成功后立即断开，不申请 PTY、不注册会话。
/// 10 秒超时避免主机不可达时界面一直转圈。
#[tauri::command]
async fn ssh_test(config: ConnectConfig) -> std::result::Result<String, String> {
    let started = Instant::now();
    match tokio::time::timeout(Duration::from_secs(10), test_connect(&config)).await {
        Err(_) => Err("测试超时（10 秒），请检查主机地址与端口".to_string()),
        Ok(Err(e)) => Err(format!("{e:#}")),
        Ok(Ok(())) => Ok(format!(
            "{}@{}:{} 可连通，认证通过（{} ms）",
            config.username,
            config.host,
            config.port,
            started.elapsed().as_millis()
        )),
    }
}

#[tauri::command]
async fn ssh_write(
    state: State<'_, SshState>,
    id: String,
    data: String,
) -> std::result::Result<(), String> {
    let bytes = B64.decode(data.as_bytes()).map_err(|e| format!("输入编码错误：{e}"))?;
    let sessions = state.sessions.lock().await;
    let tx = sessions.get(&id).ok_or_else(|| "会话不存在".to_string())?;
    tx.send(SessionCommand::Input(bytes))
        .map_err(|_| "会话已关闭".to_string())
}

#[tauri::command]
async fn ssh_resize(
    state: State<'_, SshState>,
    id: String,
    cols: u32,
    rows: u32,
) -> std::result::Result<(), String> {
    let sessions = state.sessions.lock().await;
    let tx = sessions.get(&id).ok_or_else(|| "会话不存在".to_string())?;
    tx.send(SessionCommand::Resize { cols, rows })
        .map_err(|_| "会话已关闭".to_string())
}

#[tauri::command]
async fn ssh_close(
    state: State<'_, SshState>,
    id: String,
) -> std::result::Result<(), String> {
    let tx = state.sessions.lock().await.remove(&id);
    if let Some(tx) = tx {
        let _ = tx.send(SessionCommand::Close);
    }
    Ok(())
}

/* ==================== 连接配置的本机加密存储 ==================== */
///
/// AES-256-GCM：32 字节随机密钥保存在应用数据目录的 secret.key（Unix 下 0600），
/// 密文为 base64(nonce || ciphertext)，分别写入 profiles.enc（连接配置）与 transfers.enc（传输记录）。
/// 前端拿到的始终是明文 JSON，但明文永不落盘；旧版 localStorage 的明文数据会被一次性迁移。

fn store_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir().context("无法定位应用数据目录")?;
    fs::create_dir_all(&dir).context("创建应用数据目录失败")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

fn encryption_key(dir: &PathBuf) -> Result<[u8; 32]> {
    let key_path = dir.join("secret.key");
    if key_path.exists() {
        let bytes = fs::read(&key_path).context("读取本机密钥失败")?;
        return bytes
            .try_into()
            .map_err(|_| anyhow!("本机密钥文件损坏（长度应为 32 字节）"));
    }
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    fs::write(&key_path, key).context("写入本机密钥失败")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600))
            .context("设置密钥文件权限失败")?;
    }
    Ok(key)
}

fn cipher_for(key: &[u8; 32]) -> Aes256Gcm {
    Aes256Gcm::new_from_slice(key).expect("密钥长度固定为 32 字节")
}

/// 纯加密函数：返回 base64(nonce || ciphertext)，与文件路径解耦，便于单元测试。
fn encrypt_json(key: &[u8; 32], json: &str) -> Result<String> {
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let mut nonce = Nonce::default();
    nonce.copy_from_slice(&nonce_bytes);
    let ciphertext = cipher_for(key)
        .encrypt(&nonce, json.as_bytes())
        .map_err(|_| anyhow!("连接配置加密失败"))?;
    let mut blob = nonce_bytes.to_vec();
    blob.extend_from_slice(&ciphertext);
    Ok(B64.encode(blob.as_slice()))
}

fn decrypt_json(key: &[u8; 32], encoded: &str) -> Result<String> {
    let blob = B64.decode(encoded.trim().as_bytes()).context("连接配置编码损坏")?;
    if blob.len() < 12 {
        bail!("连接配置已损坏");
    }
    let (nonce_bytes, ciphertext) = blob.split_at(12);
    let mut nonce = Nonce::default();
    nonce.copy_from_slice(nonce_bytes);
    let plain = cipher_for(key)
        .decrypt(&nonce, ciphertext)
        .map_err(|_| anyhow!("连接配置解密失败：本机密钥可能已更换或文件被修改"))?;
    String::from_utf8(plain).context("连接配置不是合法的 UTF-8")
}

/// 通用加密读取：与文件名解耦，连接配置与传输记录共用同一套密钥和格式。
/// 文件不存在时返回空数组；前端拿到的一直是明文 JSON，明文永不落盘。
fn read_encrypted_file(dir: &PathBuf, file: &str) -> Result<String> {
    let data_path = dir.join(file);
    if !data_path.exists() {
        return Ok("[]".to_string());
    }
    let encoded = fs::read_to_string(&data_path).context("读取加密数据失败")?;
    decrypt_json(&encryption_key(dir)?, &encoded)
}

/// 通用加密写入：base64(nonce || ciphertext)，Unix 下文件权限 0600。
fn write_encrypted_file(dir: &PathBuf, file: &str, json: &str) -> Result<()> {
    let encoded = encrypt_json(&encryption_key(dir)?, json)?;
    let data_path = dir.join(file);
    fs::write(&data_path, encoded).context("写入加密数据失败")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&data_path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// command 层统一解析应用数据目录，再交给纯函数读写（纯函数便于单元测试）。
fn load_store(app: &AppHandle, file: &str) -> std::result::Result<String, String> {
    let dir = store_dir(app).map_err(|e| format!("{e:#}"))?;
    read_encrypted_file(&dir, file).map_err(|e| format!("{e:#}"))
}

fn save_store(app: &AppHandle, file: &str, json: &str) -> std::result::Result<(), String> {
    let dir = store_dir(app).map_err(|e| format!("{e:#}"))?;
    write_encrypted_file(&dir, file, json).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn profiles_load(app: AppHandle) -> std::result::Result<String, String> {
    load_store(&app, "profiles.enc")
}

#[tauri::command]
async fn profiles_save(app: AppHandle, json: String) -> std::result::Result<(), String> {
    save_store(&app, "profiles.enc", &json)
}

#[tauri::command]
async fn transfers_load(app: AppHandle) -> std::result::Result<String, String> {
    load_store(&app, "transfers.enc")
}

#[tauri::command]
async fn transfers_save(app: AppHandle, json: String) -> std::result::Result<(), String> {
    save_store(&app, "transfers.enc", &json)
}

/* ==================== 连接与认证 ==================== */

/// 建立 TCP 连接并完成密钥交换，不做认证、不占会话表。
async fn open_session(cfg: &ConnectConfig, keepalive: bool) -> Result<client::Handle<ClientHandler>> {
    let client_config = client::Config {
        inactivity_timeout: None, // 终端可能长时间空闲，不能被 GC 掉
        nodelay: true,            // 交互式输入低延迟
        keepalive_interval: if keepalive { Some(Duration::from_secs(30)) } else { None },
        ..Default::default()
    };
    client::connect(
        Arc::new(client_config),
        (cfg.host.clone(), cfg.port),
        ClientHandler,
    )
    .await
    .with_context(|| format!("无法连接 {}:{}", cfg.host, cfg.port))
}

/// 密码 / 私钥二选一认证，供正常连接与测试连接共用。
async fn authenticate(
    session: &mut client::Handle<ClientHandler>,
    cfg: &ConnectConfig,
) -> Result<()> {
    let authenticated = if !cfg.password.is_empty() {
        session
            .authenticate_password(cfg.username.clone(), cfg.password.clone())
            .await?
            .success()
    } else if !cfg.private_key.is_empty() {
        let path = expand_home(&cfg.private_key);
        let key = load_secret_key(&path, None)
            .with_context(|| format!("读取私钥失败：{path}"))?;
        let hash = session.best_supported_rsa_hash().await?.flatten();
        session
            .authenticate_publickey(
                cfg.username.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await?
            .success()
    } else {
        bail!("未提供密码或私钥");
    };
    if !authenticated {
        bail!("SSH 认证失败，请检查用户名与凭据");
    }
    Ok(())
}

async fn test_connect(cfg: &ConnectConfig) -> Result<()> {
    let mut session = open_session(cfg, false).await?;
    let outcome = authenticate(&mut session, cfg).await;
    // 无论认证成功或失败都主动断开，避免测试留下悬挂连接
    let _ = session
        .disconnect(Disconnect::ByApplication, "", "English")
        .await;
    outcome
}

/* ==================== 会话实现 ==================== */

async fn connect_ssh(
    app: AppHandle,
    state: State<'_, SshState>,
    cfg: ConnectConfig,
) -> Result<String> {
    let id = format!(
        "s{}",
        state.next_id.fetch_add(1, Ordering::Relaxed)
    );

    // === 第 1 步：建立 TCP 连接并完成密钥交换 ===
    let mut session = open_session(&cfg, true).await?;

    // === 第 2 步：认证（密码 / 私钥二选一） ===
    authenticate(&mut session, &cfg).await?;

    // 认证后的 Handle 放进共享表，SFTP 上传可以直接复用，不必重新连接/认证
    let session = Arc::new(Mutex::new(session));
    state.handles.lock().await.insert(id.clone(), session.clone());

    // === 第 3 步：申请 PTY 并启动交互式 shell ===
    let channel = {
        let guard = session.lock().await;
        guard.channel_open_session().await?
    };
    channel
        .request_pty(
            false,
            "xterm-256color",
            cfg.cols.max(1),
            cfg.rows.max(1),
            0,
            0,
            &[],
        )
        .await?;
    channel.request_shell(true).await?;

    // === 第 4 步：读写分离，起一个任务同时处理远端输出与前端指令 ===
    let (mut reader, writer) = channel.split();
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();
    state.sessions.lock().await.insert(id.clone(), cmd_tx);

    let task_app = app.clone();
    let task_id = id.clone();
    let task_session = session.clone();
    tokio::spawn(async move {
        let mut reason = "远端关闭了连接".to_string();

        loop {
            tokio::select! {
                msg = reader.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            emit_data(&task_app, &task_id, &data);
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            // stderr 也写进同一个终端，符合交互式终端习惯
                            emit_data(&task_app, &task_id, &data);
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            reason = format!("远端进程退出，状态码 {exit_status}");
                        }
                        Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) | None => break,
                        _ => {}
                    }
                }
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(SessionCommand::Input(bytes)) => {
                            let _ = writer.data_bytes(bytes).await;
                        }
                        Some(SessionCommand::Resize { cols, rows }) => {
                            let _ = writer.window_change(cols.max(1), rows.max(1), 0, 0).await;
                        }
                        Some(SessionCommand::Close) | None => {
                            reason = "已主动关闭".to_string();
                            break;
                        }
                    }
                }
            }
        }

        // === 第 5 步：收尾，通知前端并从会话表移除 ===
        let _ = writer.close().await;
        let _ = task_session
            .lock()
            .await
            .disconnect(Disconnect::ByApplication, "", "English")
            .await;
        let _ = task_app.emit("ssh-closed", ClosedEvent { id: task_id.clone(), reason });
        let ssh_state = task_app.state::<SshState>();
        ssh_state.sessions.lock().await.remove(&task_id);
        ssh_state.handles.lock().await.remove(&task_id);
    });

    Ok(id)
}

fn emit_data(app: &AppHandle, id: &str, data: &[u8]) {
    let _ = app.emit(
        "ssh-data",
        DataEvent {
            id: id.to_string(),
            data: B64.encode(data),
        },
    );
}

/// 展开路径开头的 `~/`，跨平台取用户目录
fn expand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| "~".to_string());
        format!("{home}/{rest}")
    } else {
        path.to_string()
    }
}

/* ==================== SFTP：目录浏览 / 上传 / 下载（复用已认证会话） ==================== */
///
/// 每次操作都在同一条 SSH 连接上新开 channel 请求 sftp 子系统，
/// 不重新 TCP 连接、不重新认证；终端输入输出与文件传输互不阻塞。
/// 目录列举与文件选择返回本机绝对路径，Rust 侧按 64 KiB 分块流式传输，
/// 进度通过 sftp-progress 事件推给前端。

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpProgress {
    /// 后台任务 id，前端据此匹配悬停面板里的任务项
    job: String,
    file: String,
    index: usize,
    count: usize,
    sent: u64,
    total: u64,
    percent: u8,
    phase: String,
    message: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadOutcome {
    path: String,
    remote: String,
    size: u64,
    ok: bool,
    error: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadOutcome {
    remote_path: String,
    local_path: String,
    size: u64,
    ok: bool,
    error: String,
}

/// 后台任务的逐文件结果，上传下载统一成一种形状给前端
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferOutcome {
    path: String,
    target: String,
    size: u64,
    ok: bool,
    error: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferDone {
    job: String,
    ok: usize,
    failed: usize,
    canceled: bool,
    error: String,
    outcomes: Vec<TransferOutcome>,
}

fn emit_transfer_done(
    app: &AppHandle,
    job: &str,
    canceled: bool,
    error: String,
    outcomes: Vec<TransferOutcome>,
) {
    let ok = outcomes.iter().filter(|o| o.ok).count();
    let failed = outcomes.len() - ok;
    let _ = app.emit(
        "sftp-transfer-done",
        TransferDone { job: job.to_string(), ok, failed, canceled, error, outcomes },
    );
}

/// 目录条目：本地栏与远端栏共用，前端两栏复用同一套渲染逻辑
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    mtime: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirListing {
    /// 规范化后的绝对路径
    path: String,
    /// 默认目录（本机 HOME / SFTP realpath(".")）
    home: String,
    entries: Vec<FsEntry>,
}

fn sort_entries(entries: &mut Vec<FsEntry>) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

/// 拼接远端路径，避免根目录出现 `//` 或目录末尾重复 `/`
fn remote_join(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

/// 同时认 Unix `/` 与 Windows `\`：dialog / 远端返回的都是原生路径
fn local_file_name(path: &str) -> Result<String> {
    let name = path
        .rsplit(|c: char| c == '/' || c == '\\')
        .next()
        .unwrap_or(path)
        .trim();
    if name.is_empty() {
        bail!("无法取文件名：{path}");
    }
    Ok(name.to_string())
}

/// `~` / `~/xxx` 展开为 SFTP 默认目录；绝对路径原样交给 realpath 校验
fn resolve_remote_dir(home: &str, input: &str) -> String {
    let t = input.trim();
    if t.is_empty() || t == "~" {
        return home.to_string();
    }
    if let Some(rest) = t.strip_prefix("~/") {
        return remote_join(home, rest);
    }
    t.to_string()
}

/// 本机目录：空 / `~` / `~/xxx` 展开；其余原样交给 canonicalize 校验
fn resolve_local_dir(input: &str) -> String {
    let t = input.trim();
    let home = home_dir().unwrap_or_default();
    if t.is_empty() || t == "~" {
        return home;
    }
    if let Some(rest) = t.strip_prefix("~/") {
        return format!("{home}/{rest}");
    }
    t.to_string()
}

fn unix_secs(modified: std::io::Result<std::time::SystemTime>) -> u64 {
    modified
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 列举本机目录（同步 std::fs，条目数量可控，无需异步线程池）
fn list_local_dir(input: &str) -> Result<DirListing> {
    let home = home_dir().context("无法获取本机用户目录")?;
    let wanted = resolve_local_dir(input);
    let base = fs::canonicalize(&wanted)
        .with_context(|| format!("本地目录不存在或不可访问：{wanted}"))?;
    if !base.is_dir() {
        bail!("不是目录：{wanted}");
    }
    let mut entries = Vec::new();
    for item in fs::read_dir(&base).with_context(|| format!("读取本地目录失败：{wanted}"))? {
        let item = item.context("遍历本地目录失败")?;
        let name = item.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." {
            continue;
        }
        // metadata() 跟随符号链接，与系统文件管理器的双击行为一致
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        entries.push(FsEntry {
            path: item.path().to_string_lossy().to_string(),
            name,
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            mtime: unix_secs(meta.modified()),
        });
    }
    sort_entries(&mut entries);
    Ok(DirListing {
        path: base.to_string_lossy().to_string(),
        home,
        entries,
    })
}

fn emit_sftp(
    app: Option<&AppHandle>,
    job: &str,
    file: &str,
    index: usize,
    count: usize,
    sent: u64,
    total: u64,
    phase: &str,
    message: &str,
) {
    let Some(app) = app else { return; };  // 单元测试不产生进度事件
    let percent = if total == 0 { 100 } else { (sent * 100 / total).min(100) as u8 };
    let _ = app.emit(
        "sftp-progress",
        SftpProgress {
            job: job.to_string(),
            file: file.to_string(),
            index,
            count,
            sent,
            total,
            percent,
            phase: phase.to_string(),
            message: message.to_string(),
        },
    );
}

/// 复用已认证 Handle 开一条 SFTP 子系统通道，并返回远端默认目录 realpath(".")
async fn open_sftp_session(
    state: &State<'_, SshState>,
    id: &str,
) -> Result<(SftpSession, String)> {
    // 只有 SSH 会话才注册了 Handle；本地终端（l 开头）不会出现在表里
    let handle = state
        .handles
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| anyhow!("会话不存在或已断开；本地终端不支持 SFTP"))?;
    let channel = {
        let guard = handle.lock().await;
        guard.channel_open_session().await.context("打开 SSH 通道失败")?
    };
    channel
        .request_subsystem(true, "sftp")
        .await
        .context("远端未启用 SFTP 子系统")?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .context("SFTP 协议握手失败")?;
    sftp.set_timeout(30);
    let home = sftp.canonicalize(".").await.context("无法获取远端默认目录")?;
    Ok((sftp, home))
}

/* ---------- Tauri commands ---------- */

#[tauri::command]
async fn local_list(path: String) -> std::result::Result<DirListing, String> {
    list_local_dir(&path).map_err(|e| format!("{e:#}"))
}

/// 判断一组本机路径是否为目录（拖拽上传时过滤目录：目录暂不支持递归上传）。
/// 返回值与入参同序；路径取不到元数据时按文件处理，交给上传流程报具体错误。
#[tauri::command]
fn path_kinds(paths: Vec<String>) -> Vec<bool> {
    paths
        .iter()
        .map(|p| std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false))
        .collect()
}

/// 探测该页签交互 shell 的当前目录（供 SFTP 打开时定位）。
/// 做法：在同一条 SSH 连接上开一条 exec 通道（不经过终端、不注入任何字符），
/// 从自身进程向上找到本次连接的 sshd/sshd-session 祖先，其进程标题里带本连接
/// pty 的编号（如 "sshd: user@pts/2"）；再在 /proc 里找该 tty 的会话首进程
/// （交互 shell，pid==sid），readlink 它的 cwd。
/// 探测不到（非 Linux 远端、ps 不支持 -o、找不到进程）时返回空串，前端回落家目录。
#[tauri::command]
async fn ssh_cwd(state: State<'_, SshState>, id: String) -> std::result::Result<String, String> {
    let handle = state
        .handles
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| "会话不存在或已断开".to_string())?;
    let channel = {
        let guard = handle.lock().await;
        guard
            .channel_open_session()
            .await
            .map_err(|e| e.to_string())?
    };
    let script = r#"A=$$
while [ "$A" -gt 1 ] 2>/dev/null; do
  C=$(ps -o comm= -p "$A" 2>/dev/null) || break
  case "$C" in *sshd*) break ;; esac
  A=$(ps -o ppid= -p "$A" 2>/dev/null | tr -d " ")
  [ -z "$A" ] && break
done
T=$(ps -o args= -p "$A" 2>/dev/null | sed -nE "s/.*@(pts\/[0-9]+|tty[0-9]+).*/\1/p" | tail -1)
if [ -n "$T" ]; then
  P=$(ps -t "$T" -o pid=,sid= 2>/dev/null | awk "$1==$2 {print $1; exit}")
  [ -n "$P" ] && readlink "/proc/$P/cwd" 2>/dev/null
fi"#;
    channel
        .exec(true, script)
        .await
        .map_err(|e| e.to_string())?;
    let mut channel = channel;
    let mut out: Vec<u8> = Vec::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

#[tauri::command]
async fn sftp_list(
    state: State<'_, SshState>,
    id: String,
    path: String,
) -> std::result::Result<DirListing, String> {
    list_remote_dir(&state, &id, &path)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// 启动一次后台上传：校验通道后立刻返回 job，分块传输在独立 task 里跑
#[tauri::command]
async fn sftp_upload(
    app: AppHandle,
    state: State<'_, SshState>,
    transfers: State<'_, TransferState>,
    id: String,
    job: String,
    paths: Vec<String>,
    dir: String,
    overwrite: bool,
) -> std::result::Result<String, String> {
    if paths.is_empty() {
        return Err("请先选择要上传的文件".into());
    }
    let (sftp, home) = open_sftp_session(&state, &id).await.map_err(|e| format!("{e:#}"))?;
    let control = transfers.start(&job);
    let jobs = transfers.jobs.clone();
    let task_job = job.clone();
    tauri::async_runtime::spawn(async move {
        let wanted = resolve_remote_dir(&home, &dir);
        let (outcomes, error) = match sftp.canonicalize(wanted.as_str()).await {
            Ok(base) => (
                send_files_via_sftp(
                    &sftp, Some(&app), &task_job, &paths, &base, overwrite,
                    Some(control.as_ref()),
                )
                .await
                .into_iter()
                .map(|o| TransferOutcome {
                    path: o.path, target: o.remote, size: o.size, ok: o.ok, error: o.error,
                })
                .collect(),
                String::new(),
            ),
            Err(e) => (Vec::new(), format!("远端目录不可访问：{e:#}")),
        };
        let _ = sftp.close().await;
        emit_transfer_done(&app, &task_job, control.is_canceled(), error, outcomes);
        jobs.lock().unwrap().remove(&task_job);
    });
    Ok(job)
}

/// 启动一次后台下载，与上传共用控制位、进度与完成事件
#[tauri::command]
async fn sftp_download(
    app: AppHandle,
    state: State<'_, SshState>,
    transfers: State<'_, TransferState>,
    id: String,
    job: String,
    paths: Vec<String>,
    dir: String,
    overwrite: bool,
) -> std::result::Result<String, String> {
    if paths.is_empty() {
        return Err("请先选择要下载的远端文件".into());
    }
    let wanted = resolve_local_dir(&dir);
    let base = fs::canonicalize(&wanted)
        .with_context(|| format!("本地目录不存在或不可访问：{wanted}"))
        .map_err(|e| format!("{e:#}"))?
        .to_string_lossy()
        .to_string();
    let (sftp, _home) = open_sftp_session(&state, &id).await.map_err(|e| format!("{e:#}"))?;
    let control = transfers.start(&job);
    let jobs = transfers.jobs.clone();
    let task_job = job.clone();
    tauri::async_runtime::spawn(async move {
        let outcomes = receive_files_via_sftp(
            &sftp, Some(&app), &task_job, &paths, &base, overwrite, Some(control.as_ref()),
        )
        .await
        .into_iter()
        .map(|o| TransferOutcome {
            path: o.remote_path, target: o.local_path, size: o.size, ok: o.ok, error: o.error,
        })
        .collect();
        let _ = sftp.close().await;
        emit_transfer_done(&app, &task_job, control.is_canceled(), String::new(), outcomes);
        jobs.lock().unwrap().remove(&task_job);
    });
    Ok(job)
}

#[tauri::command]
fn sftp_transfer_pause(transfers: State<'_, TransferState>, job: String) {
    transfers.set_paused(&job, true);
}

#[tauri::command]
fn sftp_transfer_resume(transfers: State<'_, TransferState>, job: String) {
    transfers.set_paused(&job, false);
}

#[tauri::command]
fn sftp_transfer_cancel(transfers: State<'_, TransferState>, job: String) {
    transfers.cancel(&job);
}

/* ---------- 远端目录列举 ---------- */

async fn list_remote_dir(
    state: &State<'_, SshState>,
    id: &str,
    input: &str,
) -> Result<DirListing> {
    let (sftp, home) = open_sftp_session(state, id).await?;
    let result = read_remote_dir_via(&sftp, &home, input).await;
    let _ = sftp.close().await;
    result
}

/// 目录列举主体：只依赖 SftpSession，便于对着真实 sftp-server 做端到端验证
async fn read_remote_dir_via(
    sftp: &SftpSession,
    home: &str,
    input: &str,
) -> Result<DirListing> {
    let wanted = resolve_remote_dir(home, input);
    let base = sftp
        .canonicalize(wanted.as_str())
        .await
        .with_context(|| format!("远端目录不存在或不可访问：{wanted}"))?;
    let mut entries = Vec::new();
    for item in sftp.read_dir(&base).await.context("读取远端目录失败")? {
        let name = item.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let path = item.path();
        let meta = item.metadata();
        let mut is_dir = meta.file_type().is_dir();
        // 符号链接指向目录时也可双击进入（仅链接时多一次 stat）
        if !is_dir && meta.file_type().is_symlink() {
            is_dir = sftp
                .metadata(path.as_str())
                .await
                .map(|m| m.file_type().is_dir())
                .unwrap_or(false);
        }
        entries.push(FsEntry {
            name,
            path,
            is_dir,
            size: if is_dir { 0 } else { meta.size.unwrap_or(0) },
            mtime: meta.mtime.unwrap_or(0) as u64,
        });
    }
    sort_entries(&mut entries);
    Ok(DirListing {
        path: base,
        home: home.to_string(),
        entries,
    })
}

/* ---------- 上传 ---------- */

/// 传输主体：只依赖 SftpSession，进度事件可选（None 用于端到端单元测试）。
/// 与建立连接、解析目录解耦，便于对着真实 sftp-server 验证分块写入与覆盖策略。
async fn send_files_via_sftp(
    sftp: &SftpSession,
    app: Option<&AppHandle>,
    job: &str,
    paths: &[String],
    base: &str,
    overwrite: bool,
    control: Option<&JobControl>,
) -> Vec<UploadOutcome> {
    let count = paths.len();
    let mut outcomes = Vec::with_capacity(count);
    for (index, local) in paths.iter().enumerate() {
        if wait_for_slot(control).await == JobSignal::Canceled {
            break;
        }
        let name = local_file_name(local).unwrap_or_else(|_| local.clone());
        let remote = remote_join(&base, &name);
        emit_sftp(app, job, &name, index, count, 0, 0, "start", "");

        let result: Result<u64> = async {
            if !overwrite
                && sftp
                    .try_exists(remote.as_str())
                    .await
                    .context("检查远端同名文件失败")?
            {
                bail!("远端已存在同名文件（未勾选覆盖）");
            }
            let mut local_file = tokio::fs::File::open(local)
                .await
                .with_context(|| format!("无法读取本地文件：{local}"))?;
            let total = local_file.metadata().await?.len();
            let mut remote_file = sftp
                .create(remote.as_str())
                .await
                .with_context(|| format!("无法创建远端文件：{remote}"))?;

            let mut buf = vec![0u8; 64 * 1024];
            let mut sent = 0u64;
            let mut last_percent = -1i32;
            loop {
                if wait_for_slot(control).await == JobSignal::Canceled {
                    bail!("传输已取消");
                }
                let n = local_file.read(&mut buf).await.context("读取本地文件失败")?;
                if n == 0 {
                    break;
                }
                remote_file
                    .write_all(&buf[..n])
                    .await
                    .context("写入远端文件失败")?;
                sent += n as u64;
                let percent = if total == 0 { 100 } else { (sent * 100 / total).min(100) as i32 };
                // 每 2% 或最后一个分块推一次，避免进度事件刷屏
                if percent - last_percent >= 2 || sent == total {
                    emit_sftp(app, job, &name, index, count, sent, total, "progress", "");
                    last_percent = percent;
                }
            }
            remote_file.flush().await.context("刷新远端文件失败")?;
            remote_file.close().await.context("关闭远端文件失败")?;
            Ok(sent)
        }
        .await;

        match result {
            Ok(size) => {
                emit_sftp(app, job, &name, index, count, size, size, "done", "");
                outcomes.push(UploadOutcome {
                    path: local.clone(),
                    remote,
                    size,
                    ok: true,
                    error: String::new(),
                });
            }
            Err(e) => {
                let canceled = control.is_some_and(|c| c.is_canceled());
                let message = if canceled { "传输已取消".to_string() } else { format!("{e:#}") };
                if canceled {
                    // 取消时尽力清掉没写完的远端文件，避免留下半个文件
                    let _ = sftp.remove_file(remote.as_str()).await;
                }
                emit_sftp(app, job, &name, index, count, 0, 0, "error", &message);
                outcomes.push(UploadOutcome {
                    path: local.clone(),
                    remote,
                    size: 0,
                    ok: false,
                    error: message,
                });
            }
        }
    }

    outcomes
}

/* ---------- 下载 ---------- */

/// 下载主体：与上传对称，同样 64 KiB 分块、单文件失败不影响其余文件
async fn receive_files_via_sftp(
    sftp: &SftpSession,
    app: Option<&AppHandle>,
    job: &str,
    paths: &[String],
    base: &str,
    overwrite: bool,
    control: Option<&JobControl>,
) -> Vec<DownloadOutcome> {
    let count = paths.len();
    let mut outcomes = Vec::with_capacity(count);
    for (index, remote) in paths.iter().enumerate() {
        if wait_for_slot(control).await == JobSignal::Canceled {
            break;
        }
        let name = local_file_name(remote).unwrap_or_else(|_| remote.clone());
        let local = format!(
            "{}{}{}",
            base.trim_end_matches(|c| c == '/' || c == '\\'),
            std::path::MAIN_SEPARATOR,
            name
        );
        emit_sftp(app, job, &name, index, count, 0, 0, "start", "下载");

        let result: Result<u64> = async {
            if !overwrite && fs::metadata(&local).is_ok() {
                bail!("本地已存在同名文件（未勾选覆盖）");
            }
            let meta = sftp
                .metadata(remote.as_str())
                .await
                .with_context(|| format!("无法读取远端文件信息：{remote}"))?;
            let total = meta.size.unwrap_or(0);
            let mut remote_file = sftp
                .open(remote.as_str())
                .await
                .with_context(|| format!("无法打开远端文件：{remote}"))?;
            let mut local_file = tokio::fs::File::create(&local)
                .await
                .with_context(|| format!("无法创建本地文件：{local}"))?;

            let mut buf = vec![0u8; 64 * 1024];
            let mut sent = 0u64;
            let mut last_percent = -1i32;
            loop {
                if wait_for_slot(control).await == JobSignal::Canceled {
                    bail!("传输已取消");
                }
                let n = remote_file.read(&mut buf).await.context("读取远端文件失败")?;
                if n == 0 {
                    break;
                }
                local_file
                    .write_all(&buf[..n])
                    .await
                    .context("写入本地文件失败")?;
                sent += n as u64;
                let percent = if total == 0 {
                    100
                } else {
                    (sent * 100 / total.max(1)).min(100) as i32
                };
                if percent - last_percent >= 2 || n < buf.len() {
                    emit_sftp(app, job, &name, index, count, sent, total, "progress", "下载");
                    last_percent = percent;
                }
            }
            local_file.flush().await.context("刷新本地文件失败")?;
            Ok(sent)
        }
        .await;

        match result {
            Ok(size) => {
                emit_sftp(app, job, &name, index, count, size, size, "done", "下载");
                outcomes.push(DownloadOutcome {
                    remote_path: remote.clone(),
                    local_path: local.clone(),
                    size,
                    ok: true,
                    error: String::new(),
                });
            }
            Err(e) => {
                let canceled = control.is_some_and(|c| c.is_canceled());
                let message = if canceled { "传输已取消".to_string() } else { format!("{e:#}") };
                if canceled {
                    let _ = fs::remove_file(&local);
                }
                emit_sftp(app, job, &name, index, count, 0, 0, "error", &message);
                outcomes.push(DownloadOutcome {
                    remote_path: remote.clone(),
                    local_path: local.clone(),
                    size: 0,
                    ok: false,
                    error: message,
                });
            }
        }
    }

    outcomes
}

/* ==================== 本地终端（portable-pty） ==================== */
///
/// 与 SSH 会话共用同一张会话表与同一组 command / 事件：
/// local_open 把 PTY 指令发送端注册进 SshState.sessions，之后
/// ssh_write / ssh_resize / ssh_close 与 ssh-data / ssh-closed 全部原样复用，
/// 前端只需按 tab.kind 决定「建 SSH 连接」还是「起本地 PTY」。

use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use std::io::{Read, Write};

/// 一次 spawn 出来的 PTY 句柄集合，抽成纯函数便于单元测试真起一个 shell。
struct LocalPtyParts {
    master: Box<dyn portable_pty::MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

fn pty_size(cols: u32, rows: u32) -> PtySize {
    PtySize {
        cols: cols.clamp(1, u16::MAX as u32) as u16,
        rows: rows.clamp(1, u16::MAX as u32) as u16,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn spawn_local_shell(cols: u32, rows: u32) -> Result<LocalPtyParts> {
    let pty_system = native_pty_system();
    let PtyPair { master, slave } = pty_system
        .openpty(pty_size(cols, rows))
        .context("创建本地 PTY 失败")?;

    // new_default_prog 用 $SHELL（Unix）/ COMSPEC（Windows），并以登录 shell 启动
    let mut cmd = CommandBuilder::new_default_prog();
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = home_dir() {
        cmd.cwd(home);
    }
    let child = slave.spawn_command(cmd).context("启动本地 shell 失败")?;
    drop(slave); // 释放 slave，shell 退出时 master 才能读到 EOF

    let reader = master.try_clone_reader().context("获取 PTY 读句柄失败")?;
    let writer = master.take_writer().context("获取 PTY 写句柄失败")?;
    Ok(LocalPtyParts {
        master,
        reader,
        writer,
        child,
    })
}

/// 打开一个本地 shell 页签，返回可复用 ssh_write / ssh_resize / ssh_close 的会话 id。
#[tauri::command]
async fn local_open(
    app: AppHandle,
    state: State<'_, SshState>,
    cols: u32,
    rows: u32,
) -> std::result::Result<String, String> {
    let id = format!("l{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    let parts = spawn_local_shell(cols, rows).map_err(|e| format!("{e:#}"))?;
    let LocalPtyParts {
        master,
        reader,
        writer,
        child,
    } = parts;

    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();
    state.sessions.lock().await.insert(id.clone(), cmd_tx.clone());

    // 读线程：PTY 输出 → base64 → ssh-data；shell 退出（EOF）后通知控制线程收尾
    let read_app = app.clone();
    let read_id = id.clone();
    let done_tx = cmd_tx.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => emit_data(&read_app, &read_id, &buf[..n]),
            }
        }
        let _ = done_tx.send(SessionCommand::Close);
    });

    // 控制线程：消费前端输入 / 尺寸变化；退出时杀掉 shell、注销会话并通知前端
    let ctl_app = app.clone();
    let ctl_id = id.clone();
    std::thread::spawn(move || {
        let mut writer = writer;
        let mut child = child;
        loop {
            match cmd_rx.blocking_recv() {
                Some(SessionCommand::Input(bytes)) => {
                    if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                        break;
                    }
                }
                Some(SessionCommand::Resize { cols, rows }) => {
                    let _ = master.resize(pty_size(cols, rows));
                }
                Some(SessionCommand::Close) | None => break,
            }
        }
        let _ = child.kill();
        // 有界轮询回收子进程，避免 kill 未生效时把控制线程永久挂住
        for _ in 0..20 {
            if let Ok(Some(_)) = child.try_wait() { break; }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = ctl_app.emit(
            "ssh-closed",
            ClosedEvent {
                id: ctl_id.clone(),
                reason: "本地 shell 已退出".to_string(),
            },
        );
        tauri::async_runtime::block_on(async {
            ctl_app
                .state::<SshState>()
                .sessions
                .lock()
                .await
                .remove(&ctl_id);
        });
    });

    Ok(id)
}

/* ==================== 入口 ==================== */

/// 前端切换语言 / 光标样式后重建顶部菜单（Rust 侧持有中英两套标签与打勾状态）
#[tauri::command]
fn set_app_menu(app: AppHandle, locale: String, cursor_style: Option<String>) -> Result<(), String> {
    let cursor = cursor_style.unwrap_or_else(|| "bar".into());
    let menu = menu::build(&app, locale == "zh", &cursor).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SshState::default())
        .manage(TransferState::default())
        // 启动先挂中文菜单（前端就绪后按已存语言再同步一次），彻底替换 Tauri 默认菜单
        .setup(|app| {
            app.set_menu(menu::build(app.handle(), true, "bar")?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("app-menu", event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            set_app_menu,
            ssh_connect,
            ssh_test,
            ssh_write,
            ssh_resize,
            ssh_close,
            local_open,
            sftp_upload,
            sftp_download,
            sftp_transfer_pause,
            sftp_transfer_resume,
            sftp_transfer_cancel,
            sftp_list,
            local_list,
            path_kinds,
            ssh_cwd,
            profiles_load,
            profiles_save,
            transfers_load,
            transfers_save
        ])
        .run(tauri::generate_context!())
        .expect("启动 NanoSSH 失败");
}

/* ==================== 加密存储单元测试 ==================== */

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; 32] { [7u8; 32] }

    /// 连接配置与传输记录共用同一密钥、不同密文文件：互不干扰，明文不落盘。
    #[test]
    fn encrypted_files_are_independent_and_hide_plaintext() {
        let dir = std::env::temp_dir().join(format!(
            "nanossh-store-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();

        let profiles = r#"[{"host":"10.0.0.1","password":"s3cr3t"}]"#;
        let history = r#"[{"job":"j1","label":"app.jar","state":"done"}]"#;
        assert_eq!(read_encrypted_file(&dir, "profiles.enc").unwrap(), "[]");
        assert_eq!(read_encrypted_file(&dir, "transfers.enc").unwrap(), "[]");

        write_encrypted_file(&dir, "profiles.enc", profiles).unwrap();
        write_encrypted_file(&dir, "transfers.enc", history).unwrap();
        assert_eq!(read_encrypted_file(&dir, "profiles.enc").unwrap(), profiles);
        assert_eq!(read_encrypted_file(&dir, "transfers.enc").unwrap(), history);

        let raw = fs::read_to_string(dir.join("transfers.enc")).unwrap();
        assert!(!raw.contains("app.jar"), "密文里不能出现明文文件名");
        assert!(!raw.contains("s3cr3t"), "两份密文不能串台");

        // 覆盖写只影响目标文件，另一份完好
        let next = r#"[{"job":"j2","state":"canceled"}]"#;
        write_encrypted_file(&dir, "transfers.enc", next).unwrap();
        assert_eq!(read_encrypted_file(&dir, "transfers.enc").unwrap(), next);
        assert_eq!(read_encrypted_file(&dir, "profiles.enc").unwrap(), profiles);

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 真实起一个本地 shell 并验证「写命令 → 读输出」链路。
    /// 用 `NANOS''SH_PTY_OK` 拼接，命令回显里含引号不会误命中，
    /// 只有 shell 真正执行后输出的 `NANOSSH_PTY_OK` 才算通过。
    #[cfg(unix)]
    #[test]
    fn local_pty_echo_roundtrip() {
        let parts = spawn_local_shell(80, 24).expect("应能启动本地 shell");
        let LocalPtyParts {
            master,
            reader,
            mut writer,
            mut child,
        } = parts;

        // PTY 读是阻塞的：放到独立线程 + recv_timeout，shell 不响应时也能按时退出
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        writer
            .write_all(b"echo NANOS''SH_PTY_OK\r")
            .and_then(|_| writer.flush())
            .expect("应能写入 PTY");

        let mut acc = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                acc.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&acc).contains("NANOSSH_PTY_OK") {
                    break;
                }
            }
        }
        let _ = child.kill();
        let _ = child.try_wait();
        drop(master); // master 必须保活到测试结束，否则 PTY 会被提前关闭
        assert!(
            String::from_utf8_lossy(&acc).contains("NANOSSH_PTY_OK"),
            "本地 PTY 应收到 shell 的真实输出，实际：{:?}",
            String::from_utf8_lossy(&acc)
        );
    }


    #[test]
    fn profiles_roundtrip_and_no_plaintext_in_ciphertext() {
        let json = r#"[{"id":"p1","host":"172.16.51.24","username":"root","password":"s3cr3t-P@ss"}]"#;
        let blob = encrypt_json(&key(), json).unwrap();
        assert_eq!(decrypt_json(&key(), &blob).unwrap(), json);
        let raw = B64.decode(blob.as_bytes()).unwrap();
        assert!(
            !raw.windows(b"s3cr3t".len()).any(|w| w == b"s3cr3t"),
            "密文字节中不应出现明文密码"
        );
        assert!(!blob.contains("s3cr3t"), "base64 密文中不应出现明文密码");
    }

    #[test]
    fn wrong_key_or_tampered_ciphertext_is_rejected() {
        let blob = encrypt_json(&key(), r#"[{"password":"abc"}]"#).unwrap();
        let mut other = key();
        other[0] ^= 1;
        assert!(decrypt_json(&other, &blob).is_err(), "换密钥必须无法解密");

        let mut raw = B64.decode(blob.as_bytes()).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        assert!(
            decrypt_json(&key(), &B64.encode(raw.as_slice())).is_err(),
            "篡改密文必须被 GCM 校验拒绝"
        );
    }

    #[test]
    fn truncated_blob_is_rejected() {
        assert!(decrypt_json(&key(), &B64.encode(b"short".as_slice())).is_err());
    }

    #[test]
    fn sftp_path_helpers() {
        assert_eq!(remote_join("/home/llp", "a.txt"), "/home/llp/a.txt");
        assert_eq!(remote_join("/home/llp/", "a.txt"), "/home/llp/a.txt");
        assert_eq!(remote_join("/", "a.txt"), "/a.txt");
        assert_eq!(resolve_remote_dir("/home/llp", ""), "/home/llp");
        assert_eq!(resolve_remote_dir("/home/llp", "~"), "/home/llp");
        assert_eq!(resolve_remote_dir("/home/llp", " ~/upload "), "/home/llp/upload");
        assert_eq!(resolve_remote_dir("/home/llp", "/tmp"), "/tmp");
        assert_eq!(local_file_name("/Users/llp/a.txt").unwrap(), "a.txt");
        assert_eq!(local_file_name(r"C:\Users\llp\a.txt").unwrap(), "a.txt");
    }

    /// 端到端：把 TCP 桥接到本机 /usr/libexec/sftp-server，走真实 SFTP 协议上传并回读。
    /// 只有设置 NANOSSH_SFTP_E2E=host:port 与 NANOSSH_SFTP_ROOT 时才执行，普通 cargo test 自动跳过。
    #[tokio::test]
    async fn sftp_upload_roundtrip_against_local_server() {
        let Ok(addr) = std::env::var("NANOSSH_SFTP_E2E") else { return; };
        let root = std::env::var("NANOSSH_SFTP_ROOT").expect("需要 NANOSSH_SFTP_ROOT");
        let dir = std::env::temp_dir().join(format!("nanossh-sftp-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let local = dir.join("payload.bin");
        let payload: Vec<u8> = (0..200_000).map(|i| (i % 251) as u8).collect();
        std::fs::write(&local, &payload).unwrap();

        let stream = tokio::net::TcpStream::connect(&addr).await.expect("连接本地 SFTP 桥失败");
        let sftp = SftpSession::new(stream).await.expect("SFTP 握手失败");
        sftp.set_timeout(15);

        let paths = vec![local.to_string_lossy().to_string()];
        let outcomes = send_files_via_sftp(&sftp, None, "e2e", &paths, &root, true, None).await;
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].ok, "上传应成功：{}", outcomes[0].error);
        assert_eq!(outcomes[0].size, payload.len() as u64);

        // 从 sftp-server 真实写入的文件系统回读，逐字节比对
        let remote = std::path::Path::new(&root).join("payload.bin");
        let written = std::fs::read(&remote).expect("远端应生成 payload.bin");
        assert_eq!(written, payload, "远端文件字节应与本地完全一致");

        // 不覆盖时应拒绝，且已有文件不被截断
        let again = send_files_via_sftp(&sftp, None, "e2e", &paths, &root, false, None).await;
        assert!(!again[0].ok, "未勾选覆盖时应失败");
        assert!(again[0].error.contains("同名"), "错误应说明同名文件：{}", again[0].error);
        assert_eq!(std::fs::read(&remote).unwrap(), payload, "拒绝覆盖后原文件不应改变");

        let _ = sftp.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn directory_listing_helpers() {
        let mut entries = vec![
            FsEntry { name: "b.txt".into(), path: "/b.txt".into(), is_dir: false, size: 1, mtime: 0 },
            FsEntry { name: "A".into(), path: "/A".into(), is_dir: true, size: 0, mtime: 0 },
            FsEntry { name: "a.txt".into(), path: "/a.txt".into(), is_dir: false, size: 2, mtime: 0 },
        ];
        sort_entries(&mut entries);
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["A", "a.txt", "b.txt"]
        );

        let home = home_dir().expect("本机应有 HOME");
        assert_eq!(resolve_local_dir(""), home);
        assert_eq!(resolve_local_dir("~"), home);
        assert_eq!(resolve_local_dir(" ~/dl "), format!("{home}/dl"));
        assert_eq!(resolve_local_dir("/tmp"), "/tmp");
    }

    #[test]
    fn local_listing_lists_real_directory() {
        let dir = std::env::temp_dir().join(format!("nanossh-local-list-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.bin"), b"hello").unwrap();
        let listing = list_local_dir(&dir.to_string_lossy()).unwrap();
        assert_eq!(
            listing.path,
            fs::canonicalize(&dir).unwrap().to_string_lossy()
        );
        assert_eq!(listing.home, home_dir().unwrap());
        let bin = listing.entries.iter().find(|e| e.name == "a.bin").unwrap();
        assert!(!bin.is_dir && bin.size == 5);
        let sub = listing.entries.iter().find(|e| e.name == "sub").unwrap();
        assert!(sub.is_dir && sub.size == 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端到端：对着本机 sftp-server 验证「目录列举 + 下载」，与上传形成闭环。
    /// 同样由 NANOSSH_SFTP_E2E / NANOSSH_SFTP_ROOT 门控，普通 cargo test 自动跳过。
    #[tokio::test]
    async fn sftp_browser_roundtrip_against_local_server() {
        let Ok(addr) = std::env::var("NANOSSH_SFTP_E2E") else { return; };
        let root = std::env::var("NANOSSH_SFTP_ROOT").expect("需要 NANOSSH_SFTP_ROOT");
        let work = std::env::temp_dir().join(format!("nanossh-browser-e2e-{}", std::process::id()));
        std::fs::create_dir_all(work.join("downloaded")).unwrap();
        let src = work.join("browser.bin");
        let payload: Vec<u8> = (0..137_000).map(|i| (i % 239) as u8).collect();
        std::fs::write(&src, &payload).unwrap();

        let stream = tokio::net::TcpStream::connect(&addr).await.expect("连接本地 SFTP 桥失败");
        let sftp = SftpSession::new(stream).await.expect("SFTP 握手失败");
        sftp.set_timeout(15);

        let uploaded = send_files_via_sftp(
            &sftp, None, "e2e", &[src.to_string_lossy().to_string()], &root, true, None,
        ).await;
        assert!(uploaded[0].ok, "上传应成功：{}", uploaded[0].error);

        let listing = read_remote_dir_via(&sftp, &root, "").await.expect("列举远端目录失败");
        assert!(listing.path.ends_with("nanossh-sftp-root"), "路径应规范化：{}", listing.path);
        let entry = listing.entries.iter()
            .find(|e| e.name == "browser.bin")
            .expect("应列出刚上传的文件");
        assert!(!entry.is_dir && entry.size == payload.len() as u64);
        assert!(entry.path.ends_with("/browser.bin"));

        let remote = format!("{}/browser.bin", root.trim_end_matches('/'));
        let dest = work.join("downloaded");
        let outcomes = receive_files_via_sftp(
            &sftp, None, "e2e", &[remote.clone()], &dest.to_string_lossy(), true, None,
        ).await;
        assert!(outcomes[0].ok, "下载应成功：{}", outcomes[0].error);
        assert_eq!(
            std::fs::read(dest.join("browser.bin")).unwrap(),
            payload,
            "下载文件字节应与远端完全一致"
        );

        let again = receive_files_via_sftp(
            &sftp, None, "e2e", &[remote], &dest.to_string_lossy(), false, None,
        ).await;
        assert!(!again[0].ok && again[0].error.contains("同名"), "不覆盖时应拒绝");
        assert_eq!(std::fs::read(dest.join("browser.bin")).unwrap(), payload, "拒绝后原文件不变");

        let _ = sftp.close().await;
        let _ = std::fs::remove_file(std::path::Path::new(&root).join("browser.bin"));
        let _ = std::fs::remove_dir_all(&work);
    }

    #[tokio::test]
    async fn transfer_control_pause_resume_cancel() {
        let state = TransferState::default();
        let control = state.start("job-1");
        assert_eq!(wait_for_slot(Some(&control)).await, JobSignal::Run);

        state.set_paused("job-1", true);
        assert!(control.paused.load(Ordering::Relaxed));
        // 暂停时 wait_for_slot 必须真的阻塞，而不是漏过去继续写文件
        assert!(tokio::time::timeout(
            Duration::from_millis(150),
            wait_for_slot(Some(&control))
        )
        .await
        .is_err());

        state.set_paused("job-1", false);
        assert_eq!(wait_for_slot(Some(&control)).await, JobSignal::Run);

        state.cancel("job-1");
        assert!(control.is_canceled());
        assert_eq!(wait_for_slot(Some(&control)).await, JobSignal::Canceled);
        assert!(state.jobs.lock().unwrap().is_empty());
    }

    /// 端到端：真实 sftp-server 上验证「暂停真的挡住写入 → 恢复后字节完整 → 取消不留文件」。
    #[tokio::test]
    async fn sftp_transfer_control_against_local_server() {
        let Ok(addr) = std::env::var("NANOSSH_SFTP_E2E") else { return; };
        let root = std::env::var("NANOSSH_SFTP_ROOT").expect("需要 NANOSSH_SFTP_ROOT");
        let work = std::env::temp_dir().join(format!("nanossh-control-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&work).unwrap();
        let local = work.join("control.bin");
        let payload: Vec<u8> = (0..400_000).map(|i| (i % 253) as u8).collect();
        std::fs::write(&local, &payload).unwrap();

        let stream = tokio::net::TcpStream::connect(&addr).await.expect("连接本地 SFTP 桥失败");
        let sftp = Arc::new(SftpSession::new(stream).await.expect("SFTP 握手失败"));
        sftp.set_timeout(15);

        // 1) 一开始就暂停：传输不得创建远端文件，任务也不许偷偷跑完
        let control = Arc::new(JobControl::default());
        control.paused.store(true, Ordering::Relaxed);
        let (s2, c2, p2, r2) = (
            sftp.clone(), control.clone(),
            local.to_string_lossy().to_string(), root.clone(),
        );
        let task = tokio::spawn(async move {
            send_files_via_sftp(&s2, None, "e2e", &[p2], &r2, true, Some(c2.as_ref())).await
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!std::path::Path::new(&root).join("control.bin").exists(), "暂停时不应写入远端文件");
        assert!(!task.is_finished(), "暂停时任务应仍在等待");

        // 2) 恢复后完整写入，逐字节一致
        control.paused.store(false, Ordering::Relaxed);
        let outcomes = task.await.unwrap();
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].ok, "恢复后上传应成功：{}", outcomes[0].error);
        assert_eq!(
            std::fs::read(std::path::Path::new(&root).join("control.bin")).unwrap(),
            payload,
            "恢复后远端文件应与本地完全一致"
        );

        // 3) 取消：传输开始前被取消，不应留下任何远端文件
        let cancel = Arc::new(JobControl::default());
        cancel.paused.store(true, Ordering::Relaxed);
        let local2 = work.join("cancel.bin");
        std::fs::write(&local2, b"never").unwrap();
        let (s3, c3, p3, r3) = (
            sftp.clone(), cancel.clone(),
            local2.to_string_lossy().to_string(), root.clone(),
        );
        let task2 = tokio::spawn(async move {
            send_files_via_sftp(&s3, None, "e2e", &[p3], &r3, true, Some(c3.as_ref())).await
        });
        tokio::time::sleep(Duration::from_millis(120)).await;
        cancel.canceled.store(true, Ordering::Relaxed);
        assert!(task2.await.unwrap().is_empty(), "取消后不应再产生传输结果");
        assert!(!std::path::Path::new(&root).join("cancel.bin").exists(), "取消不应留下远端文件");

        let _ = sftp.close().await;
        let _ = std::fs::remove_file(std::path::Path::new(&root).join("control.bin"));
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn empty_profile_list_roundtrips() {
        let blob = encrypt_json(&key(), "[]").unwrap();
        assert_eq!(decrypt_json(&key(), &blob).unwrap(), "[]");
    }
}

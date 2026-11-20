//! Google Antigravity Real-Time Monitor — tracks local brain transcript.jsonl files + MCP status updates.

use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Debug)]
pub struct ProjectState {
    pub provider: String,
    pub project: String,
    pub task: String,
    pub status: String,
    pub phase: String,
    pub tool: String,
    pub file: String,
    pub command: String,
    pub progress: Option<f64>,
    pub conversation_id: String,
    pub last_mcp_time: u64,
    pub updated_at: u64,
}

impl ProjectState {
    pub fn default_idle() -> Self {
        Self {
            provider: "Google Antigravity".to_string(),
            project: "Antigravity".to_string(),
            task: String::new(),
            status: "idle".to_string(),
            phase: String::new(),
            tool: String::new(),
            file: String::new(),
            command: String::new(),
            progress: None,
            conversation_id: String::new(),
            last_mcp_time: 0,
            updated_at: now_ms(),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "provider": self.provider,
            "project": self.project,
            "task": self.task,
            "status": self.status,
            "phase": self.phase,
            "tool": self.tool,
            "file": self.file,
            "command": self.command,
            "progress": self.progress,
            "conversationId": self.conversation_id,
            "updatedAt": self.updated_at
        })
    }
}

pub struct AntigravityMonitor {
    brain_dir: PathBuf,
    projects: HashMap<String, ProjectState>,
    file_offsets: HashMap<String, u64>,
    last_state: ProjectState,
    pub paused: bool,
}

fn path_proj_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)(?:Documents[\\/]antigravity|scratch|projects|repos|workspace)[\\/]([^\\/"'\s\r\n]+)"#).unwrap()
    })
}

fn workspace_header_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)(?:Active Workspaces|Command Working Directory):[\s\r\n-]+(?:[a-zA-Z]:)?[\\/][^"'\r\n]+[\\/]([^"'\r\n\\/]+)"#).unwrap()
    })
}

fn clean_arg(val: &Value) -> String {
    let s = match val {
        Value::String(s) => s.trim().to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    if s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')))
    {
        s[1..s.len() - 1].to_string()
    } else {
        s
    }
}

fn status_weight(s: &str) -> i32 {
    match s {
        "running" => 3,
        "thinking" => 2,
        "waiting" => 1,
        _ => 0,
    }
}

fn is_active_status(s: &str) -> bool {
    matches!(s, "running" | "thinking" | "waiting" | "RUNNING")
}

impl AntigravityMonitor {
    pub fn new() -> Self {
        let user_home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| "C:\\Users\\russell".to_string());
        let brain_dir = PathBuf::from(user_home)
            .join(".gemini")
            .join("antigravity")
            .join("brain");
        Self::with_brain_dir(brain_dir)
    }

    pub fn with_brain_dir(brain_dir: PathBuf) -> Self {
        Self {
            brain_dir,
            projects: HashMap::new(),
            file_offsets: HashMap::new(),
            last_state: ProjectState::default_idle(),
            paused: false,
        }
    }

    pub fn has_active(&self) -> bool {
        self.projects
            .values()
            .any(|p| p.status == "running" || p.status == "RUNNING")
    }

    pub fn get_state(&self) -> Value {
        let now = now_ms();
        let mut list: Vec<ProjectState> = self
            .projects
            .values()
            .filter(|p| {
                if p.status == "not_running" {
                    return false;
                }
                if p.status == "idle" && now.saturating_sub(p.updated_at) > 20 * 60 * 1000 {
                    return false;
                }
                true
            })
            .cloned()
            .collect();

        list.sort_by(|a, b| {
            let aw = status_weight(&a.status);
            let bw = status_weight(&b.status);
            bw.cmp(&aw).then_with(|| b.updated_at.cmp(&a.updated_at))
        });

        let primary = list.first().cloned().unwrap_or_else(|| self.last_state.clone());
        let projects_arr: Vec<Value> = if list.is_empty() {
            vec![self.last_state.to_json()]
        } else {
            list.iter().map(|p| p.to_json()).collect()
        };

        let mut obj = primary.to_json();
        if let Some(m) = obj.as_object_mut() {
            m.insert("projects".to_string(), Value::Array(projects_arr));
        }
        obj
    }

    fn resolve_mcp_conversation_id(&self, data: &Value) -> String {
        if let Some(cid) = data.get("conversationId").and_then(|v| v.as_str()) {
            if !cid.is_empty() {
                return cid.to_string();
            }
        }
        let mut real_projects: Vec<&ProjectState> = self
            .projects
            .values()
            .filter(|p| !p.conversation_id.is_empty() && p.conversation_id != "default")
            .collect();
        real_projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        if real_projects.is_empty() {
            return "default".to_string();
        }
        if let Some(proj) = data.get("project").and_then(|v| v.as_str()) {
            let target = proj.to_lowercase();
            if let Some(m) = real_projects.iter().find(|p| {
                is_active_status(&p.status) && p.project.to_lowercase() == target
            }) {
                return m.conversation_id.clone();
            }
            if let Some(m) = real_projects
                .iter()
                .find(|p| p.project.to_lowercase() == target)
            {
                return m.conversation_id.clone();
            }
        }
        if let Some(m) = real_projects.iter().find(|p| is_active_status(&p.status)) {
            return m.conversation_id.clone();
        }
        real_projects[0].conversation_id.clone()
    }

    pub fn update_from_mcp(&mut self, data: &Value) -> bool {
        if !data.is_object() {
            return false;
        }
        let now = now_ms();
        let conv_id = self.resolve_mcp_conversation_id(data);
        let mut entry = self.projects.get(&conv_id).cloned().unwrap_or_else(|| {
            let mut p = ProjectState::default_idle();
            p.conversation_id = conv_id.clone();
            p.project = data
                .get("project")
                .and_then(|v| v.as_str())
                .unwrap_or("Antigravity")
                .to_string();
            p
        });

        entry.status = data
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("running")
            .to_string();
        entry.phase = data
            .get("phase")
            .and_then(|v| v.as_str())
            .unwrap_or("Agent Active")
            .to_string();
        if let Some(s) = data.get("project").and_then(|v| v.as_str()) {
            if !s.is_empty() {
                entry.project = s.to_string();
            }
        }
        if let Some(s) = data.get("task").and_then(|v| v.as_str()) {
            if !s.is_empty() {
                entry.task = s.to_string();
            }
        }
        if let Some(s) = data.get("tool").and_then(|v| v.as_str()) {
            if !s.is_empty() {
                entry.tool = s.to_string();
            }
        }
        if let Some(s) = data.get("file").and_then(|v| v.as_str()) {
            if !s.is_empty() {
                entry.file = s.to_string();
            }
        }
        if let Some(s) = data.get("command").and_then(|v| v.as_str()) {
            if !s.is_empty() {
                entry.command = s.to_string();
            }
        }
        if let Some(p) = data.get("progress").and_then(|v| v.as_f64()) {
            entry.progress = Some(p);
        }
        entry.last_mcp_time = now;
        entry.updated_at = now;

        self.last_state = entry.clone();
        self.projects.insert(conv_id, entry);
        true
    }

    pub fn mark_not_running(&mut self) {
        self.last_state.status = "not_running".to_string();
        self.last_state.phase = "Antigravity is not running".to_string();
    }

    fn extract_project_name(transcript_path: &Path, fallback: &str) -> String {
        let Ok(content) = fs::read_to_string(transcript_path) else {
            return fallback.to_string();
        };
        let lines: Vec<&str> = content.lines().collect();
        let proj_re = path_proj_regex();
        let ws_re = workspace_header_regex();

        let check_line = |line: &str| -> Option<String> {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let step: Value = serde_json::from_str(trimmed).ok()?;
            if let Some(tcs) = step.get("tool_calls").and_then(|v| v.as_array()) {
                for tc in tcs {
                    if let Some(args) = tc.get("args").and_then(|v| v.as_object()) {
                        for val in args.values() {
                            let s = clean_arg(val);
                            if let Some(cap) = proj_re.captures(&s) {
                                let name = cap[1].replace('\\', "").trim().to_string();
                                if !name.is_empty()
                                    && name != "Documents"
                                    && name != "antigravity"
                                {
                                    return Some(name);
                                }
                            }
                        }
                    }
                }
            }
            if let Some(content_str) = step.get("content").and_then(|v| v.as_str()) {
                if let Some(cap) = ws_re.captures(content_str) {
                    let name = cap[1].trim().to_string();
                    if !name.is_empty() && name != "Documents" && name != "antigravity" {
                        return Some(name);
                    }
                }
            }
            None
        };

        for line in lines.iter().take(35) {
            if let Some(found) = check_line(line) {
                return found;
            }
        }
        for line in lines.iter().rev().take(25) {
            if let Some(found) = check_line(line) {
                return found;
            }
        }
        if fallback.is_empty() {
            "Island".to_string()
        } else {
            fallback.to_string()
        }
    }

    pub fn parse_step_to_state(
        step: &Value,
        conversation_id: &str,
        project_name: &str,
    ) -> Option<ProjectState> {
        if !step.is_object() {
            return None;
        }
        let mut new_status = "running";
        let mut phase = String::new();
        let mut tool_name = String::new();
        let mut cmd = String::new();
        let mut file_name = String::new();

        if let Some(tcs) = step.get("tool_calls").and_then(|v| v.as_array()) {
            if let Some(tc) = tcs.first() {
                let fn_name = tc
                    .get("name")
                    .or_else(|| tc.get("ToolName"))
                    .or_else(|| tc.get("function").and_then(|f| f.get("name")))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool");
                tool_name = fn_name.to_string();
                let raw_args = tc
                    .get("args")
                    .or_else(|| tc.get("Arguments"))
                    .and_then(|v| v.as_object());
                let get_arg = |k: &str| -> String {
                    raw_args
                        .and_then(|m| m.get(k))
                        .map(clean_arg)
                        .unwrap_or_default()
                };

                match fn_name {
                    "run_command" => {
                        let summary = get_arg("toolSummary");
                        let cmdline = get_arg("CommandLine");
                        cmd = if !summary.is_empty() {
                            summary
                        } else if !cmdline.is_empty() {
                            cmdline
                        } else {
                            "Executing command".to_string()
                        };
                        let shown = if cmd.chars().count() > 34 {
                            format!("{}...", cmd.chars().take(34).collect::<String>())
                        } else {
                            cmd.clone()
                        };
                        phase = format!("Command: {}", shown);
                    }
                    "write_file" | "edit_file" => {
                        let fp = get_arg("Path");
                        file_name = Path::new(&fp)
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| "file".to_string());
                        phase = format!("Editing {}", file_name);
                    }
                    "read_file" => {
                        let fp = get_arg("Path");
                        file_name = Path::new(&fp)
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| "file".to_string());
                        phase = format!("Reading {}", file_name);
                    }
                    "ask_question" => {
                        new_status = "waiting";
                        phase = "Waiting for your answer".to_string();
                    }
                    "call_mcp_tool" => {
                        let srv = {
                            let s = get_arg("ServerName");
                            if s.is_empty() { "MCP".to_string() } else { s }
                        };
                        let mt = {
                            let s = get_arg("ToolName");
                            if s.is_empty() { "tool".to_string() } else { s }
                        };
                        phase = format!("{}: {}", srv, mt);
                        tool_name = format!("{}.{}", srv, mt);
                    }
                    "search_web" => {
                        let q = get_arg("query");
                        let short: String = if q.is_empty() {
                            "web".to_string()
                        } else {
                            q.chars().take(28).collect()
                        };
                        phase = format!("Searching: {}", short);
                    }
                    "search_marketplace" => {
                        phase = "Searching marketplace".to_string();
                    }
                    "invoke_subagent" => {
                        let role = get_arg("Role");
                        let ty = get_arg("TypeName");
                        let label = if !role.is_empty() {
                            role
                        } else if !ty.is_empty() {
                            ty
                        } else {
                            "agent".to_string()
                        };
                        phase = format!("Subagent: {}", label);
                    }
                    _ => {
                        phase = format!("Tool: {}", fn_name);
                    }
                }
            }
        } else {
            let ty = step.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let st = step.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let has_thinking = step
                .get("thinking")
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            if ty == "USER_INPUT" {
                new_status = "running";
                phase = "Processing request...".to_string();
            } else if ty == "PLANNER_RESPONSE" && st == "DONE" {
                new_status = "done";
                phase = "Task finished".to_string();
            } else if has_thinking {
                new_status = "thinking";
                phase = "Thinking & analyzing solution...".to_string();
            } else if ty == "GENERIC" || ty == "TOOL_RESPONSE" {
                new_status = "running";
                phase = "Processing tool results...".to_string();
            } else {
                new_status = "idle";
                phase = "Ready".to_string();
            }
        }

        Some(ProjectState {
            provider: "Google Antigravity".to_string(),
            project: if project_name.is_empty() {
                "Antigravity".to_string()
            } else {
                project_name.to_string()
            },
            task: String::new(),
            status: new_status.to_string(),
            phase,
            tool: tool_name,
            file: file_name,
            command: cmd,
            progress: None,
            conversation_id: conversation_id.to_string(),
            last_mcp_time: 0,
            updated_at: now_ms(),
        })
    }

    /// Returns true if visible state changed.
    pub fn poll(&mut self) -> bool {
        if self.paused || !self.brain_dir.exists() {
            return false;
        }
        let Ok(entries) = fs::read_dir(&self.brain_dir) else {
            return false;
        };
        let now = now_ms();
        let mut any_changed = false;

        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() {
                continue;
            }
            let conv_name = entry.file_name().to_string_lossy().to_string();
            let transcript_file = entry
                .path()
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl");
            let Ok(meta) = fs::metadata(&transcript_file) else {
                continue;
            };
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let age_ms = now.saturating_sub(mtime_ms);
            let existing_active = self
                .projects
                .get(&conv_name)
                .map(|p| is_active_status(&p.status))
                .unwrap_or(false);

            if age_ms < 60_000 && self.projects.contains_key("default") {
                if let Some(def) = self.projects.remove("default") {
                    if !self.projects.contains_key(&conv_name)
                        && def.last_mcp_time > 0
                        && now.saturating_sub(def.last_mcp_time) < 4000
                    {
                        let mut moved = def;
                        moved.conversation_id = conv_name.clone();
                        self.projects.insert(conv_name.clone(), moved);
                    }
                }
            }

            let last_mcp_age = self
                .projects
                .get(&conv_name)
                .filter(|p| p.last_mcp_time > 0)
                .map(|p| now.saturating_sub(p.last_mcp_time))
                .unwrap_or(u64::MAX);
            let effective_age_ms = age_ms.min(last_mcp_age);

            if existing_active && effective_age_ms > 120_000 {
                if let Some(cur) = self.projects.get_mut(&conv_name) {
                    cur.status = "idle".to_string();
                    cur.phase = "Ready".to_string();
                    cur.updated_at = now;
                    self.last_state = cur.clone();
                    any_changed = true;
                }
                continue;
            }

            if age_ms > 25 * 60 * 1000 && !existing_active {
                let prune = self
                    .projects
                    .get(&conv_name)
                    .map(|p| {
                        (p.status == "done" || p.status == "idle")
                            && now.saturating_sub(p.updated_at) > 20 * 60 * 1000
                    })
                    .unwrap_or(false);
                if prune {
                    self.projects.remove(&conv_name);
                }
                continue;
            }

            let file_size = meta.len();
            let last_size = self.file_offsets.get(&conv_name).copied().unwrap_or(0);
            if file_size == last_size && self.projects.contains_key(&conv_name) {
                if let Some(cur) = self.projects.get_mut(&conv_name) {
                    if cur.status == "done" && now.saturating_sub(cur.updated_at) > 8000 {
                        cur.status = "idle".to_string();
                        cur.phase = "Ready".to_string();
                        self.last_state = cur.clone();
                        any_changed = true;
                    }
                }
                continue;
            }

            self.file_offsets.insert(conv_name.clone(), file_size);
            let read_len = file_size.min(262_144) as usize;
            if read_len == 0 {
                continue;
            }
            let Ok(mut f) = File::open(&transcript_file) else {
                continue;
            };
            let start_pos = file_size.saturating_sub(read_len as u64);
            if f.seek(SeekFrom::Start(start_pos)).is_err() {
                continue;
            }
            let mut buf = vec![0u8; read_len];
            let Ok(n) = f.read(&mut buf) else { continue };
            let chunk = String::from_utf8_lossy(&buf[..n]);
            let lines: Vec<&str> = chunk
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .collect();

            for line in lines.iter().rev() {
                let Ok(step) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                let cur_existing = self.projects.get(&conv_name).cloned();
                let proj_name = cur_existing
                    .as_ref()
                    .filter(|p| !p.project.is_empty() && p.project != "Antigravity")
                    .map(|p| p.project.clone())
                    .unwrap_or_else(|| {
                        Self::extract_project_name(&transcript_file, "Antigravity")
                    });

                let Some(mut parsed) = Self::parse_step_to_state(&step, &conv_name, &proj_name)
                else {
                    continue;
                };

                if cur_existing.is_none() {
                    if age_ms > 120_000 && is_active_status(&parsed.status) {
                        parsed.status = "idle".to_string();
                        parsed.phase = "Ready".to_string();
                        parsed.updated_at = mtime_ms;
                    } else if age_ms > 8000 && parsed.status == "done" {
                        parsed.status = "idle".to_string();
                        parsed.phase = "Ready".to_string();
                        parsed.updated_at = mtime_ms;
                    }
                }

                if let Some(ref cur) = cur_existing {
                    if parsed.phase == "Processing tool results..."
                        && !cur.phase.is_empty()
                        && cur.phase != "Ready"
                    {
                        parsed.phase = cur.phase.clone();
                        parsed.tool = cur.tool.clone();
                        parsed.command = cur.command.clone();
                        parsed.file = cur.file.clone();
                    }
                    if last_mcp_age < 4000
                        && parsed.status != "done"
                        && parsed.status != "waiting"
                    {
                        parsed.status = cur.status.clone();
                        parsed.phase = cur.phase.clone();
                        parsed.tool = cur.tool.clone();
                        parsed.command = cur.command.clone();
                        parsed.file = cur.file.clone();
                        parsed.progress = cur.progress;
                    }
                    if cur.last_mcp_time > 0 {
                        parsed.last_mcp_time = cur.last_mcp_time;
                    }
                }

                let changed = match &cur_existing {
                    None => true,
                    Some(prev) => prev.status != parsed.status || prev.phase != parsed.phase,
                };
                self.projects.insert(conv_name.clone(), parsed.clone());
                if changed {
                    self.last_state = parsed;
                    any_changed = true;
                }
                break;
            }
        }
        any_changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tool_calls_and_planner_done() {
        let step = json!({
            "type": "PLANNER_RESPONSE",
            "tool_calls": [{ "name": "edit_file", "args": { "Path": "C:\\repo\\main.rs" } }]
        });
        let st = AntigravityMonitor::parse_step_to_state(&step, "conv1", "Island").unwrap();
        assert_eq!(st.status, "running");
        assert_eq!(st.phase, "Editing main.rs");

        let done_step = json!({ "type": "PLANNER_RESPONSE", "status": "DONE" });
        let st2 = AntigravityMonitor::parse_step_to_state(&done_step, "conv1", "Island").unwrap();
        assert_eq!(st2.status, "done");
    }
}

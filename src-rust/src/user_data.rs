//! User Data Manager — local JSON persistence for Calendar, To-Do, Notes, Clock, and Dual-Zone Drop Shelf metadata.

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static ID_SEQ: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn gen_id(prefix: &str) -> String {
    let ts = now_ms();
    let seq = ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}_{}_{:x}", prefix, ts, (ts ^ (seq * 2654435761)) & 0xffffff)
}

fn safe_write_json(path: &Path, data: &Value) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(serialized) = serde_json::to_string_pretty(data) {
        let tmp = path.with_extension(format!("json.{}.tmp", now_ms()));
        if fs::write(&tmp, &serialized).is_ok() {
            if fs::rename(&tmp, path).is_err() {
                let _ = fs::write(path, &serialized);
                let _ = fs::remove_file(&tmp);
            }
        }
    }
}

fn safe_read_json(path: &Path, fallback: Value) -> Value {
    if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            return v;
        }
    }
    fallback
}

fn default_todos() -> Value {
    json!({
        "categories": ["Personal", "Work", "Island"],
        "tasks": [
            {
                "id": "default_task_1",
                "text": "Welcome to Dynamic Windows To-Do",
                "category": "Personal",
                "completed": false,
                "createdAt": now_ms()
            }
        ]
    })
}

fn default_clock() -> Value {
    json!({
        "timer": {
            "durationSec": 300,
            "remainingSec": 300,
            "running": false,
            "startedAt": null
        },
        "stopwatch": {
            "elapsedMs": 0,
            "running": false,
            "startedAt": null,
            "laps": []
        },
        "focus": {
            "mode": "work",
            "workDurationMin": 25,
            "breakDurationMin": 5,
            "sessionsCompleted": 0,
            "remainingSec": 1500,
            "running": false,
            "startedAt": null
        }
    })
}

fn normalize_path_str(p: &str) -> String {
    p.replace('/', "\\").trim().to_string()
}

fn basename_lower(p: &str) -> String {
    Path::new(&normalize_path_str(p))
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

pub struct UserDataManager {
    calendar_file: PathBuf,
    calendar_categories_file: PathBuf,
    todos_file: PathBuf,
    notes_file: PathBuf,
    clock_file: PathBuf,
    shelf_file: PathBuf,

    calendar_notes: Vec<Value>,
    calendar_categories: Vec<String>,
    todos: Value,
    notes: Vec<Value>,
    clock_state: Value,
    shelf_metadata: Map<String, Value>,
}

impl UserDataManager {
    pub fn new() -> Self {
        Self::with_dir(crate::config::data_dir())
    }

    pub fn with_dir(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        let calendar_file = dir.join("calendar_notes.json");
        let calendar_categories_file = dir.join("calendar_categories.json");
        let todos_file = dir.join("todos.json");
        let notes_file = dir.join("notes.json");
        let clock_file = dir.join("clock_state.json");
        let shelf_file = dir.join("drop_shelf_metadata.json");

        let calendar_notes = safe_read_json(&calendar_file, json!([]))
            .as_array()
            .cloned()
            .unwrap_or_default();
        let calendar_categories: Vec<String> = safe_read_json(
            &calendar_categories_file,
            json!(["General", "Personal", "Work"]),
        )
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .filter(|v: &Vec<String>| !v.is_empty())
        .unwrap_or_else(|| vec!["General".into(), "Personal".into(), "Work".into()]);
        let todos = safe_read_json(&todos_file, default_todos());
        let notes = safe_read_json(&notes_file, json!([]))
            .as_array()
            .cloned()
            .unwrap_or_default();
        let clock_state = safe_read_json(&clock_file, default_clock());
        let shelf_metadata = safe_read_json(&shelf_file, json!({}))
            .as_object()
            .cloned()
            .unwrap_or_default();

        Self {
            calendar_file,
            calendar_categories_file,
            todos_file,
            notes_file,
            clock_file,
            shelf_file,
            calendar_notes,
            calendar_categories,
            todos,
            notes,
            clock_state,
            shelf_metadata,
        }
    }

    // --- Calendar ---

    pub fn get_calendar_notes(&self) -> Value {
        Value::Array(self.calendar_notes.clone())
    }

    pub fn get_calendar_categories(&self) -> Value {
        Value::Array(
            self.calendar_categories
                .iter()
                .map(|c| Value::String(c.clone()))
                .collect(),
        )
    }

    pub fn add_calendar_category(&mut self, category: &str) -> bool {
        let clean = category.trim();
        if clean.is_empty() {
            return false;
        }
        if !self
            .calendar_categories
            .iter()
            .any(|c| c.eq_ignore_ascii_case(clean))
        {
            self.calendar_categories.push(clean.to_string());
            safe_write_json(&self.calendar_categories_file, &self.get_calendar_categories());
            return true;
        }
        false
    }

    pub fn add_calendar_note(&mut self, note: &Value) -> Value {
        let text = note
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        let date = note.get("date").and_then(|v| v.as_str()).unwrap_or("");
        if text.is_empty() || date.is_empty() {
            return Value::Null;
        }
        let description = note
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        let category = note
            .get("category")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("General");
        let color = note
            .get("color")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| s.starts_with('#') && (s.len() == 4 || s.len() == 7))
            .unwrap_or("#3b82f6");
        let repeat_raw = note.get("repeat").and_then(|v| v.as_str()).unwrap_or("none");
        let repeat = match repeat_raw {
            "none" | "yearly" | "monthly" | "weekly" | "daily" => repeat_raw,
            _ => "none",
        };
        let is_birthday = note
            .get("isBirthday")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            || repeat == "yearly";
        let date_str: String = date.chars().take(10).collect();

        if !self
            .calendar_categories
            .iter()
            .any(|c| c.eq_ignore_ascii_case(category))
        {
            self.calendar_categories.push(category.to_string());
            safe_write_json(&self.calendar_categories_file, &self.get_calendar_categories());
        }

        let created = json!({
            "id": gen_id("note"),
            "date": date_str,
            "text": text,
            "description": description,
            "category": category,
            "color": color,
            "repeat": repeat,
            "isBirthday": is_birthday,
            "createdAt": now_ms()
        });
        self.calendar_notes.push(created.clone());
        safe_write_json(&self.calendar_file, &Value::Array(self.calendar_notes.clone()));
        created
    }

    pub fn delete_calendar_note(&mut self, id: &str) -> bool {
        let before = self.calendar_notes.len();
        self.calendar_notes
            .retain(|n| n.get("id").and_then(|v| v.as_str()) != Some(id));
        if self.calendar_notes.len() != before {
            safe_write_json(&self.calendar_file, &Value::Array(self.calendar_notes.clone()));
            return true;
        }
        false
    }

    // --- To-Do ---

    pub fn get_todos(&self) -> Value {
        self.todos.clone()
    }

    pub fn add_todo_task(&mut self, task: &Value) -> Value {
        let text = task
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        if text.is_empty() {
            return Value::Null;
        }
        let cats: Vec<String> = self
            .todos
            .get("categories")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_else(|| vec!["Personal".to_string()]);
        let requested_cat = task.get("category").and_then(|v| v.as_str()).unwrap_or("");
        let category = if !requested_cat.is_empty() && cats.iter().any(|c| c == requested_cat) {
            requested_cat.to_string()
        } else {
            cats.first().cloned().unwrap_or_else(|| "General".to_string())
        };
        let created = json!({
            "id": gen_id("task"),
            "text": text,
            "category": category,
            "completed": false,
            "createdAt": now_ms()
        });
        if let Some(tasks) = self.todos.get_mut("tasks").and_then(|v| v.as_array_mut()) {
            tasks.insert(0, created.clone());
        }
        safe_write_json(&self.todos_file, &self.todos);
        created
    }

    pub fn toggle_todo_task(&mut self, id: &str) -> Value {
        let mut updated = Value::Null;
        if let Some(tasks) = self.todos.get_mut("tasks").and_then(|v| v.as_array_mut()) {
            for t in tasks.iter_mut() {
                if t.get("id").and_then(|v| v.as_str()) == Some(id) {
                    let next = !t.get("completed").and_then(|v| v.as_bool()).unwrap_or(false);
                    if let Some(obj) = t.as_object_mut() {
                        obj.insert("completed".to_string(), Value::Bool(next));
                        obj.insert(
                            "completedAt".to_string(),
                            if next { json!(now_ms()) } else { Value::Null },
                        );
                    }
                    updated = t.clone();
                    break;
                }
            }
        }
        if !updated.is_null() {
            safe_write_json(&self.todos_file, &self.todos);
        }
        updated
    }

    pub fn delete_todo_task(&mut self, id: &str) -> bool {
        let mut changed = false;
        if let Some(tasks) = self.todos.get_mut("tasks").and_then(|v| v.as_array_mut()) {
            let before = tasks.len();
            tasks.retain(|t| t.get("id").and_then(|v| v.as_str()) != Some(id));
            changed = tasks.len() != before;
        }
        if changed {
            safe_write_json(&self.todos_file, &self.todos);
        }
        changed
    }

    pub fn add_todo_category(&mut self, category: &str) -> bool {
        let cat = category.trim();
        if cat.is_empty() {
            return false;
        }
        if let Some(cats) = self.todos.get_mut("categories").and_then(|v| v.as_array_mut()) {
            if !cats.iter().any(|c| c.as_str() == Some(cat)) {
                cats.push(Value::String(cat.to_string()));
                safe_write_json(&self.todos_file, &self.todos);
                return true;
            }
        }
        false
    }

    pub fn delete_todo_category(&mut self, category: &str) -> bool {
        let cat = category.trim();
        let can_delete = self
            .todos
            .get("categories")
            .and_then(|v| v.as_array())
            .map(|cats| cats.len() > 1 && cats.iter().any(|c| c.as_str() == Some(cat)))
            .unwrap_or(false);
        if !can_delete {
            return false;
        }
        let mut fallback = "Personal".to_string();
        if let Some(cats) = self.todos.get_mut("categories").and_then(|v| v.as_array_mut()) {
            cats.retain(|c| c.as_str() != Some(cat));
            if let Some(first) = cats.first().and_then(|c| c.as_str()) {
                fallback = first.to_string();
            }
        }
        if let Some(tasks) = self.todos.get_mut("tasks").and_then(|v| v.as_array_mut()) {
            for t in tasks.iter_mut() {
                if t.get("category").and_then(|v| v.as_str()) == Some(cat) {
                    if let Some(obj) = t.as_object_mut() {
                        obj.insert("category".to_string(), Value::String(fallback.clone()));
                    }
                }
            }
        }
        safe_write_json(&self.todos_file, &self.todos);
        true
    }

    // --- Notes ---

    pub fn get_notes(&self) -> Value {
        Value::Array(self.notes.clone())
    }

    pub fn add_note(&mut self, payload: &Value) -> Value {
        let clean_title = payload
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        let clean_body = payload
            .get("body")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        let html = payload
            .get("html")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let font_family = payload
            .get("fontFamily")
            .and_then(|v| v.as_str())
            .unwrap_or("Sans");
        let font_size = payload
            .get("fontSize")
            .and_then(|v| v.as_u64())
            .unwrap_or(13);
        let allow_empty = payload
            .get("allowEmpty")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !allow_empty && clean_title.is_empty() && clean_body.is_empty() && html.trim().is_empty() {
            return Value::Null;
        }
        let title: String = if !clean_title.is_empty() {
            clean_title.to_string()
        } else if !clean_body.is_empty() {
            clean_body.chars().take(36).collect()
        } else {
            "Untitled Note".to_string()
        };
        let item = json!({
            "id": gen_id("note"),
            "title": title,
            "body": clean_body,
            "html": html,
            "fontFamily": font_family,
            "fontSize": font_size,
            "updatedAt": now_ms()
        });
        self.notes.insert(0, item.clone());
        safe_write_json(&self.notes_file, &Value::Array(self.notes.clone()));
        item
    }

    pub fn update_note(&mut self, payload: &Value) -> Value {
        let id = payload.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let clean_title = payload
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        let clean_body = payload
            .get("body")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        let html_opt = payload.get("html").and_then(|v| v.as_str());
        let font_family_opt = payload.get("fontFamily").and_then(|v| v.as_str());
        let font_size_opt = payload.get("fontSize").and_then(|v| v.as_u64());
        let title: String = if !clean_title.is_empty() {
            clean_title.to_string()
        } else if !clean_body.is_empty() {
            clean_body.chars().take(36).collect()
        } else {
            "Untitled Note".to_string()
        };

        for n in self.notes.iter_mut() {
            if n.get("id").and_then(|v| v.as_str()) == Some(id) {
                if let Some(obj) = n.as_object_mut() {
                    obj.insert("title".to_string(), Value::String(title));
                    obj.insert("body".to_string(), Value::String(clean_body.to_string()));
                    if let Some(h) = html_opt {
                        obj.insert("html".to_string(), Value::String(h.to_string()));
                    }
                    if let Some(ff) = font_family_opt {
                        obj.insert("fontFamily".to_string(), Value::String(ff.to_string()));
                    }
                    if let Some(fs) = font_size_opt {
                        obj.insert("fontSize".to_string(), json!(fs));
                    }
                    obj.insert("updatedAt".to_string(), json!(now_ms()));
                }
                let updated = n.clone();
                safe_write_json(&self.notes_file, &Value::Array(self.notes.clone()));
                return updated;
            }
        }
        Value::Null
    }

    pub fn delete_note(&mut self, id: &str) -> bool {
        let before = self.notes.len();
        self.notes
            .retain(|n| n.get("id").and_then(|v| v.as_str()) != Some(id));
        if self.notes.len() != before {
            safe_write_json(&self.notes_file, &Value::Array(self.notes.clone()));
            return true;
        }
        false
    }

    // --- Clock ---

    pub fn get_clock_state(&self) -> Value {
        self.clock_state.clone()
    }

    pub fn save_clock_state(&mut self, partial: &Value) -> Value {
        if let (Some(base), Some(patch)) = (self.clock_state.as_object_mut(), partial.as_object()) {
            for (k, v) in patch {
                base.insert(k.clone(), v.clone());
            }
            safe_write_json(&self.clock_file, &self.clock_state);
        }
        self.clock_state.clone()
    }

    // --- Drop Shelf Metadata (One-Time vs Keep) ---

    pub fn get_shelf_metadata(&self) -> Value {
        Value::Object(self.shelf_metadata.clone())
    }

    fn find_shelf_key(&self, file_path: &str) -> Option<String> {
        if file_path.is_empty() {
            return None;
        }
        let norm = normalize_path_str(file_path);
        if self.shelf_metadata.contains_key(&norm) {
            return Some(norm);
        }
        let lower_norm = norm.to_lowercase();
        for k in self.shelf_metadata.keys() {
            if normalize_path_str(k).to_lowercase() == lower_norm {
                return Some(k.clone());
            }
        }
        let base_lower = basename_lower(&norm);
        if !base_lower.is_empty() {
            for k in self.shelf_metadata.keys() {
                if basename_lower(k) == base_lower {
                    return Some(k.clone());
                }
            }
        }
        None
    }

    pub fn set_file_shelf_metadata(&mut self, file_path: &str, is_one_time: bool) {
        if file_path.is_empty() {
            return;
        }
        let key = self
            .find_shelf_key(file_path)
            .unwrap_or_else(|| normalize_path_str(file_path));
        self.shelf_metadata.insert(
            key,
            json!({
                "oneTime": is_one_time,
                "addedAt": now_ms()
            }),
        );
        safe_write_json(&self.shelf_file, &Value::Object(self.shelf_metadata.clone()));
    }

    pub fn is_one_time_file(&self, file_path: &str) -> bool {
        if let Some(key) = self.find_shelf_key(file_path) {
            return self
                .shelf_metadata
                .get(&key)
                .and_then(|v| v.get("oneTime"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
        }
        false
    }

    pub fn remove_file_shelf_metadata(&mut self, file_path: &str) {
        if let Some(key) = self.find_shelf_key(file_path) {
            self.shelf_metadata.remove(&key);
            safe_write_json(&self.shelf_file, &Value::Object(self.shelf_metadata.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shelf_metadata_matches_case_and_basename() {
        let tmp = std::env::temp_dir().join(format!("dw_ud_test_{}", now_ms()));
        let mut mgr = UserDataManager::with_dir(tmp.clone());
        mgr.set_file_shelf_metadata("C:\\Users\\Test\\drop_zone\\Report.PDF", true);
        assert!(mgr.is_one_time_file("c:/users/test/drop_zone/report.pdf"));
        assert!(mgr.is_one_time_file("report.pdf"));
        mgr.remove_file_shelf_metadata("Report.PDF");
        assert!(!mgr.is_one_time_file("report.pdf"));

        let n = mgr.add_note(&json!({ "title": "Idea", "body": "Ship Rust rewrite" }));
        let nid = n.get("id").unwrap().as_str().unwrap().to_string();
        assert_eq!(mgr.get_notes().as_array().unwrap().len(), 1);
        mgr.delete_note(&nid);
        assert_eq!(mgr.get_notes().as_array().unwrap().len(), 0);
        let _ = fs::remove_dir_all(&tmp);
    }
}

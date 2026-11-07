use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarNote {
    pub id: String,
    pub date: String,
    pub text: String,
    pub repeat: String,
    pub is_birthday: bool,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoTask {
    pub id: String,
    pub text: String,
    pub category: String,
    pub completed: bool,
    pub created_at: u64,
    pub completed_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoData {
    pub categories: Vec<String>,
    pub tasks: Vec<TodoTask>,
}

impl Default for TodoData {
    fn default() -> Self {
        Self {
            categories: vec!["Personal".into(), "Work".into(), "Island".into()],
            tasks: vec![TodoTask {
                id: "default_task_1".into(),
                text: "Welcome to Dynamic Windows To-Do".into(),
                category: "Personal".into(),
                completed: false,
                created_at: 0,
                completed_at: None,
            }],
        }
    }
}

pub struct UserDataManager {
    data_dir: PathBuf,
}

impl UserDataManager {
    pub fn new() -> Self {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| "C:\\AppData".into());
        let data_dir = PathBuf::from(appdata).join("DynamicWindows");
        let _ = fs::create_dir_all(&data_dir);
        Self { data_dir }
    }

    fn calendar_file(&self) -> PathBuf {
        self.data_dir.join("calendar_notes.json")
    }

    fn todos_file(&self) -> PathBuf {
        self.data_dir.join("todos.json")
    }

    // --- Calendar Engine ---

    pub fn get_calendar_notes(&self) -> Vec<CalendarNote> {
        let file = self.calendar_file();
        if file.exists() {
            if let Ok(content) = fs::read_to_string(file) {
                if let Ok(notes) = serde_json::from_str(&content) {
                    return notes;
                }
            }
        }
        Vec::new()
    }

    pub fn add_calendar_note(&self, text: &str, date: &str, repeat: &str, is_birthday: bool) -> CalendarNote {
        let mut notes = self.get_calendar_notes();
        let valid_repeat = match repeat {
            "yearly" | "monthly" | "weekly" | "daily" => repeat,
            _ => "none",
        };
        let note = CalendarNote {
            id: format!("note_{}_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0), notes.len()),
            date: date.chars().take(10).collect(),
            text: text.trim().to_string(),
            repeat: valid_repeat.to_string(),
            is_birthday: is_birthday || valid_repeat == "yearly",
            created_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        };
        notes.push(note.clone());
        let _ = fs::write(self.calendar_file(), serde_json::to_string_pretty(&notes).unwrap_or_default());
        note
    }

    pub fn delete_calendar_note(&self, id: &str) -> bool {
        let mut notes = self.get_calendar_notes();
        let len_before = notes.len();
        notes.retain(|n| n.id != id);
        if notes.len() != len_before {
            let _ = fs::write(self.calendar_file(), serde_json::to_string_pretty(&notes).unwrap_or_default());
            return true;
        }
        false
    }

    pub fn matches_date(note: &CalendarNote, target_date_str: &str) -> bool {
        if note.date.len() < 10 || target_date_str.len() < 10 {
            return false;
        }
        let note_date = &note.date[..10];
        let target_date = &target_date_str[..10];

        match note.repeat.as_str() {
            "yearly" => note_date[5..] == target_date[5..],
            "monthly" => note_date[8..] == target_date[8..],
            "daily" => target_date >= note_date,
            "weekly" => {
                // Approximate weekly match by ISO weekday comparison
                chrono_matches_weekday(note_date, target_date)
            }
            _ => note_date == target_date,
        }
    }

    // --- To-Do Engine ---

    pub fn get_todos(&self) -> TodoData {
        let file = self.todos_file();
        if file.exists() {
            if let Ok(content) = fs::read_to_string(file) {
                if let Ok(todos) = serde_json::from_str(&content) {
                    return todos;
                }
            }
        }
        let def = TodoData::default();
        let _ = fs::write(self.todos_file(), serde_json::to_string_pretty(&def).unwrap_or_default());
        def
    }

    pub fn add_todo_task(&self, text: &str, category: Option<&str>) -> TodoTask {
        let mut data = self.get_todos();
        let cat = category.filter(|c| data.categories.iter().any(|cat| cat == *c))
            .unwrap_or_else(|| data.categories.first().map(|s| s.as_str()).unwrap_or("General"));

        let task = TodoTask {
            id: format!("task_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)),
            text: text.trim().to_string(),
            category: cat.to_string(),
            completed: false,
            created_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            completed_at: None,
        };
        data.tasks.insert(0, task.clone());
        let _ = fs::write(self.todos_file(), serde_json::to_string_pretty(&data).unwrap_or_default());
        task
    }

    pub fn toggle_todo_task(&self, id: &str) -> Option<TodoTask> {
        let mut data = self.get_todos();
        if let Some(task) = data.tasks.iter_mut().find(|t| t.id == id) {
            task.completed = !task.completed;
            task.completed_at = if task.completed {
                Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
            } else {
                None
            };
            let ret = task.clone();
            let _ = fs::write(self.todos_file(), serde_json::to_string_pretty(&data).unwrap_or_default());
            return Some(ret);
        }
        None
    }

    pub fn delete_todo_task(&self, id: &str) -> bool {
        let mut data = self.get_todos();
        let len_before = data.tasks.len();
        data.tasks.retain(|t| t.id != id);
        if data.tasks.len() != len_before {
            let _ = fs::write(self.todos_file(), serde_json::to_string_pretty(&data).unwrap_or_default());
            return true;
        }
        false
    }
}

fn chrono_matches_weekday(d1: &str, d2: &str) -> bool {
    // Basic day-of-week match based on Gregorian calendar epoch calculation
    let w1 = parse_day_of_week(d1);
    let w2 = parse_day_of_week(d2);
    w1.is_some() && w1 == w2
}

fn parse_day_of_week(date_str: &str) -> Option<u32> {
    let parts: Vec<&str> = date_str.split('-').collect();
    if parts.len() < 3 { return None; }
    let y: i32 = parts[0].parse().ok()?;
    let m: i32 = parts[1].parse().ok()?;
    let d: i32 = parts[2].parse().ok()?;

    // Sakamoto's algorithm for day of week (0=Sunday, 1=Monday, ...)
    let t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let y_adj = if m < 3 { y - 1 } else { y };
    let dow = (y_adj + y_adj/4 - y_adj/100 + y_adj/400 + t[(m - 1) as usize] + d) % 7;
    Some(dow as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_recurrence_matching() {
        let yearly_note = CalendarNote {
            id: "1".into(),
            date: "2024-11-06".into(),
            text: "Birthday".into(),
            repeat: "yearly".into(),
            is_birthday: true,
            created_at: 0,
        };
        assert!(UserDataManager::matches_date(&yearly_note, "2026-11-06"));
        assert!(!UserDataManager::matches_date(&yearly_note, "2026-11-07"));

        let monthly_note = CalendarNote {
            id: "2".into(),
            date: "2025-01-15".into(),
            text: "Rent".into(),
            repeat: "monthly".into(),
            is_birthday: false,
            created_at: 0,
        };
        assert!(UserDataManager::matches_date(&monthly_note, "2026-08-15"));
        assert!(!UserDataManager::matches_date(&monthly_note, "2026-08-16"));

        let daily_note = CalendarNote {
            id: "3".into(),
            date: "2026-01-01".into(),
            text: "Habit".into(),
            repeat: "daily".into(),
            is_birthday: false,
            created_at: 0,
        };
        assert!(UserDataManager::matches_date(&daily_note, "2026-05-20"));
        assert!(!UserDataManager::matches_date(&daily_note, "2025-12-31"));
    }
}

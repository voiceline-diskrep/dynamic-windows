//! Drop Zone File Shelf — persistent file storage in %APPDATA%\DynamicWindows\drop_zone\

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub struct DropZone {
    pub dir: PathBuf,
}

impl DropZone {
    pub fn new() -> Self {
        let dir = crate::config::data_dir().join("drop_zone");
        let dz = Self { dir };
        dz.ensure_dir();
        dz
    }

    pub fn ensure_dir(&self) {
        let _ = fs::create_dir_all(&self.dir);
    }

    pub fn get_files(&self) -> Vec<Value> {
        self.ensure_dir();
        let mut files = Vec::new();
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return files;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if let Ok(meta) = entry.metadata() {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as f64)
                    .unwrap_or(0.0);
                files.push(json!({
                    "name": name,
                    "path": path.to_string_lossy().to_string(),
                    "size": meta.len(),
                    "mtime": mtime,
                    "isDirectory": meta.is_dir()
                }));
            }
        }
        files
    }

    pub fn add_file(&self, src_path: &str) -> Option<PathBuf> {
        self.ensure_dir();
        let src = Path::new(src_path);
        if !src.exists() {
            return None;
        }
        let base_name = src.file_name()?;
        let dest = self.dir.join(base_name);
        if src
            .canonicalize()
            .ok()
            .zip(dest.canonicalize().ok())
            .map(|(a, b)| a == b)
            .unwrap_or(false)
        {
            return Some(dest);
        }
        if src.is_dir() {
            if copy_dir_recursive(src, &dest).is_ok() {
                return Some(dest);
            }
        } else if fs::copy(src, &dest).is_ok() {
            return Some(dest);
        }
        None
    }

    pub fn open_file(&self, target: &str) {
        self.ensure_dir();
        let full = if Path::new(target).is_absolute() {
            PathBuf::from(target)
        } else {
            self.dir.join(target)
        };
        if full.exists() {
            crate::sys_win::shell_open(&full.to_string_lossy());
        } else {
            crate::sys_win::shell_open(&self.dir.to_string_lossy());
        }
    }

    pub fn reveal_in_explorer(&self, target: Option<&str>) {
        self.ensure_dir();
        if let Some(t) = target {
            if !t.is_empty() {
                let full = if Path::new(t).is_absolute() {
                    PathBuf::from(t)
                } else {
                    self.dir.join(t)
                };
                if full.exists() {
                    crate::sys_win::reveal_in_explorer(&full.to_string_lossy());
                    return;
                }
            }
        }
        crate::sys_win::shell_open(&self.dir.to_string_lossy());
    }

    pub fn delete_file(&self, target: &str) -> bool {
        if target.is_empty() {
            return false;
        }
        let full = if Path::new(target).is_absolute() {
            PathBuf::from(target)
        } else {
            self.dir.join(target)
        };
        if !full.exists() {
            return false;
        }
        if full.is_dir() {
            fs::remove_dir_all(&full).is_ok()
        } else {
            fs::remove_file(&full).is_ok()
        }
    }

    pub fn clear_all(&self) -> bool {
        self.ensure_dir();
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let _ = fs::remove_dir_all(&p);
            } else {
                let _ = fs::remove_file(&p);
            }
        }
        true
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

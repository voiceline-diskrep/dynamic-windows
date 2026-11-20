//! GitHub Releases Update Checker (native Rust via ureq)

use serde_json::{json, Value};
use std::time::Duration;

pub fn compare_versions(v1: &str, v2: &str) -> i32 {
    let parse = |s: &str| -> Vec<u32> {
        s.trim()
            .trim_start_matches('v')
            .split('.')
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect()
    };
    let p1 = parse(v1);
    let p2 = parse(v2);
    let len = p1.len().max(p2.len());
    for i in 0..len {
        let a = *p1.get(i).unwrap_or(&0);
        let b = *p2.get(i).unwrap_or(&0);
        if a > b {
            return 1;
        }
        if a < b {
            return -1;
        }
    }
    0
}

pub fn check_for_github_update(owner: &str, repo: &str, current_version: &str) -> Value {
    let api_url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        owner, repo
    );
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(6))
        .build();

    if let Ok(resp) = agent
        .get(&api_url)
        .set("User-Agent", "DynamicWindows-Desktop-App")
        .call()
    {
        if let Ok(data) = resp.into_json::<Value>() {
            let tag_raw = data.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
            let tag = tag_raw.trim_start_matches('v');
            if !tag.is_empty() {
                let is_newer = compare_versions(tag, current_version) > 0;
                let mut download_url = data
                    .get("html_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(assets) = data.get("assets").and_then(|v| v.as_array()) {
                    for a in assets {
                        let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        if name.ends_with(".exe") {
                            if let Some(u) = a.get("browser_download_url").and_then(|v| v.as_str()) {
                                download_url = u.to_string();
                                break;
                            }
                        }
                    }
                }
                return json!({
                    "updateAvailable": is_newer,
                    "latestVersion": tag,
                    "currentVersion": current_version,
                    "releaseName": data.get("name").and_then(|v| v.as_str()).unwrap_or(tag_raw),
                    "releaseNotes": data.get("body").and_then(|v| v.as_str()).unwrap_or("No release notes provided."),
                    "downloadUrl": download_url
                });
            }
        }
    }

    // Fallback: follow redirect on github.com/owner/repo/releases/latest
    let web_url = format!("https://github.com/{}/{}/releases/latest", owner, repo);
    let no_redir = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(6))
        .redirects(0)
        .build();
    match no_redir
        .get(&web_url)
        .set("User-Agent", "DynamicWindows-Desktop-App")
        .call()
    {
        Ok(resp) => {
            let loc = resp.header("location").unwrap_or("");
            if let Some(idx) = loc.rfind("/tag/") {
                let tag = loc[idx + 5..].trim_start_matches('v');
                if !tag.is_empty() {
                    let is_newer = compare_versions(tag, current_version) > 0;
                    return json!({
                        "updateAvailable": is_newer,
                        "latestVersion": tag,
                        "currentVersion": current_version,
                        "releaseName": format!("Dynamic Windows v{}", tag),
                        "releaseNotes": format!("Visit GitHub for release details: {}", loc),
                        "downloadUrl": format!("https://github.com/{}/{}/releases/download/v{}/DynamicWindows-Setup-v{}.exe", owner, repo, tag, tag)
                    });
                }
            }
            json!({ "error": "Could not determine latest release version." })
        }
        Err(e) => json!({ "error": format!("Update check failed: {}", e) }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_comparison_works() {
        assert_eq!(compare_versions("2.0.0", "1.4.45"), 1);
        assert_eq!(compare_versions("1.4.45", "1.4.45"), 0);
        assert_eq!(compare_versions("1.4.9", "1.4.45"), -1);
    }
}

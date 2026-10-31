"""
Dynamic Windows - Updater Engine
Handles GitHub Releases API querying, semantic version parsing,
asset selection, resilient downloading with checksum verification,
and safe Windows update application.
"""

import os
import sys
import re
import time
import hashlib
import platform
import subprocess
import urllib.request
import urllib.error
import json
from dataclasses import dataclass
from typing import Optional, List, Tuple

from PyQt6.QtCore import QThread, pyqtSignal

from updater_config import (
    CURRENT_VERSION, DEFAULT_REPO_OWNER, DEFAULT_REPO_NAME,
    UPDATES_DIR, APPDATA_DIR, save_config, load_config
)
import updater_logger as logger

CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008


@dataclass
class ReleaseInfo:
    version: str
    raw_tag: str
    title: str
    summary: str
    notes: str
    html_url: str
    published_at: str
    prerelease: bool
    asset_name: str
    asset_url: str
    asset_size: int
    expected_hash: Optional[str] = None


# ---------------------------------------------------------
# Semantic Versioning Engine
# ---------------------------------------------------------
def parse_version(v_str: str) -> Tuple[Tuple[int, int, int], List[str], bool]:
    """
    Parse a semantic version string.
    Returns ((major, minor, patch), prerelease_tokens, is_prerelease).
    Normal releases take precedence over pre-releases (e.g. 1.1.0 > 1.1.0-beta).
    """
    if not v_str:
        return ((0, 0, 0), [], False)

    clean = v_str.strip().lstrip("vV")
    # Strip build metadata
    if "+" in clean:
        clean = clean.split("+", 1)[0]

    prerelease_tokens = []
    is_prerelease = False

    if "-" in clean:
        parts = clean.split("-", 1)
        core = parts[0]
        prerelease_str = parts[1]
        is_prerelease = True
        prerelease_tokens = prerelease_str.split(".")
    else:
        core = clean

    # Parse major.minor.patch
    nums = []
    for part in core.split("."):
        try:
            nums.append(int(re.sub(r"[^\d]", "", part) or "0"))
        except ValueError:
            nums.append(0)

    while len(nums) < 3:
        nums.append(0)

    core_tuple = (nums[0], nums[1], nums[2])
    return (core_tuple, prerelease_tokens, is_prerelease)


def compare_versions(v1_str: str, v2_str: str) -> int:
    """
    Compare two version strings according to SemVer 2.0.0.
    Returns:
       1 if v1 > v2
      -1 if v1 < v2
       0 if v1 == v2
    """
    core1, pre1, is_pre1 = parse_version(v1_str)
    core2, pre2, is_pre2 = parse_version(v2_str)

    # 1. Compare numeric core (major, minor, patch)
    if core1 > core2:
        return 1
    elif core1 < core2:
        return -1

    # 2. Both cores match. A normal release is higher than a pre-release!
    if not is_pre1 and is_pre2:
        return 1
    if is_pre1 and not is_pre2:
        return -1
    if not is_pre1 and not is_pre2:
        return 0

    # 3. Both are pre-releases: compare tokens lexicographically/numerically
    for t1, t2 in zip(pre1, pre2):
        if t1.isdigit() and t2.isdigit():
            i1, i2 = int(t1), int(t2)
            if i1 != i2:
                return 1 if i1 > i2 else -1
        else:
            if t1 != t2:
                return 1 if t1 > t2 else -1

    if len(pre1) > len(pre2):
        return 1
    elif len(pre1) < len(pre2):
        return -1

    return 0


def is_newer_version(candidate_str: str, current_str: str) -> bool:
    """Return True if candidate_str is strictly newer than current_str."""
    return compare_versions(candidate_str, current_str) > 0


# ---------------------------------------------------------
# GitHub Releases Querying & Asset Detection
# ---------------------------------------------------------
def create_github_request(url: str, token: Optional[str] = None) -> urllib.request.Request:
    """Create an authorized urllib Request for the GitHub API."""
    req = urllib.request.Request(url)
    req.add_header("User-Agent", f"DynamicWindows-Updater/{CURRENT_VERSION}")
    req.add_header("Accept", "application/vnd.github.v3+json")
    if token and token.strip():
        req.add_header("Authorization", f"Bearer {token.strip()}")
    return req


def fetch_all_releases(repo_owner: str, repo_name: str, token: Optional[str] = None) -> List[dict]:
    """Fetch releases list from GitHub API."""
    url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/releases"
    req = create_github_request(url, token)
    with urllib.request.urlopen(req, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError(f"GitHub API returned HTTP {response.status}")
        return json.loads(response.read().decode("utf-8"))


def find_compatible_windows_asset(release: dict) -> Tuple[Optional[dict], Optional[str]]:
    """
    Identify compatible Windows executable asset and its expected hash.
    Prioritizes:
    1. DynamicWindows-Setup-*.exe or *Setup*.exe
    2. Architecture-matched executable (AMD64 / x86_64)
    3. Any Windows installer .exe
    """
    assets = release.get("assets", [])
    if not assets:
        return (None, None)

    system_arch = platform.machine().lower()  # 'amd64', 'x86_64', 'arm64'
    best_asset = None
    expected_hash = None

    # Step 1: Scan for checksum files if available in release
    checksum_map = {}
    for a in assets:
        name_lower = a.get("name", "").lower()
        if any(name_lower.endswith(ext) for ext in [".sha256", "sha256.txt", "checksums.txt"]):
            try:
                cs_req = create_github_request(a.get("browser_download_url"))
                with urllib.request.urlopen(cs_req, timeout=5) as cs_res:
                    content = cs_res.read().decode("utf-8", errors="ignore")
                    for line in content.splitlines():
                        match = re.search(r"([a-fA-F0-9]{64})\s+[*]?(\S+)", line)
                        if match:
                            h, fn = match.groups()
                            checksum_map[fn.strip().lower()] = h.lower()
            except Exception:
                pass

    # Step 2: Score assets
    scored_assets = []
    for a in assets:
        name = a.get("name", "")
        name_l = name.lower()

        # Must be Windows installer or executable
        if not name_l.endswith(".exe"):
            continue

        score = 0
        if "setup" in name_l:
            score += 50
        if "dynamicwindows" in name_l or "dynamic_windows" in name_l or "dynamic-windows" in name_l:
            score += 30

        # Architecture matching
        if "arm64" in name_l:
            if "arm" in system_arch:
                score += 20
            else:
                score -= 100  # Incompatible architecture
        elif "x64" in name_l or "64" in name_l or "amd64" in name_l:
            if "arm" not in system_arch:
                score += 20

        scored_assets.append((score, a))

    if scored_assets:
        scored_assets.sort(key=lambda x: x[0], reverse=True)
        best_asset = scored_assets[0][1]

    if best_asset:
        # Check if asset has digest in API (GitHub releases recent feature)
        digest = best_asset.get("digest")
        if digest and digest.startswith("sha256:"):
            expected_hash = digest.split("sha256:")[1].strip().lower()
        elif best_asset.get("name", "").lower() in checksum_map:
            expected_hash = checksum_map[best_asset.get("name", "").lower()]
        else:
            # Fallback: scan release notes body for SHA256
            body = release.get("body", "")
            match = re.search(r"sha256\s*[:=]\s*([a-fA-F0-9]{64})", body, re.IGNORECASE)
            if match:
                expected_hash = match.group(1).lower()

    return (best_asset, expected_hash)


def check_for_updates(
    current_version: str = CURRENT_VERSION,
    repo_owner: str = DEFAULT_REPO_OWNER,
    repo_name: str = DEFAULT_REPO_NAME,
    include_beta: bool = False,
    token: Optional[str] = None
) -> Tuple[str, Optional[ReleaseInfo], str]:
    """
    Perform a complete check against GitHub Releases.
    Returns:
        (status_code, ReleaseInfo or None, message)
        status_code in ['update_available', 'up_to_date', 'no_assets', 'error']
    """
    logger.info(f"Checking for updates against {repo_owner}/{repo_name} (Current: v{current_version}, Beta: {include_beta})")

    try:
        releases = fetch_all_releases(repo_owner, repo_name, token)
        if not releases:
            msg = "No releases found on GitHub repository."
            logger.info(msg)
            return ("up_to_date", None, msg)

        # Filter out drafts, and optionally prereleases
        valid_releases = []
        for r in releases:
            if r.get("draft", False):
                continue
            if r.get("prerelease", False) and not include_beta:
                continue
            valid_releases.append(r)

        if not valid_releases:
            msg = "No compatible stable releases found."
            logger.info(msg)
            return ("up_to_date", None, msg)

        # Sort by semantic version descending
        valid_releases.sort(
            key=lambda x: parse_version(x.get("tag_name") or x.get("name") or "0.0.0"),
            reverse=True
        )

        latest_release = valid_releases[0]
        latest_tag = latest_release.get("tag_name", "").strip()
        version_num = latest_tag.lstrip("vV")

        if not is_newer_version(version_num, current_version):
            msg = f"Dynamic Windows is up to date (v{current_version})."
            logger.info(msg)
            return ("up_to_date", None, msg)

        # Find compatible Windows asset
        asset, expected_hash = find_compatible_windows_asset(latest_release)
        if not asset:
            msg = f"New version {latest_tag} found, but no compatible Windows installer asset is attached."
            logger.warning(msg)
            return ("no_assets", None, msg)

        # Parse short summary from release body
        body = latest_release.get("body", "").strip()
        summary_lines = [l.strip() for l in body.splitlines() if l.strip() and not l.strip().startswith("#")]
        summary = summary_lines[0] if summary_lines else "New features, optimizations, and bug fixes."
        if len(summary) > 90:
            summary = summary[:87] + "..."

        rel_info = ReleaseInfo(
            version=version_num,
            raw_tag=latest_tag,
            title=latest_release.get("name") or f"Dynamic Windows {latest_tag}",
            summary=summary,
            notes=body,
            html_url=latest_release.get("html_url", ""),
            published_at=latest_release.get("published_at", "")[:10],
            prerelease=latest_release.get("prerelease", False),
            asset_name=asset.get("name", ""),
            asset_url=asset.get("browser_download_url", ""),
            asset_size=asset.get("size", 0),
            expected_hash=expected_hash
        )

        msg = f"Update available: {latest_tag} (Current: v{current_version})"
        logger.info(f"{msg} - Asset: {rel_info.asset_name} ({rel_info.asset_size} bytes)")
        return ("update_available", rel_info, msg)

    except urllib.error.HTTPError as e:
        err_msg = f"GitHub API error: HTTP {e.code} ({e.reason})"
        logger.error(err_msg)
        return ("error", None, err_msg)
    except urllib.error.URLError as e:
        err_msg = f"Network connection failed: {e.reason}"
        logger.error(err_msg)
        return ("error", None, err_msg)
    except Exception as e:
        err_msg = f"Update check failed: {str(e)[:60]}"
        logger.error(err_msg)
        return ("error", None, err_msg)


# ---------------------------------------------------------
# Background Worker Threads
# ---------------------------------------------------------
class UpdateCheckerThread(QThread):
    """Background worker to check for GitHub updates safely without blocking UI."""
    checking_started = pyqtSignal()
    update_available = pyqtSignal(object)  # emits ReleaseInfo
    up_to_date = pyqtSignal(str)           # emits message
    error_occurred = pyqtSignal(str)       # emits error message

    def __init__(self, current_version=CURRENT_VERSION):
        super().__init__()
        self.current_version = current_version

    def run(self):
        self.checking_started.emit()
        cfg = load_config()
        repo_owner = cfg.get("repo_owner", DEFAULT_REPO_OWNER)
        repo_name = cfg.get("repo_name", DEFAULT_REPO_NAME)
        include_beta = cfg.get("include_beta", False)
        token = cfg.get("github_token", "").strip() or None

        status, rel_info, msg = check_for_updates(
            current_version=self.current_version,
            repo_owner=repo_owner,
            repo_name=repo_name,
            include_beta=include_beta,
            token=token
        )

        # Update last checked status in config
        cfg["last_check_time"] = time.time()
        cfg["last_check_status"] = msg
        save_config(cfg)

        if status == "update_available" and rel_info:
            self.update_available.emit(rel_info)
        elif status == "up_to_date":
            self.up_to_date.emit(msg)
        else:
            self.error_occurred.emit(msg)


class UpdateDownloaderThread(QThread):
    """
    Background worker that downloads the installer package,
    provides live percentage & speed progress, retries on network failures,
    and performs SHA256 and PE header verification.
    """
    download_progress = pyqtSignal(int, int, int, float, str)  # percent, done_bytes, total_bytes, speed_kbps, status
    download_finished = pyqtSignal(str, object)               # file_path, ReleaseInfo
    download_failed = pyqtSignal(str)                         # error message

    def __init__(self, release_info: ReleaseInfo):
        super().__init__()
        self.release_info = release_info
        self._is_cancelled = False

    def cancel(self):
        self._is_cancelled = True

    def run(self):
        url = self.release_info.asset_url
        dest_filename = self.release_info.asset_name
        dest_path = os.path.join(UPDATES_DIR, dest_filename)
        temp_path = dest_path + ".downloading"

        logger.info(f"Starting download: {dest_filename} from {url}")

        # Security check: Ensure URL points to official GitHub Release host
        allowed_hosts = ["github.com", "api.github.com", "objects.githubusercontent.com"]
        if not any(h in url.lower() for h in allowed_hosts):
            err = "Untrusted download URL rejected."
            logger.error(err)
            self.download_failed.emit(err)
            return

        max_retries = 3
        attempt = 0
        success = False

        while attempt < max_retries and not self._is_cancelled:
            attempt += 1
            try:
                req = create_github_request(url)
                start_time = time.time()
                bytes_downloaded = 0
                hasher = hashlib.sha256()

                with urllib.request.urlopen(req, timeout=15) as response:
                    total_bytes = int(response.headers.get("Content-Length", self.release_info.asset_size or 0))

                    with open(temp_path, "wb") as f:
                        chunk_size = 64 * 1024  # 64 KB
                        last_progress_emit = time.time()

                        while True:
                            if self._is_cancelled:
                                logger.info("Download cancelled by user.")
                                f.close()
                                if os.path.exists(temp_path):
                                    os.remove(temp_path)
                                return

                            chunk = response.read(chunk_size)
                            if not chunk:
                                break

                            f.write(chunk)
                            hasher.update(chunk)
                            bytes_downloaded += len(chunk)

                            now = time.time()
                            if now - last_progress_emit >= 0.15 or bytes_downloaded == total_bytes:
                                last_progress_emit = now
                                percent = int((bytes_downloaded / total_bytes) * 100) if total_bytes > 0 else 0
                                elapsed = max(0.01, now - start_time)
                                speed_kbps = (bytes_downloaded / 1024.0) / elapsed
                                status_txt = f"{bytes_downloaded / (1024*1024):.1f} MB / {total_bytes / (1024*1024):.1f} MB"
                                self.download_progress.emit(percent, bytes_downloaded, total_bytes, speed_kbps, status_txt)

                success = True
                break
            except Exception as e:
                logger.warning(f"Download attempt {attempt}/{max_retries} failed: {e}")
                if attempt < max_retries:
                    time.sleep(1.5 * attempt)
                else:
                    if os.path.exists(temp_path):
                        try:
                            os.remove(temp_path)
                        except Exception:
                            pass
                    err_msg = f"Download failed after {max_retries} attempts: {str(e)[:50]}"
                    logger.error(err_msg)
                    self.download_failed.emit(err_msg)
                    return

        if not success or self._is_cancelled:
            return

        # -----------------------------------------------------
        # File Integrity & Authenticity Verification
        # -----------------------------------------------------
        self.download_progress.emit(100, bytes_downloaded, total_bytes, 0.0, "Verifying package integrity...")

        # 1. Size Verification: Installer must be > 500 KB
        if os.path.getsize(temp_path) < 500 * 1024:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            err = "Verification failed: Downloaded file is truncated or corrupted."
            logger.error(err)
            self.download_failed.emit(err)
            return

        # 2. Windows PE Header Verification (Must start with 'MZ')
        try:
            with open(temp_path, "rb") as f:
                header = f.read(2)
                if header != b"MZ":
                    f.close()
                    os.remove(temp_path)
                    err = "Verification failed: Downloaded file is not a valid Windows executable."
                    logger.error(err)
                    self.download_failed.emit(err)
                    return
        except Exception as e:
            err = f"Verification error: {e}"
            logger.error(err)
            self.download_failed.emit(err)
            return

        # 3. Cryptographic SHA256 Verification if hash available
        calculated_hash = hasher.hexdigest().lower()
        if self.release_info.expected_hash:
            if calculated_hash != self.release_info.expected_hash.lower():
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                err = f"Integrity check failed! SHA256 mismatch (Expected: {self.release_info.expected_hash[:12]}..., Got: {calculated_hash[:12]}...)"
                logger.error(err)
                self.download_failed.emit(err)
                return
            else:
                logger.info(f"Verified official SHA256 hash successfully: {calculated_hash}")
        else:
            logger.info(f"Calculated package SHA256: {calculated_hash}")

        # Rename verified file to final destination
        try:
            if os.path.exists(dest_path):
                os.remove(dest_path)
            os.rename(temp_path, dest_path)
        except Exception as e:
            logger.error(f"Error finalizing installer file: {e}")

        logger.info(f"Update package verified and ready: {dest_path}")
        self.download_finished.emit(dest_path, self.release_info)


# ---------------------------------------------------------
# Safe Windows Installation & Process Replacement
# ---------------------------------------------------------
def apply_update_and_restart(installer_path: str, is_silent: bool = True) -> bool:
    """
    Safely execute the installer without file lock errors:
    1. Writes a detached update runner script.
    2. Runner waits for the current process PID to cleanly exit.
    3. Runs the verified Inno Setup installer.
    4. Automatically launches the updated application.
    5. Cleanly terminates the current process.
    """
    if not os.path.exists(installer_path):
        logger.error(f"Installer path not found: {installer_path}")
        return False

    current_pid = os.getpid()
    is_frozen = getattr(sys, "frozen", False)
    target_exe = sys.executable if is_frozen else os.path.join(
        os.environ.get("LOCALAPPDATA", ""), "Programs", "Dynamic Windows", "DynamicWindows.exe"
    )

    batch_script_path = os.path.join(UPDATES_DIR, "apply_update.bat")
    logger.info(f"Preparing update runner batch script for PID {current_pid} -> {installer_path}")

    # Build safe updater batch script
    # Inno Setup flags:
    # /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-
    silent_flags = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-" if is_silent else "/NORESTART"

    script_content = f"""@echo off
chcp 65001 >nul
title Dynamic Windows Updater
echo Updating Dynamic Windows...

:: 1. Wait for current application PID to cleanly exit
set PID={current_pid}
:WAIT_PID
tasklist /fi "PID eq %PID%" 2>nul | find "%PID%" >nul
if %ERRORLEVEL%==0 (
    timeout /t 1 /nobreak >nul
    goto WAIT_PID
)

:: Small safety cushion to release any locked file handles
timeout /t 1 /nobreak >nul

:: 2. Launch verified installer
start /wait "" "{installer_path}" {silent_flags}

:: 3. Launch newly updated application
if exist "{target_exe}" (
    start "" "{target_exe}"
)

:: 4. Done
exit
"""
    try:
        with open(batch_script_path, "w", encoding="utf-8") as f:
            f.write(script_content)

        # Launch runner detached with NO CMD FLASH
        subprocess.Popen(
            ["cmd.exe", "/c", batch_script_path],
            creationflags=CREATE_NO_WINDOW | DETACHED_PROCESS,
            close_fds=True
        )
        logger.info("Detached updater runner launched. Exiting application cleanly.")
        return True
    except Exception as e:
        logger.error(f"Failed to launch update runner: {e}")
        return False

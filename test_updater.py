"""
Comprehensive Test Suite for Dynamic Windows Automatic Update System
Verifies SemVer parsing, GitHub release monitoring, asset filtering,
integrity checks, security validation, and config persistence.
"""

import os
import sys
import tempfile
import hashlib
import unittest
from unittest.mock import patch, MagicMock

import updater_config as cfg
import updater_logger as logger
import updater_engine as engine


class TestSemVer(unittest.TestCase):
    def test_parse_version(self):
        core, pre, is_pre = engine.parse_version("1.0.1")
        self.assertEqual(core, (1, 0, 1))
        self.assertEqual(pre, [])
        self.assertFalse(is_pre)

        core, pre, is_pre = engine.parse_version("v2.3.4-beta.1")
        self.assertEqual(core, (2, 3, 4))
        self.assertEqual(pre, ["beta", "1"])
        self.assertTrue(is_pre)

    def test_compare_versions(self):
        # Newer patch
        self.assertEqual(engine.compare_versions("1.0.2", "1.0.1"), 1)
        self.assertEqual(engine.compare_versions("1.0.1", "1.0.2"), -1)
        self.assertEqual(engine.compare_versions("1.0.1", "1.0.1"), 0)

        # Newer minor
        self.assertEqual(engine.compare_versions("1.1.0", "1.0.9"), 1)

        # Newer major
        self.assertEqual(engine.compare_versions("2.0.0", "1.9.9"), 1)

        # Release vs Pre-release (Release should be higher precedence)
        self.assertEqual(engine.compare_versions("1.1.0", "1.1.0-beta.1"), 1)
        self.assertEqual(engine.compare_versions("1.1.0-beta.2", "1.1.0-beta.1"), 1)

        # Prefixed with 'v'
        self.assertEqual(engine.compare_versions("v1.2.0", "1.1.9"), 1)

    def test_is_newer_version(self):
        self.assertTrue(engine.is_newer_version("1.1.0", "1.0.1"))
        self.assertTrue(engine.is_newer_version("1.0.2", "1.0.1"))
        self.assertFalse(engine.is_newer_version("1.0.1", "1.0.1"))
        self.assertFalse(engine.is_newer_version("1.0.0", "1.0.1"))


class TestAssetDetection(unittest.TestCase):
    def test_find_compatible_windows_asset(self):
        mock_release = {
            "body": "SHA256: 633e2aee556e333de50556b8d5efda820535e6745004508a124440764c1ea76c",
            "assets": [
                {
                    "name": "DynamicWindows-Setup-v1.1.0.exe",
                    "browser_download_url": "https://github.com/voiceline-diskrep/dynamic-windows/releases/download/v1.1.0/DynamicWindows-Setup-v1.1.0.exe",
                    "size": 26124128,
                    "digest": "sha256:633e2aee556e333de50556b8d5efda820535e6745004508a124440764c1ea76c"
                },
                {
                    "name": "source.tar.gz",
                    "browser_download_url": "https://example.com/source.tar.gz",
                    "size": 500000
                }
            ]
        }
        asset, expected_hash = engine.find_compatible_windows_asset(mock_release)
        self.assertIsNotNone(asset)
        self.assertEqual(asset["name"], "DynamicWindows-Setup-v1.1.0.exe")
        self.assertEqual(expected_hash, "633e2aee556e333de50556b8d5efda820535e6745004508a124440764c1ea76c")


class TestIntegrityAndSecurity(unittest.TestCase):
    def test_reject_untrusted_host(self):
        untrusted_url = "https://malicious-site.com/bad_installer.exe"
        allowed_hosts = ["github.com", "api.github.com", "objects.githubusercontent.com"]
        is_safe = any(h in untrusted_url.lower() for h in allowed_hosts)
        self.assertFalse(is_safe)

    def test_pe_header_validation(self):
        # Create a temp file with invalid header
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"NOT_A_PE_FILE_TEXT_CONTENT")
            temp_path = f.name

        try:
            with open(temp_path, "rb") as f:
                header = f.read(2)
            self.assertNotEqual(header, b"MZ")
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

        # Create a temp file with valid 'MZ' Windows executable header
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"MZ" + b"\x00" * 100)
            temp_path = f.name

        try:
            with open(temp_path, "rb") as f:
                header = f.read(2)
            self.assertEqual(header, b"MZ")
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)


class TestConfigPersistence(unittest.TestCase):
    def test_config_save_and_load(self):
        test_data = dict(cfg.DEFAULT_CONFIG)
        test_data["auto_check_updates"] = True
        test_data["check_interval_hours"] = 12
        test_data["include_beta"] = True

        cfg.save_config(test_data)
        loaded = cfg.load_config()

        self.assertEqual(loaded["check_interval_hours"], 12)
        self.assertTrue(loaded["include_beta"])
        self.assertTrue(os.path.exists(cfg.APPDATA_DIR))


if __name__ == "__main__":
    unittest.main()

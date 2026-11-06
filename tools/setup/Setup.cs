using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Dynamic Windows Setup")]
[assembly: AssemblyProduct("Dynamic Windows")]
[assembly: AssemblyCompany("voiceline-diskrep")]
[assembly: AssemblyVersion("1.4.8.0")]
[assembly: AssemblyFileVersion("1.4.8.0")]

static class Setup {
    public const string VERSION = "1.4.8";
    public static string Home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DynamicWindows");
    public static bool NoStart, Quiet;

    [STAThread]
    static int Main(string[] args) {
        for (int i = 0; i < args.Length; i++) {
            if (args[i] == "--dir" && i + 1 < args.Length) Home = Path.GetFullPath(args[++i]);
            else if (args[i] == "--no-start") NoStart = true;
            else if (args[i] == "--quiet") Quiet = true;
        }

        if (Quiet) {
            try {
                Installer.Run(Home, null);
                if (!NoStart) Installer.Start(Home);
                return 0;
            } catch (Exception e) {
                try {
                    string logFile = Path.Combine(Path.GetTempPath(), "DynamicWindows_setup_error.log");
                    File.WriteAllText(logFile, e.ToString());
                } catch { }
                Console.Error.WriteLine(e.Message);
                return 1;
            }
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var form = new SetupForm();
        Application.Run(form);
        return 0;
    }
}

class SetupForm : Form {
    Label titleLabel, statusLabel;
    ProgressBar progressBar;
    Button installButton;

    public SetupForm() {
        this.Text = "Dynamic Windows Setup (v" + Setup.VERSION + ")";
        this.Size = new Size(480, 240);
        this.StartPosition = FormStartPosition.CenterScreen;
        this.FormBorderStyle = FormBorderStyle.FixedDialog;
        this.MaximizeBox = false;
        this.BackColor = Color.FromArgb(18, 18, 22);
        this.ForeColor = Color.FromArgb(244, 244, 245);
        this.Font = new Font("Segoe UI", 9.5f);

        titleLabel = new Label() {
            Text = "Dynamic Windows",
            Font = new Font("Segoe UI Variable Display", 15f, FontStyle.Bold),
            ForeColor = Color.White,
            Location = new Point(24, 20),
            AutoSize = true
        };
        this.Controls.Add(titleLabel);

        statusLabel = new Label() {
            Text = "Installs Dynamic Windows (v" + Setup.VERSION + ") with Google Antigravity integration to:\n" + Setup.Home,
            Location = new Point(26, 58),
            Size = new Size(420, 44),
            ForeColor = Color.FromArgb(161, 161, 170)
        };
        this.Controls.Add(statusLabel);

        progressBar = new ProgressBar() {
            Location = new Point(26, 112),
            Size = new Size(412, 18),
            Style = ProgressBarStyle.Continuous,
            Visible = false
        };
        this.Controls.Add(progressBar);

        installButton = new Button() {
            Text = "Install & Launch",
            UseMnemonic = false,
            Location = new Point(306, 148),
            Size = new Size(132, 34),
            BackColor = Color.FromArgb(37, 99, 235),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat
        };
        installButton.FlatAppearance.BorderSize = 0;
        installButton.Click += (s, e) => DoInstall();
        this.Controls.Add(installButton);
    }

    void DoInstall() {
        installButton.Enabled = false;
        progressBar.Visible = true;
        progressBar.Value = 5;
        statusLabel.Text = "Installing Dynamic Windows...";

        new Thread(() => {
            try {
                Installer.Run(Setup.Home, (pct) => {
                    this.Invoke((Action)(() => {
                        progressBar.Value = Math.Min(100, Math.Max(0, pct));
                    }));
                });

                this.Invoke((Action)(() => {
                    progressBar.Value = 100;
                    statusLabel.Text = "Installation complete! Launching Dynamic Windows...";
                }));

                Thread.Sleep(600);
                if (!Setup.NoStart) Installer.Start(Setup.Home);
                Thread.Sleep(800);
                this.Invoke((Action)(() => Application.Exit()));
            } catch (Exception ex) {
                this.Invoke((Action)(() => {
                    MessageBox.Show("Installation error: " + ex.ToString(), "Setup Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    installButton.Enabled = true;
                    statusLabel.Text = "Installation failed.";
                }));
            }
        }).Start();
    }
}

static class Installer {
    public static void Run(string targetDir, Action<int> progressCallback) {
        if (!Directory.Exists(targetDir)) {
            Directory.CreateDirectory(targetDir);
        }

        // Close any running instance of DynamicWindows and electron
        try {
            foreach (var p in Process.GetProcessesByName("DynamicWindows")) {
                try {
                    p.Kill();
                    p.WaitForExit(5000);
                } catch { }
            }
            foreach (var p in Process.GetProcessesByName("electron")) {
                try {
                    p.Kill();
                    p.WaitForExit(5000);
                } catch { }
            }
        } catch { }

        // Clean up any legacy root package.json or src/ next to executable
        try {
            string rootPkg = Path.Combine(targetDir, "package.json");
            if (File.Exists(rootPkg)) File.Delete(rootPkg);
            string rootSrc = Path.Combine(targetDir, "src");
            if (Directory.Exists(rootSrc)) Directory.Delete(rootSrc, true);
        } catch { }

        Stream zipStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("DynamicWindows.zip");
        if (zipStream == null) {
            // Fallback: search for embedded zip marker PK\x03\x04
            string selfPath = Assembly.GetExecutingAssembly().Location;
            byte[] buffer = File.ReadAllBytes(selfPath);
            int zipStart = -1;
            for (int i = 0; i < buffer.Length - 4; i++) {
                if (buffer[i] == 'P' && buffer[i+1] == 'K' && buffer[i+2] == 3 && buffer[i+3] == 4) {
                    zipStart = i;
                    break;
                }
            }
            if (zipStart >= 0) {
                zipStream = new MemoryStream(buffer, zipStart, buffer.Length - zipStart);
            }
        }

        if (zipStream == null) {
            throw new Exception("Application payload (DynamicWindows.zip) was not found in setup package.");
        }

        using (zipStream)
        using (var archive = new ZipArchive(zipStream, ZipArchiveMode.Read)) {
            int total = archive.Entries.Count;
            int count = 0;

            foreach (var entry in archive.Entries) {
                count++;
                string rawName = entry.FullName.Replace('\\', '/');
                // Strip top folder if present (e.g. "DynamicWindows/")
                if (rawName.StartsWith("DynamicWindows/")) {
                    rawName = rawName.Substring(15);
                }
                if (string.IsNullOrEmpty(rawName)) continue;

                string destPath = Path.Combine(targetDir, rawName.Replace('/', Path.DirectorySeparatorChar));
                if (rawName.EndsWith("/")) {
                    if (!Directory.Exists(destPath)) Directory.CreateDirectory(destPath);
                    continue;
                }

                string dir = Path.GetDirectoryName(destPath);
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);

                bool extracted = false;
                for (int attempt = 0; attempt < 8; attempt++) {
                    try {
                        if (File.Exists(destPath)) {
                            try { File.SetAttributes(destPath, FileAttributes.Normal); } catch { }
                            try { File.Delete(destPath); } catch { }
                        }
                        entry.ExtractToFile(destPath, true);
                        extracted = true;
                        break;
                    } catch {
                        Thread.Sleep(250);
                    }
                }
                if (!extracted) {
                    throw new IOException("Failed to extract file: " + destPath);
                }

                if (progressCallback != null && (count % 5 == 0 || count == total)) {
                    progressCallback((int)((count / (float)total) * 95));
                }
            }
        }

        string targetExe = Path.Combine(targetDir, "DynamicWindows.exe");
        if (!File.Exists(targetExe)) {
            throw new Exception("Executable DynamicWindows.exe was not created in " + targetDir);
        }

        CreateShortcut(targetExe);
    }

    public static void Start(string targetDir) {
        string exe = Path.Combine(targetDir, "DynamicWindows.exe");
        if (File.Exists(exe)) {
            Process.Start(new ProcessStartInfo(exe) { 
                UseShellExecute = true,
                WorkingDirectory = targetDir
            });
        } else {
            throw new Exception("Cannot find executable to start: " + exe);
        }
    }

    public static void CreateShortcut(string targetExe) {
        try {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs");

            Type t = Type.GetTypeFromProgID("WScript.Shell");
            if (t == null) return;
            dynamic shell = Activator.CreateInstance(t);

            foreach (var folder in new[] { desktop, startMenu }) {
                if (!Directory.Exists(folder)) continue;
                string linkPath = Path.Combine(folder, "Dynamic Windows.lnk");
                var shortcut = shell.CreateShortcut(linkPath);
                shortcut.TargetPath = targetExe;
                shortcut.WorkingDirectory = Path.GetDirectoryName(targetExe);
                shortcut.Description = "Dynamic Windows + One-Shot";
                shortcut.Save();
            }
        } catch { }
    }
}

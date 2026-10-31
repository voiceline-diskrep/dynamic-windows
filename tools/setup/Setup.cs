using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Dynamic Windows Setup")]
[assembly: AssemblyProduct("Dynamic Windows")]
[assembly: AssemblyCompany("voiceline-diskrep")]
[assembly: AssemblyVersion("1.0.5.0")]
[assembly: AssemblyFileVersion("1.0.5.0")]

static class Setup {
    public const string VERSION = "1.0.5";
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
        this.Text = "Dynamic Windows + One-Shot Setup (v1.0.5)";
        this.Size = new Size(460, 240);
        this.StartPosition = FormStartPosition.CenterScreen;
        this.FormBorderStyle = FormBorderStyle.FixedDialog;
        this.MaximizeBox = false;
        this.BackColor = Color.FromArgb(18, 18, 22);
        this.ForeColor = Color.FromArgb(244, 244, 245);
        this.Font = new Font("Segoe UI", 9.5f);

        titleLabel = new Label() {
            Text = "Dynamic Windows + One-Shot",
            Font = new Font("Segoe UI Variable Display", 14f, FontStyle.Bold),
            ForeColor = Color.White,
            Location = new Point(24, 20),
            AutoSize = true
        };
        this.Controls.Add(titleLabel);

        statusLabel = new Label() {
            Text = "Ready to install Dynamic Windows with Google Antigravity integration.",
            Location = new Point(26, 62),
            Size = new Size(400, 40),
            ForeColor = Color.FromArgb(161, 161, 170)
        };
        this.Controls.Add(statusLabel);

        progressBar = new ProgressBar() {
            Location = new Point(26, 110),
            Size = new Size(390, 18),
            Style = ProgressBarStyle.Continuous,
            Visible = false
        };
        this.Controls.Add(progressBar);

        installButton = new Button() {
            Text = "Install & Launch",
            Location = new Point(296, 146),
            Size = new Size(120, 34),
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
        progressBar.Value = 20;
        statusLabel.Text = "Installing to " + Setup.Home + "...";

        new Thread(() => {
            try {
                Installer.Run(Setup.Home, (pct) => {
                    this.Invoke((Action)(() => {
                        progressBar.Value = Math.Min(100, Math.Max(0, pct));
                    }));
                });

                this.Invoke((Action)(() => {
                    progressBar.Value = 100;
                    statusLabel.Text = "Installation complete! Launching...";
                }));

                Thread.Sleep(600);
                if (!Setup.NoStart) Installer.Start(Setup.Home);
                this.Invoke((Action)(() => Application.Exit()));
            } catch (Exception ex) {
                this.Invoke((Action)(() => {
                    MessageBox.Show("Installation error: " + ex.Message, "Setup Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    installButton.Enabled = true;
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

        string selfPath = Assembly.GetExecutingAssembly().Location;
        byte[] buffer = File.ReadAllBytes(selfPath);

        // Find embedded zip marker (PK\x03\x04)
        int zipStart = -1;
        for (int i = 0; i < buffer.Length - 4; i++) {
            if (buffer[i] == 'P' && buffer[i+1] == 'K' && buffer[i+2] == 3 && buffer[i+3] == 4) {
                zipStart = i;
                break;
            }
        }

        if (zipStart < 0) {
            throw new Exception("Embedded application payload was not found in setup package.");
        }

        using (var ms = new MemoryStream(buffer, zipStart, buffer.Length - zipStart))
        using (var archive = new ZipArchive(ms, ZipArchiveMode.Read)) {
            int total = archive.Entries.Count;
            int count = 0;

            foreach (var entry in archive.Entries) {
                count++;
                string destPath = Path.Combine(targetDir, entry.FullName);
                if (string.IsNullOrEmpty(entry.Name)) {
                    Directory.CreateDirectory(destPath);
                    continue;
                }

                string dir = Path.GetDirectoryName(destPath);
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);

                entry.ExtractToFile(destPath, true);
                if (progressCallback != null) {
                    progressCallback((int)((count / (float)total) * 90) + 10);
                }
            }
        }

        CreateShortcut(Path.Combine(targetDir, "DynamicWindows.exe"));
    }

    public static void Start(string targetDir) {
        string exe = Path.Combine(targetDir, "DynamicWindows.exe");
        if (File.Exists(exe)) {
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true });
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

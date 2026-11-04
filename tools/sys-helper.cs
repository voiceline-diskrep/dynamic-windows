using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace DynamicWindowsTools {
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioEndpointVolume {
        int RegisterControlChangeNotify(IntPtr pNotify);
        int UnregisterControlChangeNotify(IntPtr pNotify);
        int GetChannelCount(out int pnChannelCount);
        int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
        int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
        int GetMasterVolumeLevel(out float pfLevelDB);
        int GetMasterVolumeLevelScalar(out float pfLevel);
        int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
        int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
        int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
        int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    }

    [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioMeterInformation {
        int GetPeakValue(out float pfPeak);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object aev);
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, int role, out IntPtr ppDevices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject { }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public class Program {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref RECT pvParam, uint fWinIni);

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder strText, int maxCount);

        [DllImport("user32.dll")]
        public static extern int GetWindowTextLength(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        public const uint SPI_GETWORKAREA = 0x0030;
        public const uint SPI_SETWORKAREA = 0x002F;
        public const uint SPIF_SENDCHANGE = 0x0002;

        static IMMDevice GetDevice(int dataFlow, int role) {
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice dev;
            enumerator.GetDefaultAudioEndpoint(dataFlow, role, out dev);
            return dev;
        }

        static IAudioEndpointVolume GetEndpoint(int dataFlow = 0, int role = 1) {
            var dev = GetDevice(dataFlow, role);
            var iid = typeof(IAudioEndpointVolume).GUID;
            object epvObj;
            dev.Activate(ref iid, 23, IntPtr.Zero, out epvObj);
            return (IAudioEndpointVolume)epvObj;
        }

        static float GetPeak(int dataFlow, int role) {
            try {
                var dev = GetDevice(dataFlow, role);
                var iid = typeof(IAudioMeterInformation).GUID;
                object meterObj;
                dev.Activate(ref iid, 23, IntPtr.Zero, out meterObj);
                var meter = (IAudioMeterInformation)meterObj;
                float peak = 0f;
                meter.GetPeakValue(out peak);
                return peak;
            } catch {
                return 0f;
            }
        }

        static string EscapeJson(string s) {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ").Trim();
        }

        static List<string> GetActiveMicApps() {
            var list = new List<string>();
            try {
                using (var baseKey = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone")) {
                    if (baseKey == null) return list;
                    foreach (var subName in baseKey.GetSubKeyNames()) {
                        if (subName == "NonPackaged") {
                            using (var npKey = baseKey.OpenSubKey("NonPackaged")) {
                                if (npKey != null) {
                                    foreach (var appKeyName in npKey.GetSubKeyNames()) {
                                        using (var appKey = npKey.OpenSubKey(appKeyName)) {
                                            if (appKey != null) {
                                                object startObj = appKey.GetValue("LastUsedTimeStart");
                                                object stopObj = appKey.GetValue("LastUsedTimeStop");
                                                long start = startObj != null ? Convert.ToInt64(startObj) : 0;
                                                long stop = stopObj != null ? Convert.ToInt64(stopObj) : 1;
                                                if (start > 0 && stop == 0) {
                                                    list.Add(appKeyName);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            using (var pkgKey = baseKey.OpenSubKey(subName)) {
                                if (pkgKey != null) {
                                    object startObj = pkgKey.GetValue("LastUsedTimeStart");
                                    object stopObj = pkgKey.GetValue("LastUsedTimeStop");
                                    long start = startObj != null ? Convert.ToInt64(startObj) : 0;
                                    long stop = stopObj != null ? Convert.ToInt64(stopObj) : 1;
                                    if (start > 0 && stop == 0) {
                                        list.Add(subName);
                                    }
                                }
                            }
                        }
                    }
                }
            } catch { }
            return list;
        }

        static Dictionary<string, string> GetAppWindowTitles() {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var pidToName = new Dictionary<uint, string>();
            string[] targets = new string[] { "Discord", "DiscordPTB", "DiscordCanary", "WhatsApp", "Zoom", "Teams", "ms-teams", "Telegram" };
            foreach (var t in targets) {
                try {
                    foreach (var p in Process.GetProcessesByName(t)) {
                        pidToName[(uint)p.Id] = t;
                    }
                } catch { }
            }
            if (pidToName.Count == 0) return result;

            EnumWindows((hWnd, lParam) => {
                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);
                string procName;
                if (pidToName.TryGetValue(pid, out procName)) {
                    int len = GetWindowTextLength(hWnd);
                    if (len > 0) {
                        var sb = new StringBuilder(len + 1);
                        GetWindowText(hWnd, sb, sb.Capacity);
                        string title = sb.ToString().Trim();
                        if (!string.IsNullOrEmpty(title) &&
                            title != "Default IME" &&
                            title != "MSCTFIME UI" &&
                            !title.StartsWith("GDI+ Window") &&
                            !title.StartsWith("Chrome Legacy Window")) {
                            if (!result.ContainsKey(procName) || title.Contains("Discord") || title.Length > result[procName].Length) {
                                result[procName] = title;
                            }
                        }
                    }
                }
                return true;
            }, IntPtr.Zero);

            return result;
        }

        public static void Main(string[] args) {
            if (args.Length == 0) {
                Console.WriteLine("Usage: sys-helper <get-volume|set-volume|toggle-mute|get-call-audio|toggle-mic-mute|set-mic-mute|focus-process|get-workarea|set-workarea-top|restore-workarea>");
                return;
            }

            string cmd = args[0].ToLowerInvariant();
            try {
                if (cmd == "get-volume") {
                    var epv = GetEndpoint(0, 1);
                    float vol = 0;
                    epv.GetMasterVolumeLevelScalar(out vol);
                    bool mute = false;
                    epv.GetMute(out mute);
                    Console.WriteLine(string.Format(System.Globalization.CultureInfo.InvariantCulture, "{{\"volume\":{0:F3},\"muted\":{1}}}", vol, mute ? "true" : "false"));
                }
                else if (cmd == "set-volume" && args.Length > 1) {
                    float target;
                    if (float.TryParse(args[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out target)) {
                        target = Math.Max(0.0f, Math.Min(1.0f, target));
                        var epv = GetEndpoint(0, 1);
                        Guid g = Guid.Empty;
                        epv.SetMasterVolumeLevelScalar(target, ref g);
                        if (target > 0) {
                            epv.SetMute(false, ref g);
                        }
                        float vol = 0;
                        epv.GetMasterVolumeLevelScalar(out vol);
                        bool mute = false;
                        epv.GetMute(out mute);
                        Console.WriteLine(string.Format(System.Globalization.CultureInfo.InvariantCulture, "{{\"volume\":{0:F3},\"muted\":{1}}}", vol, mute ? "true" : "false"));
                    }
                }
                else if (cmd == "toggle-mute") {
                    var epv = GetEndpoint(0, 1);
                    bool mute = false;
                    epv.GetMute(out mute);
                    Guid g = Guid.Empty;
                    epv.SetMute(!mute, ref g);
                    float vol = 0;
                    epv.GetMasterVolumeLevelScalar(out vol);
                    Console.WriteLine(string.Format(System.Globalization.CultureInfo.InvariantCulture, "{{\"volume\":{0:F3},\"muted\":{1}}}", vol, (!mute) ? "true" : "false"));
                }
                else if (cmd == "get-call-audio") {
                    bool outMute = false;
                    float outVol = 0f;
                    try {
                        var outEpv = GetEndpoint(0, 1);
                        outEpv.GetMute(out outMute);
                        outEpv.GetMasterVolumeLevelScalar(out outVol);
                    } catch { }

                    bool micMute = false;
                    float micVol = 1f;
                    try {
                        var micEpv = GetEndpoint(1, 2);
                        micEpv.GetMute(out micMute);
                        micEpv.GetMasterVolumeLevelScalar(out micVol);
                    } catch {
                        try {
                            var micEpv2 = GetEndpoint(1, 1);
                            micEpv2.GetMute(out micMute);
                            micEpv2.GetMasterVolumeLevelScalar(out micVol);
                        } catch { }
                    }

                    float micPeak = Math.Max(GetPeak(1, 2), GetPeak(1, 1));
                    float outPeak = Math.Max(GetPeak(0, 2), GetPeak(0, 1));

                    var micApps = GetActiveMicApps();
                    var titles = GetAppWindowTitles();

                    var appsJson = new List<string>();
                    foreach (var a in micApps) {
                        appsJson.Add("\"" + EscapeJson(a) + "\"");
                    }

                    var titlesJson = new List<string>();
                    foreach (var kv in titles) {
                        titlesJson.Add("\"" + EscapeJson(kv.Key) + "\":\"" + EscapeJson(kv.Value) + "\"");
                    }

                    Console.WriteLine(string.Format(
                        System.Globalization.CultureInfo.InvariantCulture,
                        "{{\"micMuted\":{0},\"micVolume\":{1:F3},\"micPeak\":{2:F4},\"outMuted\":{3},\"outVolume\":{4:F3},\"outPeak\":{5:F4},\"activeMicApps\":[{6}],\"windowTitles\":{{{7}}}}}",
                        micMute ? "true" : "false",
                        micVol,
                        micPeak,
                        outMute ? "true" : "false",
                        outVol,
                        outPeak,
                        string.Join(",", appsJson.ToArray()),
                        string.Join(",", titlesJson.ToArray())
                    ));
                }
                else if (cmd == "toggle-mic-mute") {
                    bool micMute = false;
                    Guid g = Guid.Empty;
                    try {
                        var micEpv = GetEndpoint(1, 2);
                        micEpv.GetMute(out micMute);
                        micEpv.SetMute(!micMute, ref g);
                    } catch {
                        var micEpv2 = GetEndpoint(1, 1);
                        micEpv2.GetMute(out micMute);
                        micEpv2.SetMute(!micMute, ref g);
                    }
                    try {
                        var micEpvOther = GetEndpoint(1, 1);
                        micEpvOther.SetMute(!micMute, ref g);
                    } catch { }
                    Console.WriteLine(string.Format("{{\"micMuted\":{0}}}", (!micMute) ? "true" : "false"));
                }
                else if (cmd == "set-mic-mute" && args.Length > 1) {
                    bool targetMute = args[1] == "1" || args[1].Equals("true", StringComparison.OrdinalIgnoreCase);
                    Guid g = Guid.Empty;
                    try {
                        var micEpv = GetEndpoint(1, 2);
                        micEpv.SetMute(targetMute, ref g);
                    } catch { }
                    try {
                        var micEpv2 = GetEndpoint(1, 1);
                        micEpv2.SetMute(targetMute, ref g);
                    } catch { }
                    Console.WriteLine(string.Format("{{\"micMuted\":{0}}}", targetMute ? "true" : "false"));
                }
                else if (cmd == "focus-process" && args.Length > 1) {
                    string procTarget = args[1];
                    bool focused = false;
                    var pids = new HashSet<uint>();
                    foreach (var p in Process.GetProcessesByName(procTarget)) {
                        pids.Add((uint)p.Id);
                    }
                    EnumWindows((hWnd, lParam) => {
                        if (!IsWindowVisible(hWnd)) return true;
                        uint pid = 0;
                        GetWindowThreadProcessId(hWnd, out pid);
                        if (pids.Contains(pid) && GetWindowTextLength(hWnd) > 0) {
                            ShowWindow(hWnd, 9); // SW_RESTORE
                            SetForegroundWindow(hWnd);
                            focused = true;
                            return false;
                        }
                        return true;
                    }, IntPtr.Zero);
                    Console.WriteLine(string.Format("{{\"focused\":{0}}}", focused ? "true" : "false"));
                }
                else if (cmd == "get-workarea") {
                    RECT r = new RECT();
                    SystemParametersInfo(SPI_GETWORKAREA, 0, ref r, 0);
                    Console.WriteLine(string.Format("{{\"left\":{0},\"top\":{1},\"right\":{2},\"bottom\":{3}}}", r.Left, r.Top, r.Right, r.Bottom));
                }
                else if (cmd == "set-workarea-top" && args.Length > 1) {
                    int top;
                    if (int.TryParse(args[1], out top)) {
                        RECT r = new RECT();
                        SystemParametersInfo(SPI_GETWORKAREA, 0, ref r, 0);
                        r.Top = top;
                        bool ok = SystemParametersInfo(SPI_SETWORKAREA, 0, ref r, SPIF_SENDCHANGE);
                        Console.WriteLine(string.Format("{{\"ok\":{0},\"top\":{1}}}", ok ? "true" : "false", r.Top));
                    }
                }
                else if (cmd == "restore-workarea") {
                    RECT r = new RECT();
                    SystemParametersInfo(SPI_GETWORKAREA, 0, ref r, 0);
                    r.Top = 0;
                    bool ok = SystemParametersInfo(SPI_SETWORKAREA, 0, ref r, SPIF_SENDCHANGE);
                    EnumWindows((hWnd, lParam) => {
                        if (!IsWindowVisible(hWnd) || !IsZoomed(hWnd)) return true;
                        RECT wr;
                        if (GetWindowRect(hWnd, out wr) && wr.Top > 0 && wr.Top <= 64) {
                            ShowWindow(hWnd, 9); // SW_RESTORE
                            ShowWindow(hWnd, 3); // SW_MAXIMIZE
                        }
                        return true;
                    }, IntPtr.Zero);
                    Console.WriteLine(string.Format("{{\"ok\":{0},\"top\":0}}", ok ? "true" : "false"));
                }
            } catch (Exception ex) {
                Console.WriteLine("{{\"error\":\"" + ex.Message.Replace("\"", "\\\"") + "\"}}");
            }
        }
    }
}

using System;
using System.Runtime.InteropServices;

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

        public const uint SPI_GETWORKAREA = 0x0030;
        public const uint SPI_SETWORKAREA = 0x002F;
        public const uint SPIF_SENDCHANGE = 0x0002;

        static IAudioEndpointVolume GetEndpoint() {
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice dev;
            enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
            var IID_IAudioEndpointVolume = typeof(IAudioEndpointVolume).GUID;
            object epvObj;
            dev.Activate(ref IID_IAudioEndpointVolume, 23, IntPtr.Zero, out epvObj);
            return (IAudioEndpointVolume)epvObj;
        }

        public static void Main(string[] args) {
            if (args.Length == 0) {
                Console.WriteLine("Usage: sys-helper <get-volume|set-volume <0.0-1.0>|get-mute|toggle-mute|get-workarea|set-workarea-top <px>|restore-workarea>");
                return;
            }

            string cmd = args[0].ToLowerInvariant();
            try {
                if (cmd == "get-volume") {
                    var epv = GetEndpoint();
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
                        var epv = GetEndpoint();
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
                    var epv = GetEndpoint();
                    bool mute = false;
                    epv.GetMute(out mute);
                    Guid g = Guid.Empty;
                    epv.SetMute(!mute, ref g);
                    float vol = 0;
                    epv.GetMasterVolumeLevelScalar(out vol);
                    Console.WriteLine(string.Format(System.Globalization.CultureInfo.InvariantCulture, "{{\"volume\":{0:F3},\"muted\":{1}}}", vol, (!mute) ? "true" : "false"));
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
                    Console.WriteLine(string.Format("{{\"ok\":{0},\"top\":0}}", ok ? "true" : "false"));
                }
            } catch (Exception ex) {
                Console.WriteLine("{{\"error\":\"" + ex.Message.Replace("\"", "\\\"") + "\"}}");
            }
        }
    }
}

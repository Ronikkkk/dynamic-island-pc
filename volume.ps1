param([string]$Mode = 'get', [int]$Level = -1)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-4F03-9490-F8C5CE2F9E0D")] class MMDeviceEnumeratorComObject { }
public class DIVol {
  static IAudioEndpointVolume Vol() {
    var en = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null; en.GetDefaultAudioEndpoint(0, 1, out dev);
    Guid iid = typeof(IAudioEndpointVolume).GUID; IAudioEndpointVolume v = null;
    dev.Activate(ref iid, 23, 0, out v); return v;
  }
  public static int Get() { float f; Vol().GetMasterVolumeLevelScalar(out f); return (int)Math.Round(f * 100); }
  public static void Set(int p) { var v = Vol(); v.SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, p)) / 100f, Guid.Empty); if (p > 0) v.SetMute(false, Guid.Empty); }
}
'@
try {
  if ($Mode -eq 'set' -and $Level -ge 0) { [DIVol]::Set($Level) }
  [Console]::Out.WriteLine([DIVol]::Get())
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); [Console]::Out.WriteLine(-1) }

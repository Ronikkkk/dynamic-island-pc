param([string]$Parse, [string]$Out)

# Saves the icon Windows shows for a shell item (for example a Store app) as PNG.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class ShellIcon {
  [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx; public int cy; }
  [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFOHEADER {
    public int biSize; public int biWidth; public int biHeight; public short biPlanes; public short biBitCount;
    public int biCompression; public int biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
    public int biClrUsed; public int biClrImportant;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BITMAP {
    public int bmType; public int bmWidth; public int bmHeight; public int bmWidthBytes;
    public short bmPlanes; public short bmBitsPixel; public IntPtr bmBits;
  }
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItemImageFactory ppv);
  [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int cb, ref BITMAP bm);
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint lines, byte[] bits, ref BITMAPINFOHEADER bmi, uint usage);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);

  public static string Save(string parse, string outPath, int px) {
    Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    IShellItemImageFactory f;
    SHCreateItemFromParsingName(parse, IntPtr.Zero, ref iid, out f);
    SIZE sz; sz.cx = px; sz.cy = px;
    IntPtr hbm;
    int hr = f.GetImage(sz, 4, out hbm);
    if (hr != 0 || hbm == IntPtr.Zero) return "GetImage hr=" + hr;
    BITMAP bm = new BITMAP();
    GetObject(hbm, Marshal.SizeOf(typeof(BITMAP)), ref bm);
    int w = bm.bmWidth, h = bm.bmHeight;
    BITMAPINFOHEADER bi = new BITMAPINFOHEADER();
    bi.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
    bi.biWidth = w; bi.biHeight = -h; bi.biPlanes = 1; bi.biBitCount = 32; bi.biCompression = 0;
    byte[] buf = new byte[w * h * 4];
    IntPtr dc = GetDC(IntPtr.Zero);
    int lines = GetDIBits(dc, hbm, 0, (uint)h, buf, ref bi, 0);
    ReleaseDC(IntPtr.Zero, dc);
    DeleteObject(hbm);
    if (lines == 0) return "GetDIBits failed";
    for (int i = 0; i < buf.Length; i += 4) {
      int a = buf[i + 3];
      if (a > 0 && a < 255) {
        buf[i] = (byte)Math.Min(255, buf[i] * 255 / a);
        buf[i + 1] = (byte)Math.Min(255, buf[i + 1] * 255 / a);
        buf[i + 2] = (byte)Math.Min(255, buf[i + 2] * 255 / a);
      }
    }
    using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
      Marshal.Copy(buf, 0, bd.Scan0, buf.Length);
      bmp.UnlockBits(bd);
      bmp.Save(outPath, ImageFormat.Png);
    }
    return "ok";
  }
}
"@

try {
  $r = [ShellIcon]::Save($Parse, $Out, 64)
  [Console]::WriteLine($r)
} catch {
  [Console]::WriteLine('ERROR: ' + $_.Exception.Message)
}

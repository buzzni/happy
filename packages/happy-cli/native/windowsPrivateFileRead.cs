// Legacy custody proof is separate from DPAPI: encryption cannot authenticate a planted plaintext key.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

internal static class WindowsPrivateFileRead {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo information);
    [StructLayout(LayoutKind.Sequential)]
    struct FileInfo {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    internal static void Check(SafeFileHandle handle, bool directory) { Info(handle, directory); }
    static FileInfo Info(SafeFileHandle handle, bool directory) {
        FileInfo info;
        if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x400) != 0 ||
            (((info.Attributes & 0x10) != 0) != directory) || (!directory && (info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > 8 * 1024 * 1024))) throw new InvalidDataException();
        return info;
    }
    internal static SafeFileHandle Open(string path, bool directory) {
        // No delete sharing on any ancestor; no write or delete sharing on the file.
        var handle = CreateFileW(@"\\?\" + path, directory ? 0x80u : 0x80020080u,
            directory ? 3u : 1u, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
        try { Info(handle, directory); return handle; } catch { handle.Dispose(); throw; }
    }
    static byte[] PrivateDescriptor(SafeFileHandle handle) {
        IntPtr owner, group, dacl, sacl, descriptor;
        var error = GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try {
            var bytes = new byte[GetSecurityDescriptorLength(descriptor)];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            var acl = new RawSecurityDescriptor(bytes, 0);
            var sid = WindowsIdentity.GetCurrent().User.Value;
            if (acl.Owner == null || acl.Owner.Value != sid || acl.DiscretionaryAcl == null) throw new InvalidDataException();
            foreach (GenericAce raw in acl.DiscretionaryAcl) {
                var ace = raw as CommonAce;
                if (ace == null) throw new InvalidDataException();
                if (ace.AceQualifier == AceQualifier.AccessDenied) continue;
                // Built-in Administrators and SYSTEM are OS trust principals; custom IT groups are not inferred trusted.
                if (ace.AceQualifier != AceQualifier.AccessAllowed || (ace.SecurityIdentifier.Value != sid && ace.SecurityIdentifier.Value != "S-1-5-18" && ace.SecurityIdentifier.Value != "S-1-5-32-544")) throw new InvalidDataException();
            }
            return bytes;
        } finally { LocalFree(descriptor); }
    }
    internal static string ValidatePath(string path) {
        if (String.IsNullOrEmpty(path) || path.Length > 30000 || path.Length < 4 ||
            path[1] != ':' || path[2] != '\\' || path.IndexOf(':', 2) >= 0 || path.IndexOf('/') >= 0 || path.IndexOf('\0') >= 0) throw new InvalidDataException();
        foreach (var part in path.Substring(3).Split('\\')) {
            if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ")) throw new InvalidDataException();
        }
        // .NET expands existing 8.3 components (TEMP commonly contains WINDOW~1).
        // Use that same spelling for parent handles, file I/O and publication verification.
        return Path.GetFullPath(path);
    }
    internal static List<SafeFileHandle> HoldParents(string path) {
        path = ValidatePath(path);
        var held = new List<SafeFileHandle>();
        try {
            var parent = Path.GetDirectoryName(path);
            var directories = new List<string>();
            while (parent != null) { directories.Add(parent); parent = Path.GetDirectoryName(parent); }
            directories.Reverse();
            foreach (var directory in directories) held.Add(Open(directory, true));
            return held;
        } catch { for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose(); throw; }
    }
    internal static byte[] Read(string path, Func<byte[], bool> authenticated = null) {
        path = ValidatePath(path);
        var held = HoldParents(path);
        byte[] bytes = null;
        try {
            using (var file = Open(path, false)) {
                var before = Info(file, false);
                using (var stream = new FileStream(file, FileAccess.Read)) {
                    bytes = new byte[(int)before.SizeLow];
                    int offset = 0;
                    while (offset < bytes.Length) {
                        int count = stream.Read(bytes, offset, bytes.Length - offset);
                        if (count == 0) throw new InvalidDataException();
                        offset += count;
                    }
                    var after = Info(file, false);
                    if (before.SizeLow != after.SizeLow || stream.ReadByte() != -1) throw new InvalidDataException();
                    // The already-open handle and share mode stabilize content. Ciphertext
                    // proves custody cryptographically; plaintext additionally needs a private DACL.
                    if (authenticated == null || !authenticated(bytes)) PrivateDescriptor(file);
                }
            }
            return bytes;
        } catch {
            if (bytes != null) Array.Clear(bytes, 0, bytes.Length);
            throw;
        } finally { for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose(); }
    }
}

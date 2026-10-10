using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Atomic publication through the new file's handle. Never close a temporary path
// and then trust that the same directory entry still identifies our ciphertext.
internal static class WindowsPrivateFilePublish {
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RenameInfo { public byte Replace; public IntPtr Root; public uint Length; public char First; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string value, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateDirectoryW(string path, ref SecurityAttributes security);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, IntPtr information, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
    static void Rename(SafeFileHandle file, string target, bool createOnly) {
        var name = Encoding.Unicode.GetBytes(target);
        int offset = (int)Marshal.OffsetOf(typeof(RenameInfo), "First");
        // FileNameLength excludes NUL, but FileName itself must be NUL terminated.
        // Without these two bytes Win32 can resolve a suffix from adjacent heap data.
        int size = offset + name.Length + 2;
        var buffer = Marshal.AllocHGlobal(size);
        try {
            for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
            Marshal.WriteByte(buffer, createOnly ? (byte)0 : (byte)1);
            Marshal.WriteInt32(buffer, (int)Marshal.OffsetOf(typeof(RenameInfo), "Length"), name.Length);
            Marshal.Copy(name, 0, IntPtr.Add(buffer, offset), name.Length);
            if (!SetFileInformationByHandle(file, 3, buffer, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var final = new StringBuilder(32768);
            var length = GetFinalPathNameByHandleW(file, final, (uint)final.Capacity, 0);
            if (length == 0 || length >= final.Capacity || !String.Equals(final.ToString(), @"\\?\" + target, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static void DeleteOnClose(SafeFileHandle file) {
        var buffer = Marshal.AllocHGlobal(1);
        try { Marshal.WriteByte(buffer, 1); SetFileInformationByHandle(file, 4, buffer, 1); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    static SecurityAttributes PrivateSecurity(bool directory) {
        var sid = WindowsIdentity.GetCurrent().User.Value;
        uint size; IntPtr descriptor;
        var inherit = directory ? "OICI" : "";
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("O:" + sid + "D:P(A;" + inherit + ";FA;;;SY)(A;" + inherit + ";FA;;;" + sid + ")", 1, out descriptor, out size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor, Inherit = 0 };
    }
    internal static void PrepareDirectory(string target) {
        target = WindowsPrivateFileRead.ValidatePath(target);
        var directories = new List<string>();
        for (var current = target; current != null; current = Path.GetDirectoryName(current)) directories.Add(current);
        directories.Reverse();
        var held = new List<SafeFileHandle>();
        var security = PrivateSecurity(true);
        try {
            foreach (var directory in directories) {
                // Opening an existing parent needs no create-child permission. Creating it
                // first can report ACCESS_DENIED even though that parent already exists.
                try { held.Add(WindowsPrivateFileRead.Open(directory, true)); continue; }
                catch (Win32Exception error) { if (error.NativeErrorCode != 2 && error.NativeErrorCode != 3) throw; }
                if (!CreateDirectoryW(@"\\?\" + directory, ref security)) {
                    int error = Marshal.GetLastWin32Error();
                    if (error != 183) throw new Win32Exception(error);
                }
                // Existing directory ACLs stay unchanged. Pin each parent before creating its child.
                held.Add(WindowsPrivateFileRead.Open(directory, true));
            }
        } finally {
            LocalFree(security.Descriptor);
            for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose();
        }
    }
    internal static void Publish(string target, byte[] ciphertext, bool createOnly, Func<byte[], bool> authenticated) {
        target = WindowsPrivateFileRead.ValidatePath(target);
        var held = WindowsPrivateFileRead.HoldParents(target);
        IntPtr descriptor = IntPtr.Zero;
        try {
            // Validate an existing generation before replacing it. Only absence permits creation.
            try {
                var previous = WindowsPrivateFileRead.Read(target, authenticated);
                Array.Clear(previous, 0, previous.Length);
                if (createOnly) throw new Win32Exception(183);
            } catch (Win32Exception error) { if (error.NativeErrorCode != 2) throw; }
            var security = PrivateSecurity(false);
            descriptor = security.Descriptor;
            var temporary = Path.Combine(Path.GetDirectoryName(target), ".saycode-secret-" + Guid.NewGuid().ToString("N") + ".tmp");
            using (var handle = CreateFileW(@"\\?\" + temporary, 0xC0010080, 1, ref security, 1, 0x00200000, IntPtr.Zero)) {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                bool published = false;
                using (var stream = new FileStream(handle, FileAccess.ReadWrite)) {
                    try {
                        stream.Write(ciphertext, 0, ciphertext.Length);
                        stream.Flush(true);
                        WindowsPrivateFileRead.Check(handle, false);
                        Rename(handle, target, createOnly);
                        published = true;
                    } finally { if (!published) DeleteOnClose(handle); }
                }
            }
        } finally {
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose();
        }
    }
}

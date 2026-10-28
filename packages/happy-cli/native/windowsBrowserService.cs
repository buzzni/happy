// Service identity and credential custody only. Runtime admission remains disabled
// until the broker, process supervisor and independent network guard are connected.
using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

internal sealed class BrowserService : ServiceBase {
    readonly string root;
    readonly string pipeName;
    readonly SecurityIdentifier principal;
    readonly string generation = Guid.NewGuid().ToString("D");
    readonly object gate = new object();
    NamedPipeServerStream pending;
    volatile bool stopping;
    static readonly SecurityIdentifier SystemSid = new SecurityIdentifier("S-1-5-18");
    static readonly SecurityIdentifier InstallerSid = new SecurityIdentifier("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");
    static readonly SecurityIdentifier AdminSid = new SecurityIdentifier("S-1-5-32-544");
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential)] struct FileInfoNative {
        public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write;
        public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances, uint outSize, uint inSize, uint timeout, ref SecurityAttributes security);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfoNative info);

    BrowserService(bool verification) {
        ServiceName = verification ? "SaycodeBrowserRuntimeVerification" : "SaycodeBrowserRuntime";
        root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), ServiceName);
        pipeName = ServiceName + "-status-v1";
        principal = (SecurityIdentifier)new NTAccount("NT SERVICE", ServiceName).Translate(typeof(SecurityIdentifier));
        CanStop = true; AutoLog = false;
    }
    bool Trusted(IdentityReference sid, bool serviceAllowed) {
        return sid.Equals(SystemSid) || sid.Equals(AdminSid) || (serviceAllowed && sid.Equals(principal));
    }
    void VerifyAcl(FileSystemSecurity acl, bool privateData, bool serviceWrite, bool ancestor) {
        if (!Trusted(acl.GetOwner(typeof(SecurityIdentifier)), serviceWrite) && !(ancestor && acl.GetOwner(typeof(SecurityIdentifier)).Equals(InstallerSid))) throw new IOException("Untrusted owner");
        if (privateData && !acl.AreAccessRulesProtected) throw new IOException("Inherited private ACL");
        var danger = FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | (FileSystemRights)0x10000000;
        if (!ancestor) danger |= FileSystemRights.Write | (FileSystemRights)0x40000000;
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
            if ((rule.PropagationFlags & PropagationFlags.InheritOnly) != 0 || rule.AccessControlType == AccessControlType.Deny) continue;
            if (!Trusted(rule.IdentityReference, serviceWrite) && !(ancestor && rule.IdentityReference.Equals(InstallerSid)) && (privateData || (rule.FileSystemRights & danger) != 0)) throw new IOException("Untrusted access");
        }
    }
    void VerifyDirectory(string path, bool privateData) {
        for (var current = new DirectoryInfo(path); current != null; current = current.Parent) {
            if ((current.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Reparse storage");
            bool target = current.FullName.Equals(path, StringComparison.OrdinalIgnoreCase);
            VerifyAcl(current.GetAccessControl(), privateData && target, privateData && target, !target);
        }
    }
    FileSecurity KeySecurity() {
        var acl = new FileSecurity();
        acl.SetAccessRuleProtection(true, false); acl.SetOwner(principal);
        foreach (var sid in new[] { principal, SystemSid, AdminSid }) acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
        return acl;
    }
    void PrepareCustody() {
        ExitCode = 10;
        if (!WindowsIdentity.GetCurrent().User.Equals(principal)) throw new IOException("Wrong service identity");
        ExitCode = 11;
        VerifyDirectory(root, false);
        string binary = System.Reflection.Assembly.GetExecutingAssembly().Location;
        ExitCode = 12;
        using (var file = File.Open(binary, FileMode.Open, FileAccess.Read, FileShare.Read)) VerifyFile(file, false);
        string state = Path.Combine(root, "state"), key = Path.Combine(state, "agent.key");
        ExitCode = 13;
        VerifyDirectory(state, true);
        ExitCode = 14;
        if (!File.Exists(key)) {
            byte[] secret = new byte[32], encoded = new byte[64];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(secret);
            try {
                const string hex = "0123456789abcdef";
                for (int i = 0; i < secret.Length; ++i) {
                    encoded[i * 2] = (byte)hex[secret[i] >> 4];
                    encoded[i * 2 + 1] = (byte)hex[secret[i] & 15];
                }
                using (var file = new FileStream(key, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.WriteThrough, KeySecurity())) {
                    file.Write(encoded, 0, encoded.Length); file.Flush(true);
                }
            } finally { Array.Clear(secret, 0, secret.Length); Array.Clear(encoded, 0, encoded.Length); }
        }
        using (var file = File.Open(key, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            VerifyFile(file, true);
            if (file.Length != 64) throw new IOException("Invalid credential length");
            for (int i = 0; i < 64; ++i) {
                int value = file.ReadByte();
                if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) throw new IOException("Invalid credential encoding");
            }
        }
    }
    void VerifyFile(FileStream file, bool privateData) {
        FileInfoNative metadata;
        if (!GetFileInformationByHandle(file.SafeFileHandle, out metadata) || metadata.links != 1 || (metadata.attributes & (uint)FileAttributes.ReparsePoint) != 0) throw new IOException("Unsafe file");
        VerifyAcl(file.GetAccessControl(), privateData, privateData, false);
    }
    NamedPipeServerStream CreateStatusPipe() {
        var acl = new PipeSecurity();
        acl.SetAccessRuleProtection(true, false);
        foreach (var sid in new[] { principal, SystemSid, AdminSid }) acl.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.FullControl, AccessControlType.Allow));
        // Public local status contains no credential, profile, command or readiness grant.
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier("S-1-5-11"), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        byte[] bytes = acl.GetSecurityDescriptorBinaryForm();
        IntPtr descriptor = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, descriptor, bytes.Length);
            var sa = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = descriptor, inherit = 0 };
            // First-instance ownership prevents a local pipe squatter; reject remote clients.
            var handle = CreateNamedPipe(@"\\.\pipe\" + pipeName, 0x40080003, 8, 1, 4096, 4096, 0, ref sa);
            if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Status pipe unavailable"); }
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        } finally { Marshal.FreeHGlobal(descriptor); }
    }
    protected override void OnStart(string[] args) {
        PrepareCustody();
        ExitCode = 15;
        pending = CreateStatusPipe();
        ExitCode = 0;
        Task.Run(async delegate {
            try {
                while (!stopping) {
                    NamedPipeServerStream pipe;
                    lock (gate) { if (stopping) break; pipe = pending; }
                    await pipe.WaitForConnectionAsync().ConfigureAwait(false);
                    byte[] response = Encoding.UTF8.GetBytes("{\"version\":1,\"principal\":\"" + principal.Value + "\",\"generation\":\"" + generation + "\",\"runtimeReady\":false}\n");
                    try {
                        using (var timeout = new CancellationTokenSource(3000)) {
                            await pipe.WriteAsync(response, 0, response.Length, timeout.Token).ConfigureAwait(false);
                            // Keep the response until the client reads it; Disconnect discards unread bytes.
                            await pipe.ReadAsync(new byte[1], 0, 1, timeout.Token).ConfigureAwait(false);
                        }
                    } catch (IOException) { } catch (OperationCanceledException) { }
                    if (!stopping) pipe.Disconnect();
                }
            } catch {
                if (!stopping) { ExitCode = 1; Stop(); }
            }
        });
    }
    protected override void OnStop() {
        lock (gate) { stopping = true; if (pending != null) pending.Dispose(); }
        // Avoid waiting on this task when its own error path called Stop().
    }
    static int Probe(bool verification) {
        string name = (verification ? "SaycodeBrowserRuntimeVerification" : "SaycodeBrowserRuntime") + "-status-v1";
        using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous)) {
            pipe.Connect(5000);
            byte[] bytes = new byte[512];
            int count = 0;
            while (count < bytes.Length) {
                var read = pipe.ReadAsync(bytes, count, 1);
                if (!read.Wait(5000) || read.Result != 1) throw new IOException("Incomplete status");
                if (bytes[count++] == 10) { pipe.WriteByte(1); Console.Write(Encoding.UTF8.GetString(bytes, 0, count)); return 0; }
            }
            throw new IOException("Oversized status");
        }
    }
    static int Main(string[] args) {
        try {
            if (args.Length == 1 && args[0] == "--probe-verification") return Probe(true);
            if (args.Length == 1 && args[0] == "--probe") return Probe(false);
            bool verification = args.Length == 1 && args[0] == "--verification";
            if (args.Length != 0 && !verification) return 2;
            ServiceBase.Run(new BrowserService(verification)); return 0;
        } catch { Console.Error.WriteLine("BROWSER_SERVICE_UNAVAILABLE"); return 1; }
    }
}

// Private pipe protocol only. No shell, environment secret, ACL mutation or plaintext file.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

internal static class WindowsUserProtection {
    const int Limit = 8 * 1024 * 1024;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Limit * 2, RecursionLimit = 8 };
    static string ReadInput() {
        using (var input = Console.OpenStandardInput())
        using (var buffer = new MemoryStream()) {
            var chunk = new byte[4096];
            int read;
            while ((read = input.Read(chunk, 0, chunk.Length)) > 0) {
                if (buffer.Length + read > Limit * 2) throw new InvalidDataException();
                buffer.Write(chunk, 0, read);
            }
            return new UTF8Encoding(false, true).GetString(buffer.ToArray());
        }
    }
    static byte[] Value(Dictionary<string, object> request) {
        var encoded = request["value"] as string;
        if (String.IsNullOrEmpty(encoded) || encoded.Length > Limit * 2) throw new InvalidDataException();
        var value = Convert.FromBase64String(encoded);
        if (value.Length == 0 || value.Length > Limit || Convert.ToBase64String(value) != encoded) throw new InvalidDataException();
        return value;
    }
    static bool CurrentUserBlob(byte[] value) {
        return value.Length >= 44 && BitConverter.ToUInt32(value, 0) == 1 && (BitConverter.ToUInt32(value, 40) & 4) == 0;
    }
    static byte[] DecodeFile(byte[] contents, byte[] entropy) {
        Dictionary<string, object> record;
        try { record = Json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(contents)); }
        catch { return null; }
        if (record == null || !record.ContainsKey("storage")) return null;
        if (!(record["storage"] is string) || (string)record["storage"] != "saycode-dpapi-v1" || record.Count != 2) throw new InvalidDataException();
        var blob = Value(record);
        try {
            if (!CurrentUserBlob(blob)) throw new InvalidDataException();
            return ProtectedData.Unprotect(blob, entropy, DataProtectionScope.CurrentUser);
        } finally { Array.Clear(blob, 0, blob.Length); }
    }
    static bool Authenticated(byte[] contents, byte[] entropy) {
        var clear = DecodeFile(contents, entropy);
        if (clear == null) return false;
        Array.Clear(clear, 0, clear.Length);
        return true;
    }
    static int Main() {
        byte[] value = null, output = null, entropy = null;
        try {
            var request = Json.Deserialize<Dictionary<string, object>>(ReadInput());
            if (request == null || request.Count != 4 || !(request["version"] is int) || (int)request["version"] != 1) throw new InvalidDataException();
            var operation = request["operation"] as string;
            var purpose = request["purpose"] as string;
            if (String.IsNullOrEmpty(purpose) || purpose.Length > 4096 || purpose.IndexOf('\0') >= 0) throw new InvalidDataException();
            value = Value(request);
            using (var sha = SHA256.Create()) entropy = sha.ComputeHash(Encoding.UTF8.GetBytes("Saycode.WindowsSecret.v1\n" + purpose));
            if (operation == "storage-roots") {
                var suffix = "Saycode-Secrets-" + WindowsIdentity.GetCurrent().User.Value;
                var common = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), suffix);
                var local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), suffix);
                WindowsPrivateFileRead.ValidatePath(common); WindowsPrivateFileRead.ValidatePath(local);
                output = Encoding.UTF8.GetBytes(Json.Serialize(new[] { common, local }));
            }
            else if (operation == "prepare-directory") {
                WindowsPrivateFilePublish.PrepareDirectory(new UTF8Encoding(false, true).GetString(value));
                output = Encoding.UTF8.GetBytes("ok");
            }
            else if (operation == "read-private-legacy") output = WindowsPrivateFileRead.Read(new UTF8Encoding(false, true).GetString(value));
            else if (operation == "read-protected") {
                var contents = WindowsPrivateFileRead.Read(new UTF8Encoding(false, true).GetString(value), bytes => Authenticated(bytes, entropy));
                try { output = DecodeFile(contents, entropy) ?? (byte[])contents.Clone(); }
                finally { Array.Clear(contents, 0, contents.Length); }
            }
            else if (operation == "publish-protected" || operation == "write-protected") {
                var file = Json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(value));
                if (file.Count != 3 || !(file["path"] is string) || !(file["contents"] is string) || !(file["createOnly"] is bool)) throw new InvalidDataException();
                var contents = new UTF8Encoding(false, true).GetBytes((string)file["contents"]);
                try {
                    if (operation == "write-protected") {
                        var blob = ProtectedData.Protect(contents, entropy, DataProtectionScope.CurrentUser);
                        Array.Clear(contents, 0, contents.Length);
                        try { contents = Encoding.UTF8.GetBytes(Json.Serialize(new { storage = "saycode-dpapi-v1", value = Convert.ToBase64String(blob) })); }
                        finally { Array.Clear(blob, 0, blob.Length); }
                    }
                    if (!Authenticated(contents, entropy)) throw new InvalidDataException();
                    WindowsPrivateFilePublish.Publish((string)file["path"], contents, (bool)file["createOnly"], bytes => Authenticated(bytes, entropy));
                } finally { Array.Clear(contents, 0, contents.Length); }
                output = Encoding.UTF8.GetBytes("ok");
            }
            else if (operation == "protect") output = ProtectedData.Protect(value, entropy, DataProtectionScope.CurrentUser);
            else if (operation == "unprotect" && CurrentUserBlob(value)) output = ProtectedData.Unprotect(value, entropy, DataProtectionScope.CurrentUser);
            else throw new InvalidDataException();
            if (output.Length == 0 || output.Length > Limit) throw new InvalidDataException();
            if (operation == "protect" && !CurrentUserBlob(output)) throw new CryptographicException();
            Console.Out.Write(Json.Serialize(new { version = 1, ok = true, value = Convert.ToBase64String(output) }));
            return 0;
        } catch (Exception error) {
            // Error messages may include user paths or input; only a fixed code crosses this boundary.
            var native = error as Win32Exception;
            var code = native != null && (native.NativeErrorCode == 2 || native.NativeErrorCode == 3) ? "ENOENT" :
                native != null && (native.NativeErrorCode == 80 || native.NativeErrorCode == 183) ? "EEXIST" : "WINDOWS_SECRET_PROTECTION_FAILED";
            Console.Out.Write(Json.Serialize(new { version = 1, ok = false, error = code }));
            return 1;
        } finally {
            if (value != null) Array.Clear(value, 0, value.Length);
            if (output != null) Array.Clear(output, 0, output.Length);
            if (entropy != null) Array.Clear(entropy, 0, entropy.Length);
        }
    }
}

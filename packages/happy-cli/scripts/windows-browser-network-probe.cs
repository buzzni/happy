// Disposable SCM test workload. No production entrypoint uses this program.
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.ServiceProcess;
using System.Threading.Tasks;

sealed class NetworkProbe : ServiceBase {
    readonly string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "SaycodeBrowserRuntimeVerification");
    NetworkProbe() { ServiceName = "SaycodeBrowserRuntimeVerification"; AutoLog = false; }
    static async Task<bool> Connect(string address, int port) {
        var ip = IPAddress.Parse(address);
        using (var client = new TcpClient(ip.AddressFamily)) {
            try {
                var connection = client.ConnectAsync(ip,port);
                if (await Task.WhenAny(connection, Task.Delay(2000)) != connection) return false;
                await connection; return true;
            } catch (SocketException) { return false; }
        }
    }
    protected override void OnStart(string[] args) {
        Task.Run(async delegate {
            string result;
            try {
                var ports = File.ReadAllLines(Path.Combine(root,"probe-ports.txt"));
                int proxy = Int32.Parse(ports[0]), other = Int32.Parse(ports[1]);
                bool allowed = await Connect("127.0.0.1",proxy);
                bool otherPort = await Connect("127.0.0.1",other);
                bool otherAddress = await Connect("127.0.0.2",proxy);
                bool ipv6 = await Connect("::1",proxy);
                bool udp;
                using (var socket = new UdpClient(AddressFamily.InterNetwork)) {
                    try { socket.Send(new byte[] {1},1,"127.0.0.1",proxy); udp=true; }
                    catch (SocketException) { udp=false; }
                }
                result = String.Join(",", new[] { allowed, otherPort, otherAddress, ipv6, udp });
            } catch { result = "ERROR"; }
            string receipt = Path.Combine(root,"state","probe-result.txt");
            File.WriteAllText(receipt + ".tmp", result);
            File.Move(receipt + ".tmp", receipt);
        });
    }
    static void Main() { ServiceBase.Run(new NetworkProbe()); }
}

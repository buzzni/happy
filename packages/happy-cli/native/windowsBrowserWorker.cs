// The service validates and pins all installed inputs before calling Start.
// This owns a runtime tree, not browser identity isolation or readiness.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal sealed class WindowsBrowserWorker : IDisposable {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int cb; public string reserved, desktop, title;
        public int x,y,xs,ys,xc,yc,fill,flags; public short show,cbReserved;
        public IntPtr reserved2,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedStartup { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long processTime,jobTime; public uint flags; public UIntPtr min,max;
        public uint active; public UIntPtr affinity; public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimit basic; public IoCounters io; public UIntPtr a,b,c,d; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref Limits value,int size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting value,int size,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref ExtendedStartup startup,out ProcessInfo info);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    IntPtr job, process;
    static void Check(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string path) {
        if (path.IndexOf('"') >= 0 || path.IndexOf('\0') >= 0 || path.EndsWith("\\")) throw new ArgumentException("Invalid worker path");
        return "\"" + path + "\"";
    }
    public static WindowsBrowserWorker Start(string executable,string script,string configuration,string state) {
        var worker = new WindowsBrowserWorker();
        IntPtr attributes=IntPtr.Zero, jobValue=IntPtr.Zero, environment=IntPtr.Zero;
        bool initialized=false;
        try {
            worker.job=CreateJobObject(IntPtr.Zero,null); Check(worker.job!=IntPtr.Zero);
            var limits=new Limits(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway.
            Check(SetInformationJobObject(worker.job,9,ref limits,Marshal.SizeOf(typeof(Limits))));
            IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            attributes=Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes,1,0,ref size)); initialized=true;
            jobValue=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue,worker.job);
            // Atomic membership at creation; there is no runnable process before assignment.
            Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000d),jobValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
            string system=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            // Never inherit NODE_OPTIONS, user bearer tokens or arbitrary service environment.
            environment=Marshal.StringToHGlobalUni("ABP_CONFIG_FILE="+configuration+"\0ABP_STATE_DIR="+state+
                "\0SystemRoot="+system+"\0TEMP="+state+"\0TMP="+state+"\0\0");
            var startup=new ExtendedStartup { startup=new Startup { cb=Marshal.SizeOf(typeof(ExtendedStartup)) }, attributes=attributes };
            ProcessInfo info;
            Check(CreateProcess(executable,new StringBuilder(Quote(executable)+" "+Quote(script)),IntPtr.Zero,IntPtr.Zero,false,
                0x08080400,environment,System.IO.Path.GetDirectoryName(executable),ref startup,out info));
            worker.process=info.process; CloseHandle(info.thread);
            return worker;
        } catch { worker.Dispose(); throw; }
        finally {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            foreach (var pointer in new[] { attributes,jobValue,environment }) if (pointer!=IntPtr.Zero) Marshal.FreeHGlobal(pointer);
        }
    }
    public bool HasExited {
        get { uint result=WaitForSingleObject(process,0); Check(result!=0xffffffff); return result==0; }
    }
    public void Stop() {
        if (job==IntPtr.Zero) return;
        Check(TerminateJobObject(job,125));
        var deadline=Stopwatch.StartNew();
        while (true) {
            Accounting accounting;
            Check(QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
            if (accounting.active==0) return;
            if (deadline.ElapsedMilliseconds>=5000) throw new InvalidOperationException("Runtime worker termination is unconfirmed");
            Thread.Sleep(20);
        }
    }
    public void Dispose() {
        // Last non-inherited handle closes the tree even if the host is killed.
        if (job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; }
        if (process!=IntPtr.Zero) { CloseHandle(process); process=IntPtr.Zero; }
    }
}

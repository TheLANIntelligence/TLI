// Build with build_launcher.ps1. The existing Python launcher owns backend lifecycle.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("TLI")]
[assembly: AssemblyProduct("TheLANIntelligence")]
[assembly: AssemblyDescription("Open your private, LAN-native AI")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class TliProgram
{
    [STAThread]
    private static void Main()
    {
        string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string key;
        using (var hash = SHA256.Create())
            key = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()))).Replace("-", "");
        bool first;
        using (var mutex = new Mutex(true, @"Local\TLI.Launcher." + key, out first))
        {
            if (!first)
            {
                try { using (var signal = EventWaitHandle.OpenExisting(@"Local\TLI.Show." + key)) signal.Set(); }
                catch (WaitHandleCannotBeOpenedException) { }
                return;
            }
            using (var signal = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\TLI.Show." + key))
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var window = new TliWindow(root))
                {
                    var registration = ThreadPool.RegisterWaitForSingleObject(signal,
                        delegate { window.ShowAgain(); }, null, Timeout.Infinite, false);
                    Application.Run(window);
                    registration.Unregister(null);
                }
            }
            mutex.ReleaseMutex();
        }
    }
}

internal sealed class TliWindow : Form
{
    private readonly string root;
    private readonly Label heading, status, footer;
    private readonly ProgressBar progress;
    private readonly Button primary, shortcuts, logs, repair;
    private readonly TextBox details;
    private bool busy, dismissed, keepRecoveryOpen, automaticOpened;
    private int operationGeneration;
    private string readyUrl;
    private readonly Action<string> browser;
    private readonly Func<ProcessStartInfo> setupCommand, shortcutCommand;
    private readonly Color ink, accent, muted, surface, onAccent, accentHover;
    internal const string RuntimeHelpUrl = "https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist/";
    internal const int SetupLogLimit = 1024 * 1024;
    private const string SetupProgressPrefix = "TLI_SETUP_PROGRESS:";

    internal TliWindow(string installation, bool autoStart = true, Action<string> openBrowser = null, bool? darkAppearance = null,
        Func<ProcessStartInfo> setupProcess = null, Func<ProcessStartInfo> shortcutProcess = null)
    {
        root = Path.GetFullPath(installation);
        browser = openBrowser ?? (url => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }));
        setupCommand = setupProcess ?? (() => SetupCommand(root));
        shortcutCommand = shortcutProcess ?? (() => ShortcutCommand(root));
        // Native startup follows Windows. Browser palette preferences remain in
        // the browser; startup never reads application data to choose a color.
        bool dark = darkAppearance ?? AppUsesDarkAppearance();
        bool highContrast = SystemInformation.HighContrast;
        ink = highContrast ? SystemColors.WindowText : dark ? Color.FromArgb(229, 240, 235) : Color.FromArgb(27, 48, 40);
        muted = highContrast ? SystemColors.WindowText : dark ? Color.FromArgb(172, 190, 184) : Color.FromArgb(82, 103, 92);
        accent = highContrast ? SystemColors.Highlight : dark ? Color.FromArgb(107, 219, 178) : Color.FromArgb(8, 120, 88);
        onAccent = highContrast ? SystemColors.HighlightText : dark ? Color.FromArgb(16, 23, 23) : Color.White;
        accentHover = highContrast ? SystemColors.Highlight : dark ? Color.FromArgb(138, 233, 198) : Color.FromArgb(6, 98, 71);
        surface = highContrast ? SystemColors.Window : dark ? Color.FromArgb(23, 33, 36) : Color.FromArgb(237, 243, 240);
        var release = (AssemblyInformationalVersionAttribute)Attribute.GetCustomAttribute(
            Assembly.GetExecutingAssembly(), typeof(AssemblyInformationalVersionAttribute));
        Text = release == null ? "TLI" : "TLI " + release.InformationalVersion;
        ClientSize = new Size(560, 448);
        MinimumSize = new Size(530, 480);
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = highContrast ? SystemColors.Window : dark ? Color.FromArgb(16, 23, 25) : Color.FromArgb(244, 247, 246);
        ForeColor = ink;
        Font = new Font("Segoe UI", 10);
        MaximizeBox = false;
        try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(32), ColumnCount = 1, RowCount = 9 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 84));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 4));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        Controls.Add(layout);
        var name = new Label { Text = "TLI", Font = new Font("Segoe UI", 28, FontStyle.Bold), AutoSize = true, ForeColor = accent, Margin = new Padding(0, 0, 0, 5) };
        var identity = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Margin = Padding.Empty };
        identity.Controls.Add(name);
        identity.Controls.Add(new Label { Text = "Your private AI. On your network.", AutoSize = true, ForeColor = muted, Margin = Padding.Empty });
        layout.Controls.Add(identity, 0, 0);

        heading = new Label { Text = "Opening TLI", AutoSize = true, Font = new Font("Segoe UI", 15, FontStyle.Bold), Dock = DockStyle.Fill, Margin = new Padding(0, 0, 0, 12) };
        status = new Label { Text = "Checking this installation…", AutoSize = true, Dock = DockStyle.Fill, ForeColor = muted, Margin = new Padding(0, 0, 0, 18) };
        progress = new ProgressBar { Dock = DockStyle.Fill, Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 30, Margin = Padding.Empty };
        details = new TextBox { Dock = DockStyle.Fill, ReadOnly = true, Multiline = true, ScrollBars = ScrollBars.Vertical, Visible = false, BackColor = surface, ForeColor = ink, BorderStyle = BorderStyle.FixedSingle, Font = new Font("Segoe UI", 10), Margin = new Padding(0, 8, 0, 16), AccessibleName = "Startup details" };
        layout.Controls.Add(heading, 0, 1); layout.Controls.Add(status, 0, 2); layout.Controls.Add(progress, 0, 3); layout.Controls.Add(details, 0, 4);
        primary = new Button { Text = "Open TLI", Dock = DockStyle.Fill, FlatStyle = FlatStyle.Flat, BackColor = accent, ForeColor = onAccent, Enabled = false, Cursor = Cursors.Hand, Font = new Font("Segoe UI", 10, FontStyle.Bold), Margin = Padding.Empty };
        primary.FlatAppearance.BorderSize = 0;
        primary.FlatAppearance.MouseOverBackColor = accentHover;
        primary.FlatAppearance.MouseDownBackColor = accentHover;
        primary.Click += delegate { if (!busy) { if (primary.Tag as string == "setup") RunSetup(); else if (readyUrl != null) OpenBrowser(); else BeginLaunch(); } };
        layout.Controls.Add(primary, 0, 5);
        repair = LinkButton("Microsoft Visual C++ setup guidance"); repair.Visible = false;
        repair.Click += delegate { OpenRuntimeHelp(); };
        layout.Controls.Add(repair, 0, 6);
        var links = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.LeftToRight, Margin = Padding.Empty };
        shortcuts = LinkButton("Add Desktop & Start Menu shortcuts");
        shortcuts.Click += delegate { AddShortcuts(); };
        logs = LinkButton("Open logs"); logs.Visible = false;
        logs.Click += delegate { OpenLogFolder(); };
        links.Controls.Add(shortcuts); links.Controls.Add(logs); layout.Controls.Add(links, 0, 7);
        footer = new Label { Text = "TLI runs in the background. Use its Device menu to Restart or Quit.", AutoSize = true, Dock = DockStyle.Fill, Font = new Font("Segoe UI", 9), ForeColor = muted, Padding = new Padding(0, 7, 0, 0), Margin = Padding.Empty };
        layout.Controls.Add(footer, 0, 8);
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) { dismissed = true; Hide(); e.Cancel = true; } };
        if (autoStart) Shown += delegate { BeginLaunch(); };
    }

    private static bool AppUsesDarkAppearance()
    {
        try
        {
            using (var personalization = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                return personalization != null && Object.Equals(personalization.GetValue("AppsUseLightTheme"), 0);
        }
        catch { return false; }
    }

    private Button LinkButton(string text)
    {
        var button = new Button { Text = text, UseMnemonic = false, AutoSize = true, FlatStyle = FlatStyle.Flat, ForeColor = accent, Cursor = Cursors.Hand, Font = new Font("Segoe UI", 9), Padding = Padding.Empty, Margin = new Padding(0, 3, 12, 0) };
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = surface;
        button.FlatAppearance.MouseDownBackColor = surface;
        return button;
    }

    internal void ShowAgain()
    {
        OnUi(delegate
        {
            dismissed = false; Show(); WindowState = FormWindowState.Normal; Activate();
            // A new explicit launch must verify current ownership/readiness,
            // even when a previous advisory window is still open.
            if (!busy && readyUrl != null) BeginLaunch();
        });
    }

    private void OnUi(Action action)
    {
        if (IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke(new Action(delegate { if (!IsDisposed) action(); })); }
        catch (InvalidOperationException) { }
    }

    internal static bool LocalUrl(string value)
    {
        Uri uri;
        return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.IsLoopback &&
            (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp) && String.IsNullOrEmpty(uri.UserInfo);
    }

    internal static ProcessStartInfo WorkerCommand(string installation)
    {
        var start = new ProcessStartInfo(Path.Combine(installation, @"backend\.venv\Scripts\python.exe"),
            "\"" + Path.Combine(installation, @"backend\desktop_launcher.py") + "\"");
        start.WorkingDirectory = installation;
        start.UseShellExecute = false; start.CreateNoWindow = true;
        start.RedirectStandardOutput = true; start.RedirectStandardError = true; start.RedirectStandardInput = true;
        start.StandardOutputEncoding = Encoding.UTF8; start.StandardErrorEncoding = Encoding.UTF8;
        start.EnvironmentVariables.Remove("PYTHONPATH"); start.EnvironmentVariables.Remove("PYTHONHOME");
        start.EnvironmentVariables.Remove("TLI_ROOT");
        start.EnvironmentVariables["PYTHONUTF8"] = "1";
        return start;
    }

    private static ProcessStartInfo PowerShellCommand(string installation, string script, string arguments)
    {
        return new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
            "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(installation, script) + "\" " + arguments)
        {
            WorkingDirectory = installation, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
    }

    internal static ProcessStartInfo SetupCommand(string installation)
    {
        return PowerShellCommand(installation, "TLI_Bootstrap.ps1", "-SetupOnly");
    }

    internal static ProcessStartInfo ShortcutCommand(string installation)
    {
        return PowerShellCommand(installation, "TLI_Setup.ps1", "-Action CreateShortcuts");
    }

    internal async void BeginLaunch()
    {
        if (busy || IsDisposed || dismissed) return;
        int generation = ++operationGeneration;
        automaticOpened = false; keepRecoveryOpen = false;
        readyUrl = null; details.Visible = false; logs.Visible = false; repair.Visible = false; primary.Tag = null;
        if (!File.Exists(Path.Combine(root, @"backend\.venv\Scripts\python.exe"))) { SetupNeeded(); return; }
        busy = true; primary.Enabled = false; progress.Visible = true;
        heading.Text = "Opening TLI"; status.Text = "Checking whether TLI is already running…";
        string workerError = null, runtimeWarning = null, url = null; bool needsSetup = false; int exit = -1;
        try
        {
            await Task.Run(delegate
            {
                using (var process = new Process { StartInfo = WorkerCommand(root) })
                {
                    process.Start(); process.StandardInput.Close();
                    // Drain both pipes concurrently so diagnostics never block startup.
                    var errors = Task.Run(() => process.StandardError.ReadToEnd());
                    string line;
                    var json = new JavaScriptSerializer { MaxJsonLength = 32768 };
                    while ((line = process.StandardOutput.ReadLine()) != null)
                    {
                        if (line.Length > 32768) continue;
                        Dictionary<string, object> item;
                        try { item = json.Deserialize<Dictionary<string, object>>(line); }
                        catch { continue; }
                        object raw; string kind = item != null && item.TryGetValue("event", out raw) ? raw as string : null;
                        string message = item != null && item.TryGetValue("message", out raw) ? raw as string : null;
                        if (kind == "progress" && message != null) OnUi(delegate { if (busy && generation == operationGeneration) status.Text = message; });
                        if (kind == "setup_required") needsSetup = true;
                        if (kind == "error") workerError = message;
                        if (kind == "warning" && item.TryGetValue("code", out raw) && raw as string == "local_ai_unavailable") runtimeWarning = message;
                        if (kind == "ready" && item.TryGetValue("url", out raw) && LocalUrl(raw as string)) url = raw as string;
                    }
                    process.WaitForExit(); exit = process.ExitCode;
                    string stderr = errors.Result;
                    if (workerError == null && stderr.Length > 0) workerError = stderr.Length > 4000 ? stderr.Substring(stderr.Length - 4000) : stderr;
                }
            });
        }
        catch (Exception error) { workerError = error.Message; }
        busy = false; progress.Visible = false;
        if (dismissed) { Close(); return; }
        if (needsSetup) { SetupNeeded(); return; }
        if (exit != 0 || url == null) { Failed(workerError ?? "TLI has not confirmed that it is ready. Open logs for details, then try again."); return; }
        if (!String.IsNullOrWhiteSpace(runtimeWarning)) ReadyWithRuntimeWarning(url, runtimeWarning);
        else
        {
            readyUrl = url; heading.Text = "TLI is ready"; status.Text = "Opening TLI in your browser…";
            primary.Text = "Open TLI"; primary.Enabled = true;
        }
        if (!automaticOpened && !dismissed)
        {
            automaticOpened = true;
            OpenBrowser();
        }
    }

    internal void SetupNeeded()
    {
        readyUrl = null; keepRecoveryOpen = false; details.Visible = false; repair.Visible = false; logs.Visible = false;
        heading.Text = "Welcome to TLI";
        status.Text = "TLI will prepare Python and its required components, then open automatically. Windows may ask you to approve Microsoft's runtime installer.";
        progress.Visible = false; primary.Text = "Set up TLI"; primary.Tag = "setup"; primary.Enabled = true;
        footer.Text = "After setup, use TLI from your Desktop or Start Menu.";
    }

    internal void Failed(string message)
    {
        readyUrl = null; keepRecoveryOpen = false; repair.Visible = false;
        heading.Text = "TLI could not open"; status.Text = "Read the details below, then try again. You can select and copy the message or open the logs.";
        ShowDetails(message); logs.Visible = true;
        progress.Visible = false; primary.Tag = null; primary.Text = "Try again"; primary.Enabled = true;
    }

    internal void ReadyWithRuntimeWarning(string url, string message)
    {
        if (!LocalUrl(url)) { Failed("TLI did not confirm a local address that is ready to open."); return; }
        readyUrl = url; keepRecoveryOpen = true; heading.Text = "TLI is ready";
        status.Text = "Opening your TLI workspace. Local AI needs attention; the details below remain available while you finish setup.";
        repair.Visible = true; logs.Visible = true; ShowDetails(message);
        progress.Visible = false; primary.Tag = null; primary.Text = "Open TLI"; primary.Enabled = true;
        footer.Text = "Repair guidance opens Microsoft's website. You can close this window while using TLI.";
        primary.Focus();
    }

    private void ShowDetails(string message)
    {
        // The old fixed-height dialog left only three lines for recovery steps.
        // Keep normal startup compact, and reserve readable space for a problem.
        MinimumSize = SizeFromClientSize(new Size(560, 580));
        ClientSize = new Size(Math.Max(ClientSize.Width, 620), Math.Max(ClientSize.Height, 620));
        details.Text = (message ?? "No further details were provided.").Replace("\r\n", "\n").Replace("\n", Environment.NewLine); details.Visible = true;
        details.SelectionStart = 0; details.SelectionLength = 0; details.ScrollToCaret();
    }

    private void OpenRuntimeHelp()
    {
        // Only this fixed Microsoft page can be opened by the explicit repair
        // control. Worker messages never supply executable or external links.
        try { browser(RuntimeHelpUrl); }
        catch (Exception error) { status.Text = "Microsoft's page could not open. Visit " + RuntimeHelpUrl; ShowDetails(error.Message); }
    }

    private void OpenBrowser()
    {
        if (dismissed || !LocalUrl(readyUrl)) return;
        try
        {
            browser(readyUrl);
            if (keepRecoveryOpen)
            {
                status.Text = "TLI is open in your browser. Local AI needs attention; you can review the details here while using your workspace.";
                primary.Text = "Open TLI again";
            }
            else Close();
        }
        catch (Exception error)
        {
            status.Text = "Your browser could not open automatically. Open " + readyUrl;
            ShowDetails((keepRecoveryOpen ? details.Text + Environment.NewLine + Environment.NewLine : "") + error.Message);
        }
    }

    private async void RunSetup()
    {
        if (busy || dismissed || IsDisposed) return;
        int generation = ++operationGeneration;
        readyUrl = null; keepRecoveryOpen = false; details.Visible = false; repair.Visible = false; logs.Visible = false;
        busy = true; primary.Enabled = false; progress.Visible = true;
        heading.Text = "Setting up TLI"; status.Text = "Preparing your private AI workspace. TLI will open when it is ready.";
        try
        {
            await Task.Run(delegate
            {
                string logPath = SetupLogPath(root);
                Directory.CreateDirectory(Path.GetDirectoryName(logPath));
                logPath = SetupLogPath(root);
                using (var log = new FileStream(logPath, FileMode.Create, FileAccess.ReadWrite, FileShare.Read))
                {
                    int exit = RunSetupProcess(setupCommand(), log, generation, true);
                    if (exit != 0) throw new InvalidOperationException("Setup did not finish successfully (exit " + exit + "). Open logs and review setup.log, then try again.");
                    try
                    {
                        int shortcutExit = RunSetupProcess(shortcutCommand(), log, generation, false);
                        if (shortcutExit != 0) WriteSetupLog(log, "\r\nShortcut creation did not finish (exit " + shortcutExit + "). Use Add Desktop & Start Menu shortcuts to retry.\r\n");
                    }
                    catch (Exception error) { WriteSetupLog(log, "\r\nShortcuts could not be added: " + error.Message + "\r\n"); }
                }
            });
            busy = false; progress.Visible = false;
            if (dismissed) { Close(); return; }
            BeginLaunch();
        }
        catch (Exception error) { busy = false; if (dismissed) Close(); else Failed(error.Message); }
    }

    private int RunSetupProcess(ProcessStartInfo start, FileStream log, int generation, bool showProgress)
    {
        using (var process = new Process { StartInfo = start })
        {
            process.Start(); process.StandardInput.Close();
            var errors = Task.Run(() => DrainSetupOutput(process.StandardError, log, generation, false));
            DrainSetupOutput(process.StandardOutput, log, generation, showProgress);
            process.WaitForExit(); errors.Wait();
            return process.ExitCode;
        }
    }

    private void DrainSetupOutput(StreamReader reader, FileStream log, int generation, bool showProgress)
    {
        // Bound both the log and line parser even when an installer writes a
        // large diagnostic without newlines. Only our explicit phases reach UI.
        var buffer = new char[2048]; var line = new StringBuilder(); bool tooLong = false; int count = 0, next;
        // StreamReader buffers internally. Read one character at a time so a
        // short phase is displayed while setup is waiting, not only at EOF.
        while ((next = reader.Read()) >= 0)
        {
            char value = (char)next;
            buffer[count++] = value;
            if (value == '\n' || count == buffer.Length)
            {
                WriteSetupLog(log, new string(buffer, 0, count)); count = 0;
            }
            if (!showProgress) continue;
            if (value == '\n')
            {
                if (!tooLong && line.ToString().StartsWith(SetupProgressPrefix, StringComparison.Ordinal))
                {
                    string phase = line.ToString().Substring(SetupProgressPrefix.Length).Trim();
                    if (phase.Length > 0 && phase.Length <= 240)
                        OnUi(delegate { if (busy && !dismissed && generation == operationGeneration) status.Text = phase; });
                }
                line.Clear(); tooLong = false;
            }
            else if (line.Length < 512) line.Append(value);
            else tooLong = true;
        }
        if (count > 0) WriteSetupLog(log, new string(buffer, 0, count));
    }

    internal static string SetupLogPath(string installation)
    {
        string fullRoot = Path.GetFullPath(installation);
        for (var directory = new DirectoryInfo(fullRoot); directory != null; directory = directory.Parent)
            RejectLinkedSetupPath(directory.FullName);
        string data = Path.Combine(fullRoot, "data"), folder = Path.Combine(data, "host_control"), log = Path.Combine(folder, "setup.log");
        RejectLinkedSetupPath(data); RejectLinkedSetupPath(folder); RejectLinkedSetupPath(log);
        return log;
    }

    private static void RejectLinkedSetupPath(string path)
    {
        try
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Linked installation or setup-log paths are not supported. Setup did not change any files. Use an extracted TLI folder with regular local paths.");
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
    }

    private static void WriteSetupLog(FileStream log, string message)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(message);
        lock (log)
        {
            if (log.Length + bytes.Length > SetupLogLimit)
            {
                // Keep recent evidence, including the final failure, instead of
                // allowing package output to fill disk or hide the last phase.
                int retained = (int)Math.Min(log.Length, SetupLogLimit / 2);
                byte[] tail = new byte[retained];
                log.Position = log.Length - retained;
                int offset = 0, read;
                while (offset < retained && (read = log.Read(tail, offset, retained - offset)) > 0) offset += read;
                log.Position = 0; log.Write(tail, 0, offset); log.SetLength(offset);
            }
            int start = Math.Max(0, bytes.Length - SetupLogLimit / 2);
            log.Position = log.Length; log.Write(bytes, start, bytes.Length - start); log.Flush();
        }
    }

    private async void AddShortcuts()
    {
        shortcuts.Enabled = false;
        try
        {
            var start = shortcutCommand();
            using (var process = Process.Start(start))
            {
                process.StandardInput.Close();
                var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
                await Task.Run(() => process.WaitForExit()); await output;
                string message = await error;
                if (process.ExitCode != 0) throw new InvalidOperationException(message);
            }
            if (!IsDisposed && !Disposing) shortcuts.Text = "Shortcuts added";
        }
        catch (Exception error) { if (!IsDisposed && !Disposing) MessageBox.Show(this, error.Message, "TLI shortcuts", MessageBoxButtons.OK, MessageBoxIcon.Information); }
        finally { if (!IsDisposed) shortcuts.Enabled = true; }
    }

    private void OpenLogFolder()
    {
        string folder = Path.Combine(root, @"data\host_control");
        if (!Directory.Exists(folder)) folder = root;
        try { Process.Start(new ProcessStartInfo("explorer.exe", "\"" + folder + "\"") { UseShellExecute = false }); }
        catch (Exception error) { MessageBox.Show(this, error.Message, "TLI logs", MessageBoxButtons.OK, MessageBoxIcon.Information); }
    }
}

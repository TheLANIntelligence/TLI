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
    private readonly Button primary, shortcuts, logs, repair, stop, restart, check, cancelReview;
    private readonly TextBox details;
    private bool busy, dismissed, keepRecoveryOpen, automaticOpened;
    private int operationGeneration;
    private string readyUrl;
    private HostSnapshot snapshot;
    private string reviewedAction, reviewedToken;
    private readonly System.Windows.Forms.Timer statusTimer;
    private readonly int workerTimeout;
    private readonly Action<string> browser;
    private readonly Func<ProcessStartInfo> setupCommand, shortcutCommand;
    private readonly Color ink, accent, muted, surface, onAccent, accentHover;
    internal const string RuntimeHelpUrl = "https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist/";
    internal const int SetupLogLimit = 1024 * 1024;
    private const string SetupProgressPrefix = "TLI_SETUP_PROGRESS:";

    internal TliWindow(string installation, bool autoStart = true, Action<string> openBrowser = null, bool? darkAppearance = null,
        Func<ProcessStartInfo> setupProcess = null, Func<ProcessStartInfo> shortcutProcess = null, int workerTimeoutMilliseconds = 380000)
    {
        root = Path.GetFullPath(installation);
        browser = openBrowser ?? (url => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }));
        setupCommand = setupProcess ?? (() => SetupCommand(root));
        shortcutCommand = shortcutProcess ?? (() => ShortcutCommand(root));
        workerTimeout = workerTimeoutMilliseconds;
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

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(32), ColumnCount = 1, RowCount = 10 };
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
        primary.Click += delegate
        {
            if (busy) return;
            string action = primary.Tag as string;
            if (action == "setup") RunSetup();
            else if (action == "close") Close();
            else if (action == "review-restart") ReviewAction("restart");
            else if (action == "confirm") ConfirmAction();
            else if (action == "status") BeginStatus();
            else if (readyUrl != null) OpenBrowser();
            else BeginLaunch();
        };
        layout.Controls.Add(primary, 0, 5);
        var hostActions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, WrapContents = true, Margin = Padding.Empty };
        restart = LinkButton("Restart TLI"); restart.Visible = false;
        stop = LinkButton("Stop TLI"); stop.Visible = false;
        check = LinkButton("Check status"); check.Visible = false;
        cancelReview = LinkButton("Cancel"); cancelReview.Visible = false;
        restart.Click += delegate { if (snapshot != null && snapshot.State == "stopped") BeginLaunch(); else ReviewAction("restart"); };
        stop.Click += delegate { ReviewAction("stop"); };
        check.Click += delegate { BeginStatus(); };
        cancelReview.Click += delegate { CancelReview(); };
        hostActions.Controls.Add(restart); hostActions.Controls.Add(stop); hostActions.Controls.Add(check); hostActions.Controls.Add(cancelReview);
        layout.Controls.Add(hostActions, 0, 6);
        repair = LinkButton("Microsoft Visual C++ setup guidance"); repair.Visible = false;
        repair.Click += delegate { OpenRuntimeHelp(); };
        layout.Controls.Add(repair, 0, 7);
        var links = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.LeftToRight, Margin = Padding.Empty };
        shortcuts = LinkButton("Add Desktop & Start Menu shortcuts");
        shortcuts.Click += delegate { AddShortcuts(); };
        logs = LinkButton("Open logs"); logs.Visible = false;
        logs.Click += delegate { OpenLogFolder(); };
        links.Controls.Add(shortcuts); links.Controls.Add(logs); layout.Controls.Add(links, 0, 8);
        footer = new Label { Text = "Closing a browser or this window leaves TLI running. Use Stop TLI here to close its background service.", AutoSize = true, Dock = DockStyle.Fill, Font = new Font("Segoe UI", 9), ForeColor = muted, Padding = new Padding(0, 7, 0, 0), Margin = Padding.Empty };
        layout.Controls.Add(footer, 0, 9);
        statusTimer = new System.Windows.Forms.Timer { Interval = 10000 };
        statusTimer.Tick += delegate { if (!busy && !dismissed && reviewedAction == null && snapshot != null && snapshot.State == "running") BeginStatus(true); };
        FormClosed += delegate { statusTimer.Dispose(); };
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
            if (!busy && reviewedAction == null) BeginLaunch();
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

    internal static ProcessStartInfo WorkerCommand(string installation, string action = null, string token = null)
    {
        if (action != null && action != "status" && action != "stop" && action != "restart")
            throw new ArgumentException("Unknown launcher action.");
        if ((action == "stop" || action == "restart") && !ValidToken(token))
            throw new ArgumentException("A fresh reviewed action token is required.");
        if ((action == null || action == "status") && token != null)
            throw new ArgumentException("This launcher action does not accept a token.");
        var start = new ProcessStartInfo(Path.Combine(installation, @"backend\.venv\Scripts\python.exe"),
            "\"" + Path.Combine(installation, @"backend\desktop_launcher.py") + "\"" +
            (action == null ? "" : " --" + action + (token == null ? "" : " " + token)));
        start.WorkingDirectory = installation;
        start.UseShellExecute = false; start.CreateNoWindow = true;
        start.RedirectStandardOutput = true; start.RedirectStandardError = true; start.RedirectStandardInput = true;
        start.StandardOutputEncoding = Encoding.UTF8; start.StandardErrorEncoding = Encoding.UTF8;
        start.EnvironmentVariables.Remove("PYTHONPATH"); start.EnvironmentVariables.Remove("PYTHONHOME");
        start.EnvironmentVariables.Remove("TLI_ROOT");
        foreach (string key in new[] { "TLI_HOST", "TLI_PORT", "TLI_ENABLE_TLS", "TLI_LAN_MODE" })
            start.EnvironmentVariables.Remove(key);
        start.EnvironmentVariables["PYTHONUTF8"] = "1";
        return start;
    }

    private static bool ValidToken(string token)
    {
        if (token == null || token.Length != 64) return false;
        foreach (char value in token)
            if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) return false;
        return true;
    }

    private sealed class HostSnapshot
    {
        internal string State, Message, Token, Url;
        internal bool CanStop, CanRestart, RequiresRestart;
        internal static HostSnapshot Parse(Dictionary<string, object> item)
        {
            object value;
            string state = item.TryGetValue("state", out value) ? value as string : null;
            if (state != "running" && state != "stopped" && state != "starting" && state != "unverified") return null;
            var result = new HostSnapshot { State = state };
            result.Message = item.TryGetValue("message", out value) ? value as string : null;
            result.Token = item.TryGetValue("action_token", out value) ? value as string : null;
            result.CanStop = state == "running" && ValidToken(result.Token) && item.TryGetValue("can_stop", out value) && Object.Equals(value, true);
            result.CanRestart = state == "running" && ValidToken(result.Token) && item.TryGetValue("can_restart", out value) && Object.Equals(value, true);
            result.RequiresRestart = item.TryGetValue("requires_restart", out value) && Object.Equals(value, true);
            if (state == "running" && !result.RequiresRestart && item.TryGetValue("can_open", out value) && Object.Equals(value, true) &&
                item.TryGetValue("url", out value) && LocalUrl(value as string)) result.Url = value as string;
            return result;
        }
    }

    private sealed class WorkerResult
    {
        internal int Exit = -1;
        internal string Error, Warning, Url;
        internal bool NeedsSetup;
        internal HostSnapshot Snapshot;
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

    internal void BeginLaunch() { BeginOperation(null, null, false); }
    internal void BeginStatus(bool background = false) { BeginOperation("status", null, background); }

    private async void BeginOperation(string action, string token, bool background)
    {
        if (busy || IsDisposed || dismissed || reviewedAction != null) return;
        int generation = ++operationGeneration;
        statusTimer.Stop();
        automaticOpened = false;
        bool opening = action == null || action == "restart";
        if (!background) { keepRecoveryOpen = false; details.Visible = false; logs.Visible = false; repair.Visible = false; }
        readyUrl = null; primary.Tag = null;
        if (!File.Exists(Path.Combine(root, @"backend\.venv\Scripts\python.exe"))) { SetupNeeded(); return; }
        busy = true; primary.Enabled = false; progress.Visible = !background;
        SetActionAvailability(false);
        if (!background)
        {
            heading.Text = action == "stop" ? "Stopping TLI…" : action == "restart" ? "Restarting TLI…" : "Checking TLI…";
            status.Text = action == "stop" ? "Waiting for the verified background service to stop. This window will confirm when it has closed." :
                action == "restart" ? "Stopping the verified background service, then starting this installation." : "Checking this installation's background service…";
        }
        WorkerResult result = null;
        try
        {
            var work = Task.Run(() => RunWorker(action, token, generation, background));
            int deadline = action == "status" ? Math.Min(workerTimeout, 20000) : action == "stop" ? Math.Min(workerTimeout, 60000) : workerTimeout;
            if (await Task.WhenAny(work, Task.Delay(deadline)).ConfigureAwait(false) != work)
            {
                // Never kill a host or make a shutdown claim because its worker
                // timed out. Ignore all late events and require a fresh check.
                OnUi(delegate
                {
                    if (generation != operationGeneration) return;
                    ++operationGeneration; snapshot = null; busy = false; progress.Visible = false;
                    if (dismissed) { Close(); return; }
                    Failed("TLI did not confirm its state in time. The requested operation may still be finishing. Use Check status before starting an update. This window did not forcibly close any process.");
                    heading.Text = "TLI status is unconfirmed"; primary.Text = "Check status"; primary.Tag = "status";
                    SetActionAvailability(true);
                });
                return;
            }
            result = await work.ConfigureAwait(false);
        }
        catch (Exception error) { result = new WorkerResult { Error = error.Message }; }
        OnUi(delegate { FinishOperation(result, action, generation, background, opening); });
    }

    private void FinishOperation(WorkerResult result, string action, int generation, bool background, bool opening)
    {
        if (generation != operationGeneration) return;
        busy = false; progress.Visible = false;
        if (dismissed) { Close(); return; }
        if (result.NeedsSetup) { SetupNeeded(); return; }
        // A failed worker must never prove shutdown, even if it emitted a state
        // before failing. A verified running snapshot can still offer recovery.
        snapshot = result.Snapshot;
        if (result.Exit != 0 && snapshot != null && snapshot.State == "stopped") snapshot = null;
        if (result.Exit != 0 || (opening && (result.Url == null || (snapshot != null &&
            (snapshot.State != "running" || snapshot.RequiresRestart || snapshot.Url == null)))))
        {
            Failed(result.Error ?? "TLI has not confirmed that it is ready. Check status or open logs for details.");
            return;
        }
        if (snapshot == null && action != null)
        {
            Failed("TLI did not return a verified state. Use Check status before starting an update.");
            heading.Text = "TLI status is unconfirmed"; primary.Text = "Check status"; primary.Tag = "status";
            SetActionAvailability(true);
            return;
        }
        if (snapshot != null) ShowSnapshot(background);
        if (opening)
        {
            if (!String.IsNullOrWhiteSpace(result.Warning)) ReadyWithRuntimeWarning(result.Url, result.Warning);
            else
            {
                CompactView();
                readyUrl = result.Url; heading.Text = "TLI is running"; status.Text = "Opening TLI in your browser…";
                primary.Text = "Open TLI"; primary.Enabled = true;
                SetActionAvailability(true);
            }
            if (!automaticOpened && !dismissed) { automaticOpened = true; OpenBrowser(); }
        }
        if (snapshot != null && snapshot.State == "running") statusTimer.Start();
    }

    private WorkerResult RunWorker(string action, string token, int generation, bool background)
    {
        var result = new WorkerResult();
        using (var process = new Process { StartInfo = WorkerCommand(root, action, token) })
        {
            process.Start(); process.StandardInput.Close();
            var errors = Task.Run(() => ReadErrorTail(process.StandardError));
            var json = new JavaScriptSerializer { MaxJsonLength = 32768 };
            foreach (string line in BoundedLines(process.StandardOutput))
            {
                Dictionary<string, object> item;
                try { item = json.Deserialize<Dictionary<string, object>>(line); }
                catch { continue; }
                if (item == null) continue;
                object raw;
                string kind = item.TryGetValue("event", out raw) ? raw as string : null;
                string message = item.TryGetValue("message", out raw) ? raw as string : null;
                if (kind == "progress" && message != null && !background) OnUi(delegate
                {
                    if (busy && !dismissed && generation == operationGeneration)
                    {
                        status.Text = message;
                        if (action == null) heading.Text = "Starting TLI…";
                    }
                });
                if (kind == "state") result.Snapshot = HostSnapshot.Parse(item);
                if (kind == "setup_required") result.NeedsSetup = true;
                if (kind == "error") result.Error = message;
                if (kind == "warning" && item.TryGetValue("code", out raw) && raw as string == "local_ai_unavailable") result.Warning = message;
                if (kind == "ready" && item.TryGetValue("url", out raw) && LocalUrl(raw as string)) result.Url = raw as string;
            }
            process.WaitForExit(); result.Exit = process.ExitCode;
            string stderr = errors.Result;
            if (result.Error == null && stderr.Length > 0) result.Error = stderr;
        }
        return result;
    }

    private static IEnumerable<string> BoundedLines(StreamReader reader)
    {
        var line = new StringBuilder(); bool overflow = false; int next;
        while ((next = reader.Read()) >= 0)
        {
            if (next == '\n')
            {
                if (!overflow) yield return line.ToString();
                line.Clear(); overflow = false;
            }
            else if (line.Length < 32768) line.Append((char)next);
            else overflow = true;
        }
        if (!overflow && line.Length > 0) yield return line.ToString();
    }

    private static string ReadErrorTail(StreamReader reader)
    {
        var tail = new StringBuilder(); var buffer = new char[2048]; int count;
        while ((count = reader.Read(buffer, 0, buffer.Length)) > 0)
        {
            tail.Append(buffer, 0, count);
            if (tail.Length > 4000) tail.Remove(0, tail.Length - 4000);
        }
        return tail.ToString();
    }

    private void SetActionAvailability(bool available)
    {
        bool valid = available && !busy && reviewedAction == null;
        stop.Visible = valid && snapshot != null && snapshot.CanStop;
        restart.Visible = valid && snapshot != null && (snapshot.State == "stopped" || (snapshot.CanRestart && !snapshot.RequiresRestart));
        restart.Text = snapshot != null && snapshot.State == "stopped" ? "Start TLI" : "Restart TLI";
        check.Visible = available && reviewedAction == null && primary.Text != "Check status";
        check.Enabled = !busy;
        cancelReview.Visible = reviewedAction != null;
    }

    private void ShowSnapshot(bool preserveDetails = false)
    {
        if (snapshot == null) return;
        readyUrl = snapshot.Url;
        if (!preserveDetails) { CompactView(); repair.Visible = false; }
        heading.Text = snapshot.State == "running" ? "TLI is running" : snapshot.State == "stopped" ? "TLI is stopped" :
            snapshot.State == "starting" ? "TLI is starting" : "TLI status is unconfirmed";
        status.Text = snapshot.State == "stopped" ? "The background service has stopped. Close this window before running the updater." :
            snapshot.Message ?? "The background service was checked.";
        primary.Text = snapshot.State == "stopped" ? "Close launcher" : snapshot.RequiresRestart && snapshot.CanRestart ? "Restart TLI" :
            readyUrl != null ? "Open TLI" : "Check status";
        primary.Tag = snapshot.State == "stopped" ? "close" : snapshot.RequiresRestart && snapshot.CanRestart ? "review-restart" : readyUrl != null ? null : "status";
        primary.Enabled = true;
        footer.Text = snapshot.State == "stopped" ? "Closing this window leaves TLI stopped. The updater will check again before changing files." :
            snapshot.State == "running" ? "Closing a browser or this window leaves TLI running. Use Stop TLI here to close its background service." :
            "Check status to verify this installation before running the updater.";
        SetActionAvailability(true);
    }

    private void ReviewAction(string action)
    {
        if (busy || snapshot == null || (action == "stop" ? !snapshot.CanStop : !snapshot.CanRestart)) return;
        statusTimer.Stop(); reviewedAction = action; reviewedToken = snapshot.Token; readyUrl = null;
        heading.Text = action == "stop" ? "Stop TLI?" : "Restart TLI?";
        status.Text = "Finish any active chat, Builder generation, or work from connected devices first.";
        ShowDetails((action == "stop" ? "Stop the TLI background service for this installation. Wait for 'TLI is stopped', then close this launcher before running an update." :
            "Stop the TLI background service, then start it again using this installation's current application files.") +
            Environment.NewLine + Environment.NewLine + "Saved conversations, settings, and paired devices are kept. Active work may be interrupted." +
            Environment.NewLine + Environment.NewLine + "Installation: " + root);
        primary.Tag = "confirm"; primary.Text = action == "stop" ? "Stop TLI now" : "Restart TLI now";
        repair.Visible = false; progress.Visible = false; SetActionAvailability(false); cancelReview.Visible = true;
        footer.Text = "Only this installation's verified process can be stopped. TLI checks ownership again before acting.";
        primary.Focus();
    }

    private void ConfirmAction()
    {
        if (reviewedAction == null || busy) return;
        string action = reviewedAction, token = reviewedToken;
        reviewedAction = null; reviewedToken = null; cancelReview.Visible = false;
        BeginOperation(action, token, false);
    }

    private void CancelReview()
    {
        reviewedAction = null; reviewedToken = null; cancelReview.Visible = false;
        BeginStatus();
    }

    internal void SetupNeeded()
    {
        snapshot = null; statusTimer.Stop(); SetActionAvailability(false);
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
        progress.Visible = false; primary.Tag = null; primary.Text = "Try again"; primary.Enabled = true;
        if (snapshot != null) ShowSnapshot();
        else { SetActionAvailability(true); footer.Text = "Check status to verify whether TLI is running before starting an update."; }
        ShowDetails(message); logs.Visible = true;
    }

    internal void ReadyWithRuntimeWarning(string url, string message)
    {
        if (!LocalUrl(url)) { Failed("TLI did not confirm a local address that is ready to open."); return; }
        readyUrl = url; keepRecoveryOpen = true; heading.Text = "TLI is running";
        status.Text = "Opening your TLI workspace. Local AI needs attention; the details below remain available while you finish setup.";
        repair.Visible = true; logs.Visible = true; ShowDetails(message);
        progress.Visible = false; primary.Tag = null; primary.Text = "Open TLI"; primary.Enabled = true;
        footer.Text = "Closing a browser or this window leaves TLI running. Use Stop TLI here to close its background service.";
        SetActionAvailability(true);
        primary.Focus();
    }

    private void ShowDetails(string message)
    {
        // The old fixed-height dialog left only three lines for recovery steps.
        // Keep normal startup compact, and reserve readable space for a problem.
        MinimumSize = SizeFromClientSize(new Size(560, 620));
        ClientSize = new Size(Math.Max(ClientSize.Width, 620), Math.Max(ClientSize.Height, 650));
        details.Text = (message ?? "No further details were provided.").Replace("\r\n", "\n").Replace("\n", Environment.NewLine); details.Visible = true;
        details.SelectionStart = 0; details.SelectionLength = 0; details.ScrollToCaret();
    }

    private void CompactView()
    {
        details.Visible = false;
        MinimumSize = SizeFromClientSize(new Size(560, 400));
        ClientSize = new Size(Math.Max(560, Math.Min(ClientSize.Width, 620)), 448);
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
            else
            {
                heading.Text = "TLI is running";
                status.Text = "Your workspace is open in the browser. Use Stop TLI below when you need to close its background service.";
                primary.Text = "Open TLI again";
            }
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
        statusTimer.Stop(); SetActionAvailability(false);
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

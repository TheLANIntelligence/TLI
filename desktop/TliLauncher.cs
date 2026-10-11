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
    private readonly Button primary, shortcuts, logs;
    private readonly TextBox details;
    private bool busy, dismissed;
    private string readyUrl;
    private readonly Action<string> browser;
    private readonly Color ink, accent, muted, surface, onAccent, accentHover;

    internal TliWindow(string installation, bool autoStart = true, Action<string> openBrowser = null, bool? darkAppearance = null)
    {
        root = Path.GetFullPath(installation);
        browser = openBrowser ?? (url => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }));
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
        Text = "TLI";
        ClientSize = new Size(560, 448);
        MinimumSize = new Size(530, 480);
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = highContrast ? SystemColors.Window : dark ? Color.FromArgb(16, 23, 25) : Color.FromArgb(244, 247, 246);
        ForeColor = ink;
        Font = new Font("Segoe UI", 10);
        MaximizeBox = false;
        try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(32), ColumnCount = 1, RowCount = 8 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 84));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 60));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 4));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        Controls.Add(layout);
        var name = new Label { Text = "TLI", Font = new Font("Segoe UI", 28, FontStyle.Bold), AutoSize = true, ForeColor = accent, Margin = new Padding(0, 0, 0, 5) };
        var identity = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Margin = Padding.Empty };
        identity.Controls.Add(name);
        identity.Controls.Add(new Label { Text = "Your private AI. On your network.", AutoSize = true, ForeColor = muted, Margin = Padding.Empty });
        layout.Controls.Add(identity, 0, 0);

        heading = new Label { Text = "Opening TLI", Font = new Font("Segoe UI", 15, FontStyle.Bold), Dock = DockStyle.Fill, Margin = Padding.Empty };
        status = new Label { Text = "Checking this installation…", Dock = DockStyle.Fill, ForeColor = muted, Margin = Padding.Empty };
        progress = new ProgressBar { Dock = DockStyle.Fill, Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 30, Margin = Padding.Empty };
        details = new TextBox { Dock = DockStyle.Fill, ReadOnly = true, Multiline = true, ScrollBars = ScrollBars.Vertical, Visible = false, BackColor = BackColor, ForeColor = ink, BorderStyle = BorderStyle.None, Font = new Font("Segoe UI", 9), Margin = new Padding(0, 12, 0, 12) };
        layout.Controls.Add(heading, 0, 1); layout.Controls.Add(status, 0, 2); layout.Controls.Add(progress, 0, 3); layout.Controls.Add(details, 0, 4);
        primary = new Button { Text = "Open TLI", Dock = DockStyle.Fill, FlatStyle = FlatStyle.Flat, BackColor = accent, ForeColor = onAccent, Enabled = false, Cursor = Cursors.Hand, Font = new Font("Segoe UI", 10, FontStyle.Bold), Margin = Padding.Empty };
        primary.FlatAppearance.BorderSize = 0;
        primary.FlatAppearance.MouseOverBackColor = accentHover;
        primary.FlatAppearance.MouseDownBackColor = accentHover;
        primary.Click += delegate { if (!busy) { if (primary.Tag as string == "setup") RunSetup(); else if (readyUrl != null) OpenBrowser(); else BeginLaunch(); } };
        layout.Controls.Add(primary, 0, 5);
        var links = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, Margin = Padding.Empty };
        shortcuts = LinkButton("Add Desktop & Start Menu shortcuts");
        shortcuts.Click += delegate { AddShortcuts(); };
        logs = LinkButton("Open logs"); logs.Visible = false;
        logs.Click += delegate { OpenLogFolder(); };
        links.Controls.Add(shortcuts); links.Controls.Add(logs); layout.Controls.Add(links, 0, 6);
        footer = new Label { Text = "TLI runs in the background. Use its Device menu to Restart or Quit.", Dock = DockStyle.Fill, Font = new Font("Segoe UI", 9), ForeColor = muted, Padding = new Padding(0, 7, 0, 0), Margin = Padding.Empty };
        layout.Controls.Add(footer, 0, 7);
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
        OnUi(delegate { dismissed = false; Show(); WindowState = FormWindowState.Normal; Activate(); });
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

    internal async void BeginLaunch()
    {
        if (busy) return;
        readyUrl = null; details.Visible = false; logs.Visible = false; primary.Tag = null;
        if (!File.Exists(Path.Combine(root, @"backend\.venv\Scripts\python.exe"))) { SetupNeeded(); return; }
        busy = true; primary.Enabled = false; progress.Visible = true;
        heading.Text = "Opening TLI"; status.Text = "Checking whether TLI is already running…";
        string workerError = null, url = null; bool needsSetup = false; int exit = -1;
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
                        if (kind == "progress" && message != null) OnUi(delegate { status.Text = message; });
                        if (kind == "setup_required") needsSetup = true;
                        if (kind == "error") workerError = message;
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
        readyUrl = url; heading.Text = "TLI is ready"; status.Text = "Opening TLI in your browser…";
        primary.Text = "Open TLI"; primary.Enabled = true;
        OpenBrowser();
    }

    internal void SetupNeeded()
    {
        heading.Text = "Welcome to TLI";
        status.Text = "One-time setup is needed on this computer. Setup opens an installation window and may download Python and required packages.";
        progress.Visible = false; primary.Text = "Set up TLI"; primary.Tag = "setup"; primary.Enabled = true;
        footer.Text = "After setup, use TLI from your Desktop or Start Menu.";
    }

    internal void Failed(string message)
    {
        heading.Text = "TLI could not open"; status.Text = "Review the details below, then try again.";
        details.Text = message; details.Visible = true; logs.Visible = true;
        progress.Visible = false; primary.Tag = null; primary.Text = "Try again"; primary.Enabled = true;
    }

    private void OpenBrowser()
    {
        if (!LocalUrl(readyUrl)) return;
        try { browser(readyUrl); Close(); }
        catch (Exception error) { status.Text = "Your browser could not open automatically. Open " + readyUrl; details.Text = error.Message; details.Visible = true; }
    }

    private async void RunSetup()
    {
        busy = true; primary.Enabled = false; progress.Visible = true;
        heading.Text = "Setting up TLI"; status.Text = "Follow the installation window. TLI will open when it is ready.";
        try
        {
            var start = new ProcessStartInfo(Path.Combine(root, "TLI_Start.bat")) { UseShellExecute = true, WorkingDirectory = root };
            using (var process = Process.Start(start))
            {
                if (process == null) throw new InvalidOperationException("The setup window could not be opened.");
                await Task.Run(() => process.WaitForExit());
                if (process.ExitCode != 0) throw new InvalidOperationException("Setup did not finish successfully. Reopen setup and check the message in its installation window.");
            }
            busy = false; progress.Visible = false;
            if (dismissed) { Close(); return; }
            heading.Text = "Setup window closed"; status.Text = "If setup completed, TLI is open in your browser. You can open it again below.";
            primary.Tag = null; primary.Text = "Open TLI"; primary.Enabled = true;
        }
        catch (Exception error) { busy = false; if (dismissed) Close(); else Failed(error.Message); }
    }

    private async void AddShortcuts()
    {
        shortcuts.Enabled = false;
        try
        {
            var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
                "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(root, "TLI_Setup.ps1") + "\" -Action CreateShortcuts")
                { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = root };
            using (var process = Process.Start(start))
            {
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

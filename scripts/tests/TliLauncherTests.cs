// Compiled with the production C# source; all worker responses are synthetic.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

internal static class LauncherTests
{
    private static TliWindow Window(string root, Action<string> browser = null,
        Func<ProcessStartInfo> setup = null, Func<ProcessStartInfo> shortcuts = null, int workerTimeout = 380000)
    {
        return new TliWindow(root, false, browser, null, setup, shortcuts, workerTimeout) { StartPosition = FormStartPosition.Manual, Location = new Point(-20000, -20000), ShowInTaskbar = false };
    }
    private static ProcessStartInfo FixtureCommand(string root, string script)
    {
        var command = TliWindow.WorkerCommand(root);
        command.Arguments = "\"" + script + "\"";
        return command;
    }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static Button Action(TliWindow form, string text)
    {
        return Descendants(form).OfType<Button>().Single(b => b.Visible && b.Text == text);
    }
    private static IEnumerable<Control> Descendants(Control root)
    {
        foreach (Control child in root.Controls) { yield return child; foreach (Control nested in Descendants(child)) yield return nested; }
    }
    private static void Pump(Func<bool> done)
    {
        var time = Stopwatch.StartNew();
        while (!done() && time.ElapsedMilliseconds < 15000) { Application.DoEvents(); Thread.Sleep(10); }
        Check(done(), "Native worker did not finish within test deadline.");
    }
    private static void Capture(TliWindow form, string name, string output)
    {
        using (var bitmap = new Bitmap(form.Width, form.Height))
        { form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size)); bitmap.Save(Path.Combine(output, name + ".png")); }
    }
    private static void ReadableRecovery(TliWindow form)
    {
        form.PerformLayout(); Application.DoEvents();
        var text = Descendants(form).OfType<TextBox>().Single(t => t.Visible);
        Check(text.ClientSize.Height >= text.Font.Height * 7, "Recovery details must show at least seven lines");
        Check(text.SelectionStart == 0, "Recovery details must start at the beginning");
        foreach (var button in Descendants(form).OfType<Button>().Where(b => b.Visible))
            Check(button.Left >= 0 && button.Top >= 0 && button.Right <= button.Parent.ClientSize.Width && button.Bottom <= button.Parent.ClientSize.Height,
                "Recovery action is clipped: " + button.Text);
    }
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string root = args[0], output = args[1];
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Check(TliWindow.LocalUrl("https://localhost:8000"), "Local TLS URL rejected");
            Check(TliWindow.LocalUrl("http://127.0.0.1:8123"), "Local HTTP URL rejected");
            foreach (string url in new[] { "https://example.com", "file:///C:/file", "javascript:alert(1)", "https://user:secret@localhost", "not a url", null })
                Check(!TliWindow.LocalUrl(url), "Unexpected launcher URL accepted");
            var command = TliWindow.WorkerCommand(root);
            Check(!command.UseShellExecute && command.CreateNoWindow && command.RedirectStandardError && command.RedirectStandardOutput, "Worker must not create a console or block on pipes");
            Check(command.Arguments == "\"" + Path.Combine(root, @"backend\desktop_launcher.py") + "\"", "Worker quoting changed");
            Check(!command.EnvironmentVariables.ContainsKey("TLI_ROOT") && !command.EnvironmentVariables.ContainsKey("PYTHONPATH"), "Inherited Python/root overrides leaked");
            string token = new string('a', 64);
            Check(TliWindow.WorkerCommand(root, "status").Arguments.EndsWith(" --status"), "Status must use the fixed read-only worker action");
            Check(TliWindow.WorkerCommand(root, "stop", token).Arguments.EndsWith(" --stop " + token), "Stop must carry the reviewed token");
            foreach (string invalid in new[] { "restart;taskkill", "--stop", "launch" })
            {
                bool rejected = false;
                try { TliWindow.WorkerCommand(root, invalid, token); } catch (ArgumentException) { rejected = true; }
                Check(rejected, "Unknown worker action accepted");
            }
            foreach (string invalid in new[] { "", "a", new string('a', 63) + "&", null })
            {
                bool rejected = false;
                try { TliWindow.WorkerCommand(root, "stop", invalid); } catch (ArgumentException) { rejected = true; }
                Check(rejected, "Invalid worker token accepted");
            }
            foreach (string key in new[] { "TLI_HOST", "TLI_PORT", "TLI_ENABLE_TLS", "TLI_LAN_MODE" })
            {
                string previous = Environment.GetEnvironmentVariable(key);
                try
                {
                    Environment.SetEnvironmentVariable(key, "synthetic inherited override");
                    Check(!TliWindow.WorkerCommand(root).EnvironmentVariables.ContainsKey(key), "Inherited listener override leaked: " + key);
                }
                finally { Environment.SetEnvironmentVariable(key, previous); }
            }
            var setupCommand = TliWindow.SetupCommand(root);
            Check(setupCommand.FileName == Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"), "Setup must use the fixed Windows PowerShell executable");
            Check(setupCommand.Arguments == "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(root, "TLI_Bootstrap.ps1") + "\" -SetupOnly", "Native setup must prepare without opening an unverified browser");
            Check(setupCommand.WorkingDirectory == root && !setupCommand.UseShellExecute && setupCommand.CreateNoWindow && setupCommand.RedirectStandardInput && setupCommand.RedirectStandardOutput && setupCommand.RedirectStandardError, "Setup must be hidden with captured output");
            var shortcutCommand = TliWindow.ShortcutCommand(root);
            Check(shortcutCommand.FileName == setupCommand.FileName && shortcutCommand.Arguments == "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(root, "TLI_Setup.ps1") + "\" -Action CreateShortcuts", "Shortcut creation must use the fixed setup script");
            Check(!shortcutCommand.UseShellExecute && shortcutCommand.CreateNoWindow && shortcutCommand.RedirectStandardOutput && shortcutCommand.RedirectStandardError, "Shortcut setup must be hidden with captured output");
            using (var form = Window(root))
            {
                form.Show(); Application.DoEvents(); Capture(form, "starting", output);
                form.SetupNeeded(); Application.DoEvents(); Capture(form, "setup", output);
                Check(Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Set up TLI"), "Setup action is missing");
                form.Failed("The saved port is occupied by a different application. Nothing was stopped.\r\n\r\nOpen the logs to review the startup details. Close the other program or select an available address in TLI's startup settings, then try again.\r\n\r\nA missing local AI dependency must be reported separately from workspace availability.");
                Application.DoEvents(); Capture(form, "error", output);
                ReadableRecovery(form);
                form.Size = form.MinimumSize; ReadableRecovery(form);
                Check(Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Try again"), "Error recovery is missing");
                form.Close();
            }
            string worker = Path.Combine(root, @"backend\desktop_launcher.py");
            var opened = new List<string>();
            File.WriteAllText(worker, "import json,time\nprint(json.dumps({'event':'progress','message':'Preparing local AI…'}),flush=True)\ntime.sleep(.2)\nprint(json.dumps({'event':'ready','url':'https://localhost:8000'}),flush=True)\n");
            using (var form = Window(root, opened.Add))
            {
                form.Show(); form.BeginLaunch(); form.BeginLaunch();
                Pump(() => opened.Count == 1 && Descendants(form).OfType<Button>().Any(b => b.Enabled && b.Text == "Open TLI again"));
                Check(!form.IsDisposed, "Running controls must remain available after opening the browser"); form.Close();
            }
            Check(opened.Count == 1 && opened[0] == "https://localhost:8000", "Verified worker should open one browser only");
            opened.Clear();
            File.WriteAllText(worker, "import json\nprint(json.dumps({'event':'warning','code':'local_ai_unavailable','message':'The packaged local AI engine could not start. Windows may need the Microsoft Visual C++ v14 Redistributable (x64).\\n\\nOpen the Microsoft setup guidance, install or repair the x64 package, then restart TLI. If it still fails, check the runtime details in the logs.\\n\\nYour TLI workspace is available; local AI readiness is checked separately.'}),flush=True)\nprint(json.dumps({'event':'ready','url':'https://localhost:8000'}),flush=True)\n");
            using (var form = Window(root, opened.Add))
            {
                form.Show(); form.BeginLaunch();
                Pump(() => Descendants(form).OfType<Button>().Any(b => b.Text == "Microsoft Visual C++ setup guidance" && b.Visible));
                Check(opened.SequenceEqual(new[] { "https://localhost:8000" }), "Local AI warning must not block automatic verified workspace entry");
                ReadableRecovery(form); Capture(form, "local-ai-recovery", output);
                form.Size = form.MinimumSize; ReadableRecovery(form); Capture(form, "local-ai-recovery-minimum", output);
                form.ShowAgain(); form.ShowAgain();
                Pump(() => opened.Count == 2 && Descendants(form).OfType<Button>().Any(b => b.Text == "Open TLI again" && b.Enabled));
                Check(opened.SequenceEqual(new[] { "https://localhost:8000", "https://localhost:8000" }), "A new explicit launch should reverify and open once while an advisory remains");
                var help = Descendants(form).OfType<Button>().Single(b => b.Text == "Microsoft Visual C++ setup guidance");
                help.PerformClick();
                Check(opened.SequenceEqual(new[] { "https://localhost:8000", "https://localhost:8000", TliWindow.RuntimeHelpUrl }) && !form.IsDisposed, "Repair should open only the fixed Microsoft page, retaining setup");
                var enter = Descendants(form).OfType<Button>().Single(b => b.Text == "Open TLI again");
                enter.PerformClick();
                Check(!form.IsDisposed && opened.SequenceEqual(new[] { "https://localhost:8000", "https://localhost:8000", TliWindow.RuntimeHelpUrl, "https://localhost:8000" }), "Explicit workspace reopen should retain advice and use the verified local URL");
                File.WriteAllText(worker, "import json,sys\nprint(json.dumps({'event':'error','message':'Synthetic ownership changed'}),flush=True)\nsys.exit(1)\n");
                form.ShowAgain();
                Pump(() => Descendants(form).OfType<Button>().Any(b => b.Text == "Try again" && b.Enabled));
                Check(opened.Count == 4, "Reopening the launcher must not reuse a stale ready URL after verification fails");
                form.Close();
            }
            opened.Clear();
            using (var form = Window(root, opened.Add))
            {
                form.Show(); form.ReadyWithRuntimeWarning("https://example.com", "Synthetic warning");
                Check(opened.Count == 0 && Descendants(form).OfType<Button>().Any(b => b.Text == "Try again" && b.Visible), "An advisory must not authorize an unverified URL");
                form.Close();
            }
            File.WriteAllText(worker, "import json,sys\nprint(json.dumps({'event':'ready','url':'https://localhost:8000'}),flush=True)\nprint(json.dumps({'event':'error','message':'Synthetic failure'}),flush=True)\nsys.stderr.write('x'*90000)\nsys.exit(1)\n");
            using (var form = Window(root, opened.Add))
            {
                form.Show(); form.BeginLaunch();
                Pump(() => Descendants(form).OfType<Button>().Any(b => b.Text == "Try again" && b.Enabled));
                Check(opened.Count == 0, "Failed launch opened browser"); form.Close();
            }
            File.WriteAllText(worker, "import json,time\ntime.sleep(.3)\nprint(json.dumps({'event':'ready','url':'https://localhost:8000'}),flush=True)\n");
            using (var form = Window(root, opened.Add))
            { form.Show(); form.BeginLaunch(); form.Close(); Pump(() => form.IsDisposed); }
            Check(opened.Count == 0, "Closing startup must not open the browser later");
            File.WriteAllText(worker, "import json,time\nprint(json.dumps({'event':'warning','code':'local_ai_unavailable','message':'Synthetic optional warning'}),flush=True)\ntime.sleep(.3)\nprint(json.dumps({'event':'ready','url':'https://localhost:8000'}),flush=True)\n");
            using (var form = Window(root, opened.Add))
            { form.Show(); form.BeginLaunch(); form.Close(); Pump(() => form.IsDisposed); }
            Check(opened.Count == 0, "Closing a launch with an advisory must prevent a late browser open");

            // A release mismatch stays actionable. Only an explicit second
            // click submits the exact reviewed token; state checks never act.
            string invocationLog = Path.Combine(root, "synthetic-actions.txt");
            string stoppedMarker = Path.Combine(root, "synthetic-stopped.txt");
            string state = "{'event':'state','state':'running','message':'This installation is running with older application files. Restart to open the current release.','can_stop':True,'can_restart':True,'can_open':False,'requires_restart':True,'action_token':'" + token + "'}";
            string lifecycleFixture = "import json,pathlib,sys,time\n" +
                "s=" + state + "\n" +
                "with pathlib.Path('synthetic-actions.txt').open('a') as f: f.write(' '.join(sys.argv[1:])+'\\n')\n" +
                "if sys.argv[1:]==['--stop','" + token + "']:\n print(json.dumps({'event':'progress','message':'Waiting for the verified process to stop…'}),flush=True)\n time.sleep(.2)\n pathlib.Path('synthetic-stopped.txt').write_text('stopped')\n print(json.dumps({'event':'state','state':'stopped','can_stop':False,'can_restart':False,'can_open':False}),flush=True)\n" +
                "elif sys.argv[1:]==['--restart','" + token + "']:\n s.update(requires_restart=False,can_open=True,url='https://localhost:8000')\n print(json.dumps(s),flush=True)\n print(json.dumps({'event':'ready','url':'https://localhost:8000'}),flush=True)\n" +
                "elif sys.argv[1:]==['--status']:\n print(json.dumps(s),flush=True)\n" +
                "else:\n print(json.dumps(s),flush=True)\n print(json.dumps({'event':'error','message':'The running process has older application files. Restart this installation to continue.'}),flush=True)\n sys.exit(1)\n";
            if (File.Exists(invocationLog)) File.Delete(invocationLog);
            if (File.Exists(stoppedMarker)) File.Delete(stoppedMarker);
            File.WriteAllText(worker, lifecycleFixture);
            using (var form = Window(root, opened.Add))
            {
                form.Show(); form.BeginLaunch();
                Pump(() => Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Stop TLI"));
                Check(opened.Count == 0 && Descendants(form).OfType<Label>().Any(l => l.Text == "TLI is running"), "Mismatch must show running and allow verified lifecycle recovery");
                Check(Action(form, "Restart TLI").Enabled, "Mismatch needs a direct restart action");
                Capture(form, "running-needs-restart", output); ReadableRecovery(form);
                Action(form, "Stop TLI").PerformClick();
                Check(!File.Exists(stoppedMarker) && !File.ReadAllText(invocationLog).Contains("--stop"), "Opening review must not stop a process");
                Check(Descendants(form).OfType<TextBox>().Single(t => t.Visible).Text.Contains(root), "Review must identify the exact installation");
                Capture(form, "review-stop", output); form.Size = form.MinimumSize; ReadableRecovery(form);
                Action(form, "Cancel").PerformClick();
                Pump(() => Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Stop TLI"));
                Check(File.ReadAllText(invocationLog).Contains("--status") && !File.Exists(stoppedMarker), "Cancel must only refresh status");
                Action(form, "Stop TLI").PerformClick(); Action(form, "Stop TLI now").PerformClick();
                Check(Descendants(form).OfType<Label>().Any(l => l.Text == "Stopping TLI…") && !Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Stop TLI"), "Stopping must show bounded progress with actions disabled");
                Pump(() => Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Close launcher"));
                Check(File.Exists(stoppedMarker) && File.ReadAllText(invocationLog).Contains("--stop " + token), "Confirmed stop must submit only its reviewed token");
                Check(opened.Count == 0 && Descendants(form).OfType<Label>().Any(l => l.Text == "TLI is stopped"), "Only completed stop may show stopped");
                Check(Descendants(form).OfType<Label>().Any(l => l.Text.Contains("Close this window before running the updater")), "Stopped must explain the launcher also needs closing for the updater");
                Check(Action(form, "Start TLI").Enabled, "Stopped launcher must offer explicit start");
                Capture(form, "stopped", output); Action(form, "Close launcher").PerformClick();
                Check(form.IsDisposed, "Close launcher must close without starting TLI");
            }
            using (var form = Window(root, opened.Add))
            {
                form.Show(); form.BeginLaunch();
                Pump(() => Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Stop TLI"));
                Action(form, "Restart TLI").PerformClick();
                Check(!File.ReadAllText(invocationLog).Contains("--restart"), "Restart requires review before execution");
                Action(form, "Restart TLI now").PerformClick();
                Pump(() => opened.Count == 1 && Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Stop TLI"));
                Check(File.ReadAllText(invocationLog).Contains("--restart " + token), "Restart must submit its reviewed token");
                Capture(form, "running-controls", output);
                form.BeginStatus();
                Pump(() => Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Stop TLI"));
                Check(opened.Count == 1, "A status refresh must never open a browser or relaunch");
                form.Close();
            }
            opened.Clear();
            using (var form = Window(root, opened.Add))
            {
                File.WriteAllText(worker, lifecycleFixture); form.Show(); form.BeginLaunch();
                Pump(() => Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Stop TLI"));
                Action(form, "Stop TLI").PerformClick();
                File.WriteAllText(worker, "import json,sys\nprint(json.dumps({'event':'state','state':'unverified','message':'The reviewed process changed. Check status and review again.','can_stop':False,'can_restart':False}),flush=True)\nprint(json.dumps({'event':'error','message':'Stale review was rejected.'}),flush=True)\nsys.exit(1)\n");
                Action(form, "Stop TLI now").PerformClick();
                Pump(() => Descendants(form).OfType<Label>().Any(l => l.Text == "TLI status is unconfirmed"));
                Check(!Descendants(form).OfType<Button>().Any(b => b.Visible && b.Text == "Stop TLI") && opened.Count == 0, "Changed ownership must remove authority and never claim stopped"); form.Close();
            }
            File.WriteAllText(worker, "import json,sys\nprint(json.dumps({'event':'state','state':'stopped'}),flush=True)\nsys.exit(1)\n");
            using (var form = Window(root, opened.Add))
            {
                form.Show(); form.BeginStatus();
                Pump(() => Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Try again"));
                Check(!Descendants(form).OfType<Label>().Any(l => l.Text == "TLI is stopped"), "An unsuccessful worker cannot confirm stopped"); form.Close();
            }
            File.WriteAllText(worker, "import json\ns=" + state.Replace(token, "untrusted&token") + "\nprint(json.dumps(s),flush=True)\n");
            using (var form = Window(root, opened.Add))
            {
                form.Show(); form.BeginStatus();
                Pump(() => Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Check status"));
                Check(!Descendants(form).OfType<Button>().Any(b => b.Visible && (b.Text == "Stop TLI" || b.Text == "Restart TLI")), "Malformed tokens cannot grant lifecycle actions"); form.Close();
            }
            string lateMarker = Path.Combine(root, "synthetic-late-result.txt");
            if (File.Exists(lateMarker)) File.Delete(lateMarker);
            File.WriteAllText(worker, "import json,time,pathlib\ntime.sleep(.6)\nprint(json.dumps({'event':'state','state':'stopped'}),flush=True)\nprint(json.dumps({'event':'ready','url':'https://localhost:8000'}),flush=True)\npathlib.Path('synthetic-late-result.txt').write_text('finished')\n");
            using (var form = Window(root, opened.Add, workerTimeout: 100))
            {
                form.Show(); form.BeginStatus();
                Pump(() => Descendants(form).OfType<Label>().Any(l => l.Text == "TLI status is unconfirmed"));
                Pump(() => File.Exists(lateMarker)); Application.DoEvents();
                Check(opened.Count == 0 && !Descendants(form).OfType<Label>().Any(l => l.Text == "TLI is stopped"), "Timed-out workers must not publish stale stopped or browser readiness");
                Check(Action(form, "Check status").Enabled, "Timeout needs an explicit fresh status check"); form.Close();
            }

            // Both injected commands are disposable Python scripts. These tests
            // never run the real bootstrap, installers, or shortcut creation.
            string setup = Path.Combine(root, "synthetic_setup.py"), shortcuts = Path.Combine(root, "synthetic_shortcuts.py");
            string setupLog = Path.Combine(root, @"data\host_control\setup.log");
            string phaseCompleted = Path.Combine(root, "synthetic-phase-finished");
            if (File.Exists(phaseCompleted)) File.Delete(phaseCompleted);
            File.WriteAllText(setup, "import pathlib,sys,time\nprint('TLI_SETUP_PROGRESS:Preparing synthetic components',flush=True)\nprint('PRIVATE PACKAGE DIAGNOSTIC',flush=True)\ntime.sleep(.6)\npathlib.Path('synthetic-phase-finished').write_text('finished')\nfor i in range(400): sys.stderr.write('x'*4096+'\\n')\nsys.stderr.flush()\nprint('TLI_SETUP_PROGRESS:Setup finished',flush=True)\n");
            File.WriteAllText(shortcuts, "print('SYNTHETIC_SHORTCUTS_ADDED',flush=True)\n");
            File.WriteAllText(worker, "import json\nprint(json.dumps({'event':'setup_required','message':'Synthetic setup needed'}),flush=True)\n");
            using (var form = Window(root, opened.Add, () => FixtureCommand(root, setup), () => FixtureCommand(root, shortcuts)))
            {
                form.Show(); form.BeginLaunch();
                Pump(() => Descendants(form).OfType<Button>().Any(b => b.Text == "Set up TLI" && b.Enabled));
                File.WriteAllText(worker, "import json\nprint(json.dumps({'event':'ready','url':'https://localhost:8000'}),flush=True)\nprint(json.dumps({'event':'ready','url':'https://localhost:8000'}),flush=True)\n");
                Descendants(form).OfType<Button>().Single(b => b.Text == "Set up TLI").PerformClick();
                Pump(() => Descendants(form).OfType<Label>().Any(l => l.Text == "Preparing synthetic components"));
                Check(!File.Exists(phaseCompleted), "Short progress phases must appear while setup is waiting, before completion");
                Check(!Descendants(form).OfType<Label>().Any(l => l.Text.Contains("PRIVATE PACKAGE DIAGNOSTIC")), "Package output must remain in setup.log");
                Pump(() => opened.Count == 1 && Descendants(form).OfType<Button>().Any(b => b.Enabled && b.Text == "Open TLI again"));
                form.Close();
            }
            Check(opened.SequenceEqual(new[] { "https://localhost:8000" }), "Successful setup must verify and open once despite duplicate ready events");
            Check(new FileInfo(setupLog).Length <= TliWindow.SetupLogLimit, "Setup output must remain bounded");
            Check(File.ReadAllText(setupLog).Contains("SYNTHETIC_SHORTCUTS_ADDED"), "Setup must retain recent diagnostics and create shortcuts");
            opened.Clear();
            File.WriteAllText(setup, "import sys\nprint('SYNTHETIC_SETUP_FAILED',flush=True)\nsys.exit(7)\n");
            using (var form = Window(root, opened.Add, () => FixtureCommand(root, setup), () => FixtureCommand(root, shortcuts)))
            {
                form.Show(); form.SetupNeeded();
                Descendants(form).OfType<Button>().Single(b => b.Text == "Set up TLI").PerformClick();
                Pump(() => Descendants(form).OfType<Button>().Any(b => b.Text == "Try again" && b.Enabled));
                Check(opened.Count == 0, "Failed setup must not launch or open TLI");
                Check(Descendants(form).OfType<TextBox>().Single(t => t.Visible).Text.Contains("setup.log"), "Setup failure must identify its captured log");
                Check(File.ReadAllText(setupLog).Contains("SYNTHETIC_SETUP_FAILED") && !File.ReadAllText(setupLog).Contains("SYNTHETIC_SHORTCUTS_ADDED"), "Failed setup must preserve evidence and skip shortcuts");
                form.Close();
            }
            File.WriteAllText(setup, "import time\nprint('TLI_SETUP_PROGRESS:Preparing synthetic components',flush=True)\ntime.sleep(.3)\n");
            using (var form = Window(root, opened.Add, () => FixtureCommand(root, setup), () => FixtureCommand(root, shortcuts)))
            {
                form.Show(); form.SetupNeeded();
                Descendants(form).OfType<Button>().Single(b => b.Text == "Set up TLI").PerformClick();
                form.Close(); Pump(() => form.IsDisposed);
            }
            Check(opened.Count == 0, "Closing during setup must prevent automatic launch afterward");
            File.WriteAllText(setup, "print('TLI_SETUP_PROGRESS:Setup finished',flush=True)\n");
            File.WriteAllText(shortcuts, "import sys\nprint('SYNTHETIC_SHORTCUT_FAILURE',flush=True)\nsys.exit(3)\n");
            using (var form = Window(root, opened.Add, () => FixtureCommand(root, setup), () => FixtureCommand(root, shortcuts)))
            {
                form.Show(); form.SetupNeeded();
                Descendants(form).OfType<Button>().Single(b => b.Text == "Set up TLI").PerformClick();
                Pump(() => opened.Count == 1 && Descendants(form).OfType<Button>().Any(b => b.Enabled && b.Text == "Open TLI again"));
                form.Close();
            }
            Check(opened.Count == 1 && File.ReadAllText(setupLog).Contains("Shortcut creation did not finish (exit 3)"), "Optional shortcut failure must be logged without blocking verified startup");
            opened.Clear();
            string linkedRoot = Path.Combine(root, "Synthetic linked setup"), linkedTarget = Path.Combine(root, "Synthetic log target");
            Directory.CreateDirectory(linkedRoot); Directory.CreateDirectory(linkedTarget);
            string linkedData = Path.Combine(linkedRoot, "data");
            var junctionCommand = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
                "/d /c mklink /J \"" + linkedData + "\" \"" + linkedTarget + "\"")
                { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            using (var process = Process.Start(junctionCommand))
            {
                string junctionOutput = process.StandardOutput.ReadToEnd(), junctionError = process.StandardError.ReadToEnd();
                process.WaitForExit(); Check(process.ExitCode == 0, "Synthetic junction could not be prepared: " + junctionOutput + junctionError);
            }
            try
            {
                int setupInvocations = 0;
                using (var form = Window(linkedRoot, opened.Add, () => { setupInvocations++; return FixtureCommand(root, setup); }, () => FixtureCommand(root, shortcuts)))
                {
                    form.Show(); form.SetupNeeded();
                    Descendants(form).OfType<Button>().Single(b => b.Text == "Set up TLI").PerformClick();
                    Pump(() => Descendants(form).OfType<Button>().Any(b => b.Text == "Try again" && b.Enabled));
                    Check(setupInvocations == 0 && opened.Count == 0 && Directory.GetFileSystemEntries(linkedTarget).Length == 0, "Linked setup state must fail before running setup or writing through a junction");
                    form.Close();
                }
            }
            finally { Directory.Delete(linkedData); }
            Console.WriteLine("PASS: retained running controls; mismatch restart/stop recovery; explicit action review and exact tokens; cancel only checks status; confirmed stop and close-launcher handoff; restart opens once; refresh never relaunches; stale ownership, malformed tokens, failed stopped claims and late timeout results rejected; readable native recovery at default/minimum size; optional runtime warning; URL boundary; hidden worker/setup; bounded output; setup/shortcut failures; close during startup/setup.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}

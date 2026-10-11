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
    private static TliWindow Window(string root, Action<string> browser = null)
    {
        return new TliWindow(root, false, browser) { StartPosition = FormStartPosition.Manual, Location = new Point(-20000, -20000), ShowInTaskbar = false };
    }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
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
            using (var form = Window(root))
            {
                form.Show(); Application.DoEvents(); Capture(form, "starting", output);
                form.SetupNeeded(); Application.DoEvents(); Capture(form, "setup", output);
                Check(Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Set up TLI"), "Setup action is missing");
                form.Failed("The saved port is occupied by a different application. Nothing was stopped.");
                Application.DoEvents(); Capture(form, "error", output);
                Check(Descendants(form).OfType<Button>().Any(b => b.Visible && b.Enabled && b.Text == "Try again"), "Error recovery is missing");
                form.Close();
            }
            string worker = Path.Combine(root, @"backend\desktop_launcher.py");
            var opened = new List<string>();
            File.WriteAllText(worker, "import json,time\nprint(json.dumps({'event':'progress','message':'Preparing local AI…'}),flush=True)\ntime.sleep(.2)\nprint(json.dumps({'event':'ready','url':'https://localhost:8000'}),flush=True)\n");
            using (var form = Window(root, opened.Add))
            { form.Show(); form.BeginLaunch(); form.BeginLaunch(); Pump(() => form.IsDisposed); }
            Check(opened.Count == 1 && opened[0] == "https://localhost:8000", "Verified worker should open one browser only");
            opened.Clear();
            File.WriteAllText(worker, "import json,sys\nprint(json.dumps({'event':'error','message':'Synthetic failure'}),flush=True)\nsys.stderr.write('x'*90000)\nsys.exit(1)\n");
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
            Console.WriteLine("PASS: native layout captures; setup/error recovery; URL boundary; hidden exact worker; one browser after ready; concurrent pipe drain; close during startup.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}

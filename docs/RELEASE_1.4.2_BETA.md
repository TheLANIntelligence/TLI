# TLI 1.4.2-beta

This patch clarifies TLI's offline welcome experience and avoids unnecessary
dependency downloads in a prepared Windows installation.

- Welcome setup can be completed offline. Download a model only if you need one;
  existing compatible models and local providers can be reused.
- Installed custom models are offered before models that require a download.
  Checking or activating a local model does not download another model.
- Windows setup checks installed Python dependencies first and skips pip when
  they already meet this release's requirements. Missing Python, application
  components or runtime prerequisites can still require a download.
- Local host connection errors no longer imply an internet problem.

The first installation is still a Python-based package: the ZIP does not bundle
Python or every Python dependency. Internet is needed when missing components
must be downloaded, and for optional online services. The welcome flow itself,
its soundtrack and use of an installed local AI model do not require internet.

Download `TLI_1.4.2-beta_Windows.zip` or `TLI_1.4.2-beta_macOS.zip`. For an existing
installation, extract the new ZIP separately and run its `TLI_Update` launcher
against the original folder after stopping TLI and backing up important data.
This preserves its data, models, settings and Python environment. Read the
included `docs/TLI_UPDATES.md` before updating.

Windows 10/11 x64, Mac runtime requirements, unsigned-launcher behavior and
the legacy update channel are unchanged. Model weights remain separate.

The focused checks passed 24 Windows setup cases, the onboarding backend tests,
45 browser scenarios and 40 layouts. The browser checks block external network
requests and confirm completion without any model action, preservation of a
ready local model, and explicit checking of an installed custom model. They use
synthetic API responses and do not establish model inference quality.

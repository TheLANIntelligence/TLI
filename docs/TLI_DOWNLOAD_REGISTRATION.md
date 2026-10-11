# Website download registration

The download page requires an email address and a selected platform before it
offers the current release ZIP. A visitor submits the form, then chooses the
download link after Formspree acknowledges the request. A failed or uncertain
submission leaves the download link locked and preserves their entries for retry.

## Where to see requests

Sign in to the existing Formspree account at https://formspree.io/forms and open
form `xlgarvnq`, then its Submissions tab. The website already used this form for
optional download-link requests; new registrations use `request_kind` equal to
`desktop_download_request` so they can be distinguished from those older entries.

Each registration sends only these fields:

- `email`: the address entered by the visitor.
- `platform`: `windows` or `macos`.
- `release_version` and `asset_filename`: the selected published package.
- `request_kind`, `source_page`, and `_subject`: the purpose and source of the request.

Use Formspree's received time for when the request arrived. No address is added
to a URL, browser storage, analytics event, or public repository. The form
explains that the email and selected release are recorded through Formspree for
the download request. It does not enroll the visitor in marketing or promise an
automatic email reply.

## What the records mean

A registration is a download request, not proof of a completed download,
successful installation, a unique person, or ownership of the entered email.
The address is checked for email syntax, not verified through an inbox link.
Repeat requests can appear more than once. Formspree's spam handling and account
settings determine which submissions are shown and whether notifications arrive.

The release assets on GitHub, `downloads.json`, and the Mac installer remain
public. People can download them directly or share copies without using the
website form. This website registration flow is not server-side access control.

The GitHub release asset `download_count` is a separate count of requests for
each file; it does not identify downloaders. Release verification downloads and
repeat downloads count too.

## Operations

Check the form's Settings and Workflow for the notification recipient, spam
settings, and any domain restrictions. Allow the production website where domain
restrictions are enabled. The download page requires JavaScript and an available
Formspree endpoint. It will not reveal a package link when acceptance cannot be
confirmed. JavaScript-disabled visitors see a support route and an explanation.

Review the account's submission quota and retention settings before relying on
it as a long-term register. Formspree documents 50 monthly submissions and 30 days
of submission history on its Free plan; the actual account plan has not been
inspected. CSV/JSON export is documented for Personal, Professional and Business
plans. No subscription or notification settings are changed by this website edit.

References:

- [Formspree account limits](https://help.formspree.io/articles/account-management/account-limits)
- [Exporting submissions](https://help.formspree.io/articles/form-and-project-settings/exporting-submissions/)
- [Over-limit submissions](https://help.formspree.io/articles/form-and-project-settings/over-limit-submissions)

## Validation

`node --test frontend/tests/download-registration.test.cjs` uses synthetic
responses and does not submit contact information. It checks both platforms,
explicit metadata, rejected/invalid acknowledgements, timeouts, duplicate
in-flight submissions, and changed form details while a request is pending.
Only the selected published release URL is offered; a server-provided redirect
is never followed.

On October 11, 2026, one owner-authorized synthetic registration was submitted
to the existing endpoint with the production website's Origin. It returned HTTP
200, `{"next":"/thanks","ok":true}`, and allowed that Origin. The test used
`request_kind=download_registration_test` and a clearly labeled test subject so
it can be excluded from real requests. This verifies endpoint acceptance, not
inbox delivery or the authenticated Submissions view.

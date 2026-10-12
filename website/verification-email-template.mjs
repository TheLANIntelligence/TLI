const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

// Inline styles and presentation tables keep the core layout readable when an
// email client removes the responsive style block. No remote assets are needed.
export function verificationEmailHTML({ label, link }) {
  const safeLabel = escapeHTML(label);
  const safeLink = escapeHTML(link);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>Verify your email — TheLANIntelligence</title>
  <style>
    @media screen and (max-width: 620px) {
      .email-outer { padding: 20px 12px !important; }
      .email-inset { padding-left: 24px !important; padding-right: 24px !important; }
      .email-heading { font-size: 36px !important; line-height: 40px !important; }
      .email-button-table { width: 100% !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:#f1f5ef;color:#16382b;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">Your ${safeLabel} download is one step away. Verify your email within 20 minutes.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f1f5ef" style="width:100%;border-collapse:collapse;">
    <tr><td class="email-outer" align="center" style="padding:40px 20px;">
      <!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0;font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
        <tr><td class="email-inset" style="padding:0 40px 24px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
            <tr>
              <td width="42" height="42" align="center" valign="middle" bgcolor="#176746" style="width:42px;height:42px;border-radius:12px;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-1px;">TLI</td>
              <td style="padding-left:12px;color:#16382b;font-size:16px;font-weight:600;letter-spacing:-0.5px;">TheLANIntelligence</td>
            </tr>
          </table>
        </td></tr>
        <tr><td bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #d9e4d8;border-radius:20px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:separate;border-spacing:0;">
            <tr><td class="email-inset" bgcolor="#e8f1e5" style="padding:38px 40px 34px;background-color:#e8f1e5;border-radius:19px 19px 0 0;">
              <p style="margin:0 0 18px;color:#176746;font-size:11px;line-height:17px;letter-spacing:2px;font-weight:700;">EMAIL VERIFICATION</p>
              <h1 class="email-heading" style="margin:0;color:#16382b;font-size:44px;line-height:48px;font-weight:600;letter-spacing:-1.8px;">Welcome to<br>your TLI.</h1>
              <p style="margin:18px 0 0;color:#466351;font-size:16px;line-height:25px;">Your AI. Your world. Your terms.</p>
            </td></tr>
            <tr><td class="email-inset" style="padding:32px 40px 34px;">
              <p style="margin:0 0 24px;color:#405b4b;font-size:16px;line-height:26px;">Confirm your email to download <strong style="color:#16382b;font-weight:600;">${safeLabel}</strong>, then make it your own.</p>
              <table class="email-button-table" role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;border-spacing:0;">
                <tr><td align="center" bgcolor="#176746" style="background-color:#176746;border-radius:8px;mso-padding-alt:16px 26px;">
                  <a href="${safeLink}" style="display:block;padding:16px 26px;border:1px solid #176746;border-radius:8px;color:#ffffff;font-size:16px;line-height:22px;font-weight:600;text-decoration:none;text-align:center;mso-padding-alt:0;">Verify email &amp; continue</a>
                </td></tr>
              </table>
              <p style="margin:20px 0 0;color:#52685c;font-size:14px;line-height:22px;">Open the link, then confirm on the TLI website to see your download.</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;margin-top:24px;">
                <tr><td bgcolor="#f4f7f1" style="padding:14px 16px;border-left:3px solid #87ab87;color:#405b4b;font-size:13px;line-height:21px;">This link expires in <strong style="color:#16382b;">20 minutes</strong> and works once.</td></tr>
              </table>
              <p style="margin:24px 0 6px;color:#52685c;font-size:12px;line-height:19px;">If the button does not open, copy this link into your browser:</p>
              <p style="margin:0;font-size:12px;line-height:19px;word-break:break-all;overflow-wrap:anywhere;"><a href="${safeLink}" style="color:#176746;text-decoration:underline;word-break:break-all;overflow-wrap:anywhere;">${safeLink}</a></p>
            </td></tr>
            <tr><td class="email-inset" style="padding:22px 40px 26px;border-top:1px solid #e3ebe0;">
              <p style="margin:0;color:#617267;font-size:12px;line-height:20px;">If you did not request a TLI download, you can ignore this email. No download registration is verified until you confirm. This does not subscribe you to marketing emails.</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td class="email-inset" style="padding:22px 40px 0;color:#617267;font-size:12px;line-height:20px;">
          <p style="margin:0;">Built with intent. Built for your world.</p>
          <p style="margin:5px 0 0;"><a href="https://thelanintelligence.com/" style="color:#456651;text-decoration:underline;">TheLANIntelligence</a></p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
}

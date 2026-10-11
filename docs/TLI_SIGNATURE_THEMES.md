# Eight signature appearances

The current premium workspace exposes all 23 palettes through **All / Light /
Dark**. Signature typography and geometry described below apply to the legacy
experience; premium uses one shared component system with each palette's own
colors. See [the current interface](TLI_PREMIUM_EXPERIENCE.md).

Open **Settings → General → Appearance** and choose a design from **Signature**.
There are four light designs and four dark designs. **All**, **Light** and **Dark**
also expose the complete collection; the native selector retains all 23 choices.
Choosing a theme saves it in this browser through the existing Settings handler.
Changing a gallery filter does not save a preference.

| Light | Character |
| --- | --- |
| Emerald Light | White and sage surfaces, forest ink, precise emerald controls and restrained elevation. |
| Lavender | Cool lilac surfaces, violet ink, silver edges and layered light. |
| Porcelain | Warm ivory, navy ink, Georgia serif headings and a subtle paper treatment. |
| Rose Quartz | Mineral pink, plum ink, softer corners and warm depth. |

| Dark | Character |
| --- | --- |
| Pacific | Ocean blue, aqua controls and illuminated panel edges. |
| Copper | Walnut charcoal, ivory text, copper accents and inset highlights. |
| Graphite | Neutral charcoal and silver, stronger headings and squared controls. |
| Terminal | Forest black, phosphor accents, monospace headings and measurements, rectangular controls and a faint canvas grid. |

Body text stays readable on solid surfaces. Code retains its code font; warnings,
errors and availability retain semantic colors independently of the accent.
Fonts come from the local operating system, with serif, sans-serif and monospace
fallbacks. Decoration is static CSS; no external images, fonts or background
animation are required.

## Appearance and interface are separate

**Modern** and **Classic** keep their respective navigation, panel arrangement,
spacing and controls. An appearance can be used with either interface. Classic
uses the selected signature's decoration while retaining its familiar layout.
For the other 15 themes, Classic's previous decorative rules remain the fallback.

The saved Lavender identifier remains `lavenderLite`; only its displayed name is
shortened. Emerald Lite and Lavender Midnight remain separate choices. No theme
identifier is removed, no preference format changes, and opening the gallery
does not replace a saved choice. An unsuccessful save restores the previous
appearance through the existing Settings owner.

## Implementation and verification

`themes.css` supplies the palette and optional appearance tokens. Existing
component rules consume typography, geometry, depth and chrome treatments at
their original styling owners. Every consumer retains its prior value as a
fallback. Non-signature themes and isolated preview roots deliberately reset
optional tokens so that the currently selected appearance cannot leak into a
different preview.

Preview cards use real sample headings, body text, measurements and controls
with the same tokens as the application. They are synthetic, decorative samples;
selecting a sample changes only the theme.

See the [coverage and verification record](../build_work/signature-themes/RESULTS.md),
[before/after gallery](../build_work/signature-themes/review.html) and
[source manifest](../build_work/signature-themes/manifest.json). Browser fixtures
use synthetic data and intercepted requests. Physical-device, screen-reader and
native-platform results remain distinct from browser checks. This source update
does not restart TLI, change its model, rebuild Companion or operate on household
data.

# Android isolated Builder preview

`TliPreview` is an Android Expo View. The trusted React Native client fetches an
owned saved revision through `TliTransport` and passes only `html`, response
`headers`, the correlation `token`, and `revisionKey`. No host origin, session,
cookie, file URI, or transport object belongs in these props.

The native view serves two exact synthetic HTTPS URLs from memory: a fixed
wrapper and its script-only sandbox iframe. The full server CSP is validated and
preserved as an HTTP response header, including `sandbox`; a CSP meta tag is not
an equivalent substitute. Every other intercepted resource receives a local
denial. Network loads and service-worker loads are disabled in WebSettings; file
access, storage, permissions, navigation, downloads and popups are denied. There
is no JavaScript-to-native bridge. A constant native evaluation polls the fixed
wrapper for a bounded, advisory browser-check result. The generated frame cannot
read the wrapper; generated checks remain untrusted and can falsify their own
results.

Each new revision/token creates a fresh renderer. Disposing the component stops
and destroys it. The screen must unmount it when the account/host changes or its
credential is invalidated. In-memory app state is discarded on reload.

The iOS and browser exports show an unsupported message; they never silently load
the paired host into a web browser. Synthetic browser demonstrations live in the
separate app preview fixture.

## Verification

Run `:tli-preview:testDebugUnitTest` and `:tli-transport:testDebugUnitTest` in an
Expo-generated Android project. Before distributing a build, instrument minimum
supported and current physical-device WebViews: exercise fetch/XHR, CSS and image
loads, WebSocket/EventSource, workers, WebRTC/STUN, DNS prefetch, forms, redirects,
navigation, file/content/intent/data/blob URLs, and permission requests. Observe
egress independently of page JavaScript, check that the synthetic HTTPS document
still renders with network loads blocked, and verify the app remains dismissible
after a renderer crash or infinite loop. Unit tests and compilation do not prove
this device behavior. Browser sandbox policy must not be described as an absolute
guarantee against every transport of hostile generated code.

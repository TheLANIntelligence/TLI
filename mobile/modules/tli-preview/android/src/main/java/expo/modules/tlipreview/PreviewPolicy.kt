package expo.modules.tlipreview

/** Shared pure policy checks; rendering cannot quietly weaken the server sandbox. */
internal object PreviewPolicy {
  const val ORIGIN = "https://tli-preview.invalid"
  const val MAX_BYTES = 384 * 1024
  fun validate(html: String, headers: Map<String, String>, token: String, revisionKey: String): Map<String, String> {
    require(Regex("^tli[0-9a-f]{32}$").matches(token)) { "Invalid preview correlation token." }
    require(revisionKey.isNotEmpty() && revisionKey.length <= 256) { "Choose a saved app revision." }
    require(html.isNotEmpty() && html.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) { "Preview content exceeds its limit." }
    require(headers.keys.map { it.lowercase() }.distinct().size == headers.size) { "Duplicate response headers." }
    val lower = headers.mapKeys { it.key.lowercase() }
    val csp = lower["content-security-policy"] ?: error("The preview sandbox header is missing.")
    require(csp.length <= 4096 && csp.all { it >= ' ' && it <= '~' }) { "Invalid preview policy." }
    val entries = csp.split(';').map { it.trim() }.filter { it.isNotEmpty() }.map {
      val part = it.indexOf(' '); require(part > 0) { "Invalid preview directive." }
      it.substring(0, part).lowercase() to it.substring(part + 1).trim()
    }
    require(entries.map { it.first }.distinct().size == entries.size) { "Duplicate preview directive." }
    val directives = entries.toMap()
    require(directives["sandbox"] == "allow-scripts") { "The preview must have an opaque origin." }
    for (key in listOf("default-src", "img-src", "connect-src", "font-src", "media-src", "object-src", "frame-src", "worker-src", "base-uri", "form-action")) {
      require(directives[key] == "'none'") { "The preview must block $key." }
    }
    require(directives["style-src"] == "'unsafe-inline'" && directives["frame-ancestors"] == "'self'") { "Unsupported preview policy." }
    require(Regex("^'nonce-[0-9a-f]{48}'$").matches(directives["script-src"] ?: "")) { "Only nonce scripts may run in the preview." }
    require(directives.keys == setOf("sandbox", "default-src", "script-src", "style-src", "img-src", "connect-src", "font-src", "media-src", "object-src", "frame-src", "worker-src", "base-uri", "form-action", "frame-ancestors")) { "Unsupported preview directive." }
    return mapOf("Content-Security-Policy" to csp, "Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff", "Referrer-Policy" to "no-referrer",
      "Permissions-Policy" to "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()")
  }
}

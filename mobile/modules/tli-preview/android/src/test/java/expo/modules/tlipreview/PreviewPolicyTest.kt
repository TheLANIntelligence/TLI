package expo.modules.tlipreview

import org.junit.Assert.*
import org.junit.Test

class PreviewPolicyTest {
  private val policy = "sandbox allow-scripts; default-src 'none'; script-src 'nonce-${"a".repeat(48)}'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
  private val token = "tli" + "b".repeat(32)
  @Test fun preservesResponseSandboxHeaderAndDropsCredentials() {
    val result = PreviewPolicy.validate("<html>calculator</html>", mapOf("content-security-policy" to policy, "set-cookie" to "session=secret", "authorization" to "secret"), token, "app:1")
    assertEquals(policy, result["Content-Security-Policy"])
    assertFalse(result.keys.any { it.equals("set-cookie", true) || it.equals("authorization", true) })
  }
  @Test fun refusesWeakeningOpaqueOriginNetworkAndScriptPolicy() {
    for (value in listOf(policy.replace("sandbox allow-scripts", "sandbox allow-scripts allow-same-origin"),
      policy.replace("connect-src 'none'", "connect-src *"), policy.replace("frame-src 'none'", "frame-src 'self'"),
      policy.replace("base-uri 'none';", ""), policy.replace("script-src 'nonce-${"a".repeat(48)}'", "script-src 'unsafe-inline'"),
      policy + "; sandbox allow-same-origin", policy + "; report-uri https://example.com")) {
      assertThrows(IllegalArgumentException::class.java) { PreviewPolicy.validate("<html></html>", mapOf("content-security-policy" to value), token, "app:1") }
    }
  }
  @Test fun noMetaOnlyFallbackOrUnlimitedPayload() {
    assertThrows(IllegalStateException::class.java) { PreviewPolicy.validate("<meta http-equiv='Content-Security-Policy' content=\"$policy\">", emptyMap(), token, "app:1") }
    assertThrows(IllegalArgumentException::class.java) { PreviewPolicy.validate("x".repeat(PreviewPolicy.MAX_BYTES + 1), mapOf("content-security-policy" to policy), token, "app:1") }
    assertThrows(IllegalArgumentException::class.java) { PreviewPolicy.validate("x", mapOf("content-security-policy" to policy), "tli';alert(1)", "app:1") }
  }
}

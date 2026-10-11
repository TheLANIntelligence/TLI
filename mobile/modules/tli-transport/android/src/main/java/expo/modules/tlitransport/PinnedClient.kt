package expo.modules.tlitransport

import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.TlsVersion
import java.net.Proxy
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** Production TLS construction, independent of the Expo bridge for JVM verification. */
internal object PinnedClient {
  fun create(certificate: X509Certificate): OkHttpClient {
    // Fail before a client can send anything, even if its leaf is a trust anchor.
    certificate.checkValidity()
    val keyStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
      load(null, null)
      setCertificateEntry("paired-tli-leaf", certificate)
    }
    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(keyStore) }
    val platformTrust = factory.trustManagers.filterIsInstance<X509TrustManager>().single()
    val pinnedTrust = ExactCertificateTrustManager(certificate, platformTrust)
    val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(pinnedTrust), null) }
    return OkHttpClient.Builder()
      .sslSocketFactory(ssl.socketFactory, pinnedTrust)
      // Keep OkHttp's default hostname verifier: SAN mismatch is a hard failure.
      .connectionSpecs(listOf(ConnectionSpec.Builder(ConnectionSpec.MODERN_TLS)
        .tlsVersions(TlsVersion.TLS_1_3, TlsVersion.TLS_1_2).build()))
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .proxy(Proxy.NO_PROXY)
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(120, TimeUnit.SECONDS)
      .writeTimeout(60, TimeUnit.SECONDS)
      .callTimeout(5, TimeUnit.MINUTES)
      .build()
  }
}

/** A client-scoped platform trust manager plus an exact leaf check before HTTP. */
private class ExactCertificateTrustManager(
  private val certificate: X509Certificate,
  private val delegate: X509TrustManager
) : X509TrustManager {
  override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf(certificate)

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    throw CertificateException("Client certificate authentication is unsupported.")
  }

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    if (chain.isNullOrEmpty() || !MessageDigest.isEqual(chain[0].encoded, certificate.encoded)) {
      throw CertificateException("The peer does not match the paired TLI certificate.")
    }
    // Recheck at every handshake as well as during initial configuration.
    certificate.checkValidity()
    chain[0].checkValidity()
    delegate.checkServerTrusted(chain, authType)
  }
}

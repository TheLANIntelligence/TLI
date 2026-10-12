package expo.modules.tlitransport

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import android.os.Build

/** Short, bounded DNS-SD scan. Results are explicitly untrusted hints. */
internal class LanDiscovery(context: Context) {
  private val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
  private val main = Handler(Looper.getMainLooper())
  private var active: NsdManager.DiscoveryListener? = null
  private var complete: ((List<Map<String, Any>>?, Exception?) -> Unit)? = null
  private val found = linkedMapOf<String, Map<String, Any>>()
  private val queue = ArrayDeque<NsdServiceInfo>()
  private var resolving = false
  private var resolver: NsdManager.ResolveListener? = null
  private var scanned = 0
  private var epoch = 0
  private var timer: Runnable? = null

  fun start(timeoutMs: Int, completion: (List<Map<String, Any>>?, Exception?) -> Unit) {
    main.post {
      stop(TransportFailure("E_CANCELLED", "Discovery was replaced."))
      val generation = ++epoch
      found.clear(); queue.clear(); resolving = false; scanned = 0; complete = completion
      val listener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(type: String) = Unit
        override fun onDiscoveryStopped(type: String) = Unit
        override fun onStopDiscoveryFailed(type: String, code: Int) = Unit
        override fun onStartDiscoveryFailed(type: String, code: Int) { main.post { if (epoch == generation) stop(TransportFailure("E_DISCOVERY", "LAN discovery is unavailable. Use the reviewed pairing address.")) } }
        override fun onServiceLost(info: NsdServiceInfo) = Unit
        override fun onServiceFound(info: NsdServiceInfo) { main.post {
          if (epoch == generation && complete != null && scanned++ < 32 && info.serviceType.trimEnd('.') == "_tli._tcp") {
            queue.add(info); resolveNext(generation)
          }
        } }
      }
      active = listener
      try {
        manager.discoverServices("_tli._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
        timer = Runnable { if (epoch == generation) stop() }.also { main.postDelayed(it, timeoutMs.coerceIn(1000, 10000).toLong()) }
      } catch (_: Exception) { stop(TransportFailure("E_DISCOVERY", "LAN discovery could not start. Check local network permissions.")) }
    }
  }

  @Suppress("DEPRECATION")
  private fun resolveNext(generation: Int) {
    if (resolving || queue.isEmpty() || epoch != generation || complete == null) return
    resolving = true
    val listener = object : NsdManager.ResolveListener {
      override fun onResolveFailed(info: NsdServiceInfo, code: Int) { main.post { if (epoch == generation) { resolving = false; resolveNext(generation) } } }
      override fun onServiceResolved(info: NsdServiceInfo) { main.post {
        if (epoch != generation || complete == null) return@post
        try {
          fun field(name: String) = info.attributes[name]?.takeIf { it.size <= 512 }?.toString(Charsets.UTF_8) ?: ""
          if (field("tls") == "1" && field("endpoint_protocol") == "tli-endpoint-v1") {
            val origin = TransportPolicy.origin(field("origin"))
            val nodeId = field("id")
            val addresses = (if (Build.VERSION.SDK_INT >= 34) info.hostAddresses else listOfNotNull(info.host))
              .mapNotNull { host -> try { host.hostAddress?.let { TransportPolicy.privateAddress(it) } } catch (_: Exception) { null } }
              .distinct().take(8)
            if (TransportPolicy.isHostname(origin) && java.net.URI(origin).port == info.port &&
              nodeId.isNotEmpty() && nodeId.length <= 128 && addresses.isNotEmpty()) {
              val key = nodeId + "|" + origin
              val existing = found[key]?.get("addresses") as? List<*> ?: emptyList<String>()
              found[key] = mapOf("origin" to origin, "nodeId" to nodeId,
                "name" to field("name").take(128), "addresses" to (existing.filterIsInstance<String>() + addresses).distinct().take(8))
            }
          }
        } catch (_: Exception) { /* A malformed advertisement is only a rejected hint. */ }
        resolving = false; resolveNext(generation)
      } }
    }
    resolver = listener
    try { manager.resolveService(queue.removeFirst(), listener) } catch (_: Exception) { resolving = false; resolveNext(generation) }
  }

  fun cancel() { main.post { stop(TransportFailure("E_CANCELLED", "LAN discovery was cancelled.")) } }
  private fun stop(error: Exception? = null) {
    ++epoch
    timer?.let { main.removeCallbacks(it) }; timer = null
    active?.let { try { manager.stopServiceDiscovery(it) } catch (_: Exception) {} }; active = null
    if (Build.VERSION.SDK_INT >= 34) resolver?.let { try { manager.stopServiceResolution(it) } catch (_: Exception) {} }
    resolver = null
    val callback = complete; complete = null
    queue.clear(); resolving = false
    callback?.invoke(if (error == null) found.values.toList() else null, error)
  }
}

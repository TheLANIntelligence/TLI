package expo.modules.tlitransport

import java.net.InetAddress
import java.net.URI
import java.util.concurrent.Callable
import java.util.concurrent.Future
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** DNS is a bounded source of untrusted socket hints, never identity authority. */
internal class RouteResolver(private val lookup: (String) -> List<String> = { host ->
  InetAddress.getAllByName(host).mapNotNull { it.hostAddress }
}) {
  private val executor = ThreadPoolExecutor(0, 2, 30, TimeUnit.SECONDS, SynchronousQueue<Runnable>(),
    { task -> Thread(task, "tli-route-dns").apply { isDaemon = true } })
  private val pending = mutableMapOf<String, Future<List<String>>>()

  fun resolve(origin: String, timeoutMs: Int): List<String> {
    val host = URI(TransportPolicy.origin(origin)).host
    if (!host.endsWith(".local")) return listOf(TransportPolicy.privateAddress(host))
    val task = synchronized(pending) {
      pending.entries.removeAll { it.value.isDone }
      pending[host] ?: try {
        executor.submit(Callable { lookup(host).mapNotNull { value ->
          try { TransportPolicy.privateAddress(value) } catch (_: Exception) { null }
        }.distinct().take(8) }).also { pending[host] = it }
      } catch (_: java.util.concurrent.RejectedExecutionException) {
        throw TransportFailure("E_NO_ROUTE", "DNS resolution is busy. Discovery can still supply a checked route.")
      }
    }
    return try { task.get(timeoutMs.coerceIn(100, 2500).toLong(), TimeUnit.MILLISECONDS) }
    catch (_: TimeoutException) { throw TransportFailure("E_TIMEOUT", "The reviewed TLI hostname did not resolve in time.") }
    catch (_: Exception) { throw TransportFailure("E_NO_ROUTE", "The reviewed TLI hostname has no private LAN route.") }
    finally { synchronized(pending) { if (task.isDone && pending[host] === task) pending.remove(host) } }
  }

  fun close() { executor.shutdownNow() }
}

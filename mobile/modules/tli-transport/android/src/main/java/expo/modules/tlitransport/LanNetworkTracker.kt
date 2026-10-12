package expo.modules.tlitransport

/** Platform-neutral route state: cellular changes cannot alter a LAN baseline. */
internal data class LanNetworkRoute(
  val id: Long, val eligible: Boolean, val active: Boolean,
  val interfaceName: String = "", val addresses: List<String> = emptyList(),
  val routes: List<String> = emptyList(), val dns: List<String> = emptyList()
)

internal class LanNetworkTracker(initial: List<LanNetworkRoute>) {
  private fun normalize(values: List<LanNetworkRoute>) = values.filter { it.eligible }.map {
    it.copy(addresses = it.addresses.distinct().sorted(), routes = it.routes.distinct().sorted(), dns = it.dns.distinct().sorted())
  }.sortedBy { it.id }
  private var baseline = normalize(initial)

  /** Initial callbacks and reordered lists are observations, not transitions. */
  fun changed(values: List<LanNetworkRoute>): Boolean {
    val next = normalize(values)
    if (next == baseline) return false
    baseline = next
    return true
  }
}

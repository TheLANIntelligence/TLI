package expo.modules.tlitransport

import java.io.ByteArrayOutputStream
import java.io.File

internal object TransferFiles {
  fun readUpload(selected: File, cacheDirectories: List<File>, cancelled: () -> Boolean = { false }): ByteArray {
    val file = selected.canonicalFile
    val roots = cacheDirectories.map { it.canonicalFile.path + File.separator }
    if (roots.none { file.path.startsWith(it) } || !file.isFile || file.length() > MAX_UPLOAD_BYTES) {
      throw TransportFailure("E_FILE", "Choose an app-cache document up to 8 MiB.")
    }
    return file.inputStream().use { input ->
      val output = ByteArrayOutputStream()
      val buffer = ByteArray(8192)
      while (true) {
        if (cancelled()) throw TransportFailure("E_CANCELLED", "The upload was cancelled.")
        val count = input.read(buffer); if (count < 0) break
        if (output.size() + count > MAX_UPLOAD_BYTES) throw TransportFailure("E_REQUEST_TOO_LARGE", "The document exceeds 8 MiB.")
        output.write(buffer, 0, count)
      }
      output.toByteArray()
    }
  }
}

package expo.modules.tlitransport

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.RandomAccessFile

class TransferFilesTest {
  @get:Rule val folder = TemporaryFolder()
  @Test fun rawBinaryKeepsAllBytesFromReviewedCacheFile() {
    val cache = folder.newFolder("cache")
    val file = File(cache, "document.pdf"); val bytes = ByteArray(8193) { it.toByte() }; file.writeBytes(bytes)
    assertArrayEquals(bytes, TransferFiles.readUpload(file, listOf(cache)))
  }
  @Test fun traversalSiblingDirectoryAndOversizedFilesAreRejected() {
    val cache = folder.newFolder("cache")
    val outside = folder.newFile("private-key"); outside.writeText("private")
    val sibling = folder.newFolder("cache-other"); val other = File(sibling, "document").apply { writeText("other") }
    val large = File(cache, "large"); RandomAccessFile(large, "rw").use { it.setLength(MAX_UPLOAD_BYTES.toLong() + 1) }
    for (file in listOf(File(cache, "../private-key"), other, cache, large)) {
      assertThrows(TransportFailure::class.java) { TransferFiles.readUpload(file, listOf(cache)) }
    }
  }
  @Test fun cancelledDocumentReadCannotProduceAnUploadPayload() {
    val cache = folder.newFolder("cache")
    val file = File(cache, "document").apply { writeBytes(ByteArray(16000)) }
    assertThrows(TransportFailure::class.java) { TransferFiles.readUpload(file, listOf(cache)) { true } }
  }
}

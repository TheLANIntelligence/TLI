# Reviewed PDF and DOCX text

Chat's existing document workflow now accepts bounded PDF and DOCX text
extraction alongside supported text files. Choose a document, inspect the
extracted text and coverage, and explicitly accept that preview before sending
the question. Opening or extracting a file does not attach it automatically,
contact a model or modify the original.

This is text extraction, not OCR, image understanding or a layout-faithful
conversion. Image-only pages, unsupported/protected files, unreadable parts and
truncated coverage are reported. Macros and document scripts never execute;
password protection is not bypassed. Original line/source references remain
visible in the existing document and answer receipts.

Limits bound each input to 8 MiB, PDFs to 100 pages, and DOCX processing to
500 paragraphs, 1,000 ZIP members, 16 MiB expanded data and 4 MiB per part.
Extracted text is limited to 64 KiB. Parsing runs in owned, resource-bounded
workers, with two slots, a 15-second parsing deadline and a 30-second upload
deadline. Existing limits of four documents and the final model input budget
still apply; extraction success does not guarantee that every excerpt fits a
particular model.

The binary and extraction worker storage are discarded after processing. A
short-lived, owner-bound proof identifies the reviewed extraction; it does not
retain the document body. Chat continues its existing excerpt-sharing rules and
saves identity/range receipts rather than silently persisting uploaded document
bodies. A later question must deliberately supply the document again where
required by those rules.

Synthetic tests cover malformed files, ZIP expansion, missing dependencies,
worker deadlines, ownership, proof tampering, incomplete extraction, rejected
replacement retention and deliberate sending. Actual-SPA screenshots and
checks are retained under
`build_work/anniversary-completion/rich-documents-*`. This does not validate every
PDF producer, document language or physical host installation.

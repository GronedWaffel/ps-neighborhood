# PS5 fPKG conversion for ShadowMount

Select a PS5 debug base-game `.pkg` in **PKG installer**, or use **ShadowMount →
Add image / PKG**. PS Neighborhood reads the package headers and offers **Convert
for ShadowMount?** Native installation remains available through **Use PKG
installer**. Folder imports hold these packages at **Choose method** until you
choose conversion or native installation; the queue cannot skip that review.

1. Choose a PC output drive. The prompt shows free space and a conservative
   working-space estimate; the actual expanded size is checked before extraction.
2. Choose **Keep image on this PC**, or select an automatically discovered ShadowMount destination and choose
   **Convert and transfer**. ShadowMount, FTP and the Neighborhood companion must
   already be available to discover console storage. Existing internal game folders
   are detected on fresh installations, with no previous setup required. If the
   folder is missing, click **Prepare internal storage** directly in this window.
   Custom scan paths and read-only storage are respected. If FTP is unavailable,
   you can still convert locally and transfer later.
3. Press **Convert**. The backend extracts the game, restores its separate CNT
   metadata, builds a compressed FFPFSC image, verifies every compressed block,
   and compares the decoded image against an independent exFAT stream of the
   extracted files. It retains a SHA-256 verification receipt.
4. If selected, transfer starts after verification. Only this image is transferred;
   other queued games are left alone. The app reports copying and ShadowMount
   recognition separately. A mounted game may delay registration; use the existing
   ShadowMount library controls when convenient.

The original PKG is preserved. Temporary extracted files are removed after
verification; the finished image remains in the selected output folder. Cancellation
stops the worker and removes only its private incomplete conversion directory.
Interrupted FTP transfers keep their staging files so **Transfer verified image**
can resume. After a PC crash, incomplete conversions must be started again; verified
images remain available through the saved job. The app prevents sleep and accidental
window closure while conversion is active.

An already installed copy of the same title is never uninstalled automatically.
If it blocks transfer, manage that exact title in **Console & storage**, then retry
the verified image. This avoids replacing a working installation by mistake.

## Scope

This automates the extraction-to-ShadowMount workaround used on PS5 13.60. It does
**not** patch etaHEN/kstuff to add native PS5 fPKG launch support, and does not promise
that every converted game will run. Supported input is a finalized debug FIH base
package with a PPSA title ID and application content type. Retail packages, separate
patches, DLC, metadata-only CNT packages and PS4 PKGs are not converted. PS4 packages
continue through the existing installer.

Conversion can require much more free PC space than the compressed input. The
output can also be larger than the original PKG. Ethernet is recommended for the
subsequent transfer. No debugger memory changes or extra payload reloads are needed.

The self-contained Windows helper and open-source decoder ship with the portable
app. Developers need .NET 10 SDK and Zig 0.14.1; see [converter credits and build
instructions](../converter/NOTICE.md).

## Validation

The automated converter completed a real 28,866,157,840-byte PS5 debug package:
76,824,542,657 extracted bytes, a 40,473,329,664-byte FFPFSC container, and a
76,931,661,824-byte decoded exFAT image. All blocks decoded, and the independently
generated source exFAT SHA-256 matched the decoded image:
`9c335741bf04b725f7b4ab695643a0ade98afd6ed2e2712dbb9b840c93fb9886`.
That same filesystem hash matches the earlier manually converted image which
launched on PS5 13.60. The automated conversion test did not replace the running
console game or replay installation. Transfer uses the existing verified
ShadowMount queue; targeted transfer, conflict refusal, cancellation, bad receipts,
changed images and console mismatch have regression coverage.

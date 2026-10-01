// GPL-3.0-or-later. ABI adapter for the open-source ooz decoder, NOT an Oodle DLL.
#include "vendor/ooz/ooz.h"
#include <cstdint>
#include <cstring>
#include <cstdlib>
#define EXPORT extern "C" __declspec(dllexport)
EXPORT intptr_t OodleLZ_Decompress(const void *src, intptr_t size, void *dst, intptr_t length,
    int, int, int, void *, intptr_t, void *, void *, void *, intptr_t, int phase) {
  if (!src || !dst || size <= 0 || length <= 0 || size > 536870912 || length > 536870912 || phase != 3) return 0;
  // ooz needs readable and writable padding. Never expose that requirement to the caller.
  auto input = static_cast<unsigned char *>(calloc(static_cast<size_t>(size) + 64, 1));
  auto output = static_cast<unsigned char *>(calloc(static_cast<size_t>(length) + OOZ_SAFE_SPACE, 1));
  if (!input || !output) { free(input); free(output); return 0; }
  memcpy(input, src, size);
  int result = Kraken_Decompress(input, size, output, length);
  if (result == length) memcpy(dst, output, length);
  free(input); free(output);
  return result == length ? result : 0;
}
// The managed loader resolves these exports; conversion only uses decompression.
EXPORT intptr_t OodleLZ_Compress(int, const void *, intptr_t, void *, int, void *, void *, void *, void *, intptr_t) { return 0; }
EXPORT intptr_t OodleLZ_GetCompressedBufferSizeNeeded(int, intptr_t) { return 0; }

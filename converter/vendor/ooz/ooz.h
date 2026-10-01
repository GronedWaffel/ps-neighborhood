#pragma once
#include <stdint.h>
#include <stdlib.h>

// The decompressor will write outside of the target buffer.
#define OOZ_SAFE_SPACE 64

#ifdef __cplusplus
extern "C"
#endif
int Kraken_Decompress(const void *src, size_t src_len, void *dst, size_t dst_len);

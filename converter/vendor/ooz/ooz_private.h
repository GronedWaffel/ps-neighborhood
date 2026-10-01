#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef uint8_t     byte;
typedef uint8_t     uint8;
typedef uint16_t    uint16;
typedef uint32_t    uint32;
typedef uint64_t    uint64;
typedef int64_t     int64;
typedef int32_t     int32;
typedef int16_t     int16;
typedef unsigned int uint;

#define __forceinline inline

#define _byteswap_ushort(x) __builtin_bswap16(x)
#define _byteswap_ulong(x)  __builtin_bswap32(x)
#define _byteswap_uint64(x) __builtin_bswap64(x)

inline static unsigned char _BitScanForward(unsigned long *index, unsigned long mask)
{
    *index = __builtin_ctz(mask);
    return mask != 0;
}

inline static unsigned char _BitScanReverse(unsigned long *index, unsigned long mask)
{
    *index = 31 - __builtin_clz(mask);
    return mask != 0;
}

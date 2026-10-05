// Exact community-test targets shared with the experimental YouTube builder.
#pragma once
#include <stdint.h>
static inline int snipers_firmware_supported(uint32_t code){
 if((code&0xffff0000u)<0x11000000u)return 0;
 switch(code&0xffff0000u){
 case 0x7000000u:
 case 0x7010000u:
 case 0x7200000u:
 case 0x7400000u:
 case 0x7600000u:
 case 0x7610000u:
 case 0x8000000u:
 case 0x8200000u:
 case 0x8400000u:
 case 0x8600000u:
 case 0x9000000u:
 case 0x9200000u:
 case 0x9400000u:
 case 0x9600000u:
 case 0x10000000u:
 case 0x10010000u:
 case 0x10200000u:
 case 0x10400000u:
 case 0x10600000u:
 case 0x11000000u:
 case 0x11200000u:
 case 0x11600000u:
 case 0x12000000u:
 case 0x12020000u:
 case 0x12200000u:
 case 0x12400000u:
 case 0x12600000u:
 case 0x12700000u:
 case 0x13000000u:
 case 0x13200000u:
 case 0x13400000u:
 case 0x13420000u:
 case 0x13600000u:
 return 1;
 default:return 0;
 }
}

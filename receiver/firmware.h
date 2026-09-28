// SPDX-License-Identifier: GPL-3.0-or-later
// kern.sdk_version query follows ps4-payload-dev/sdk crt/kernel.c.
int psn_sysctl(const int*,unsigned int,void*,size_t*,const void*,size_t);
static uint32_t firmware_version(void){
 int mib[2]={1,38};uint32_t version=0;size_t size=sizeof(version);
 if(psn_sysctl(mib,2,&version,&size,NULL,0)||size!=sizeof(version))return 0;
 return version;
}
// Reviewed common proc/ucred/dynlib layouts. This is an explicit target list,
// not a statement that every native API has been tested on these firmwares.
static int firmware_target(uint32_t version){
 switch(version&0xffff0000){
 case 0x09000000:case 0x09030000:case 0x09040000:
 case 0x09500000:case 0x09510000:case 0x09600000:
 case 0x10000000:case 0x10010000:case 0x10500000:
 case 0x10700000:case 0x10710000:case 0x11000000:case 0x13520000:return 1;
 default:return 0;
 }
}

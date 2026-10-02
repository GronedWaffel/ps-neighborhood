// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef PSN_PS5_INSTALL_ABI_H
#define PSN_PS5_INSTALL_ABI_H
#include <stdint.h>
#include <stddef.h>
// Package installation permits custom PS4 homebrew IDs. Keep the narrower
// installed-game/save validators separate from package submission.
static int psn_install_content_valid(const char *content,uint32_t type){
 if(__builtin_strlen(content)!=36||content[6]!='-'||content[16]!='_'||content[17]!='0'||content[18]!='0'||content[19]!='-')return 0;
 for(unsigned i=0;i<36;i++){
  if(i==6||i==16||i==19)continue;
  if(!((content[i]>='A'&&content[i]<='Z')||(content[i]>='0'&&content[i]<='9')))return 0;
 }
 for(unsigned i=7;i<11;i++)if(content[i]<'A'||content[i]>'Z')return 0;
 for(unsigned i=11;i<16;i++)if(content[i]<'0'||content[i]>'9')return 0;
 const char *title=content+7;type&=0x7fffffffu;
 int ps5=!__builtin_memcmp(title,"PPSA",4)||!__builtin_memcmp(title,"MOUU",4);
 if(ps5)return type==0x20||type==0x21||type==0x22||type==0x26;
 if(!__builtin_memcmp(title,"NPXS",4))return 0;
 return type==0x1a||type==0x1b||type==0x1c||type==0x1e;
}
// Verified against the 13.60 AppInstUtil marshaller. The default system
// installer supplies zero for both fields after the six string pointers.
struct install_meta { const char *uri,*extra,*scenario,*content,*name,*icon; uint32_t option; uint8_t flag; };
struct install_pkg { char content[48]; int type,platform; };
struct install_playgo { char languages[30][8],scenarios[64][3],contents[64][48]; uint8_t reserved[6480]; };
struct install_error { int32_t code,version;char description[512],type[9]; };
// The 13.60 status response is 0x2c8 bytes. The error starts at 0xa0,
// rather than the 0x3c used by older published status definitions.
struct install_status { char state[16],source[8];uint32_t seconds;uint64_t downloaded,initial,total;uint32_t promote;uint8_t reserved[100];struct install_error error;int32_t copy_percent;_Bool copy_only;uint8_t trailing[15]; };
_Static_assert(sizeof(struct install_meta)==56,"PS5 install metadata ABI");
_Static_assert(offsetof(struct install_meta,option)==0x30,"PS5 install option offset");
_Static_assert(offsetof(struct install_meta,flag)==0x34,"PS5 install flag offset");
_Static_assert(sizeof(struct install_pkg)==56,"PS5 package result ABI");
_Static_assert(sizeof(struct install_playgo)==9984,"PS5 PlayGo ABI");
_Static_assert(sizeof(struct install_status)==712,"PS5 install status ABI");
_Static_assert(offsetof(struct install_status,error)==0xa0,"PS5 install error offset");
_Static_assert(offsetof(struct install_status,downloaded)==0x20,"PS5 progress offset");
_Static_assert(offsetof(struct install_status,total)==0x30,"PS5 total size offset");
static int psn_install_complete(const struct install_status *s,uint64_t size,uint32_t type){
 // Base and patch share a content ID. Immediately after submitting a patch,
 // AppInstUtil can still report the older base as playable. PS4 CNT status
 // totals must match the submitted package, not that stale base response.
 int ps4=type==0x1a||type==0x1b||type==0x1c||type==0x1e;
 int terminal=!__builtin_strcmp(s->state,"completed")||!__builtin_strcmp(s->state,"playable");
 return terminal&&s->total>0&&s->downloaded>=s->total&&!s->error.code&&(!ps4||s->total==size);
}
#endif

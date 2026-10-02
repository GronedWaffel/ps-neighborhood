#include <assert.h>
#include <string.h>
#include "install-abi.h"
int main(void){
 assert(psn_install_content_valid("IV0002-ITEM00001_00-STOREUPD00000000",0x1a));
 assert(psn_install_content_valid("IV0001-SFIN00000_00-SFIN000000009400",0x1a));
 assert(psn_install_content_valid("IV0002-CUSA00001_00-TESTPACKAGE00001",0x8000001a));
 assert(psn_install_content_valid("IV0002-PPSA00001_00-TESTPACKAGE00001",0x20));
 assert(!psn_install_content_valid("IV0002-PPSA00001_00-TESTPACKAGE00001",0x1a));
 assert(!psn_install_content_valid("IV0002-ITEM00001_00-TESTPACKAGE00001",0x20));
 assert(!psn_install_content_valid("IV0002-NPXS20001_00-TESTPACKAGE00001",0x1a));
 assert(!psn_install_content_valid("IV0002-ITEM0000X_00-TESTPACKAGE00001",0x1a));
 assert(!psn_install_content_valid("IV0002-ITEM00001/00-TESTPACKAGE00001",0x1a));
 // Model the actual native read/write boundaries independently of sizeof.
 struct {struct install_meta meta;unsigned char guard[16];} input;
 memset(&input,0xa5,sizeof input);input.meta=(struct install_meta){.uri="http://test/package.pkg",.option=0,.flag=0};
 uint32_t option;memcpy(&option,(unsigned char*)&input.meta+0x30,4);
 assert(option==0&&*((unsigned char*)&input.meta+0x34)==0);
 for(unsigned i=0;i<sizeof input.guard;i++)assert(input.guard[i]==0xa5);
 struct {struct install_status status;unsigned char guard[128];} output;
 memset(&output,0xa5,sizeof output);unsigned char *b=(unsigned char*)&output.status;
 memset(b,0,0x2c8);memcpy(b,"error",6);
 uint64_t downloaded=123456789,total=300000000;uint32_t error=0x8041013d;
 memcpy(b+0x20,&downloaded,8);memcpy(b+0x30,&total,8);memcpy(b+0xa0,&error,4);
 assert(!strcmp(output.status.state,"error"));
 assert(output.status.downloaded==downloaded&&output.status.total==total);
 assert((uint32_t)output.status.error.code==error);
 for(unsigned i=0;i<sizeof output.guard;i++)assert(output.guard[i]==0xa5);
 output.status.error.code=0;strcpy(output.status.state,"playable");output.status.total=186122240;output.status.downloaded=186122240;
 assert(!psn_install_complete(&output.status,2569928704ULL,0x1a));
 output.status.total=output.status.downloaded=2569928704ULL;
 assert(psn_install_complete(&output.status,2569928704ULL,0x1a));
 output.status.downloaded--;assert(!psn_install_complete(&output.status,2569928704ULL,0x1a));
 output.status.downloaded++;strcpy(output.status.state,"transferring");assert(!psn_install_complete(&output.status,2569928704ULL,0x1a));
 strcpy(output.status.state,"playable");output.status.total=output.status.downloaded=37617664;
 assert(psn_install_complete(&output.status,37633547,0x26));
 return 0;
}

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>
#include <assert.h>
#include "firmware.h"
static uint32_t test_firmware=0x10010000;
static int sysctl_error=0;
int psn_sysctl(const int *mib,unsigned int len,void *out,size_t *size,const void *in,size_t in_size){
 assert(mib[0]==1&&mib[1]==38&&len==2&&!in&&!in_size&&*size==4);
 if(sysctl_error)return -1;memcpy(out,&test_firmware,4);return 0;
}
static int initialize(void){return 0;}
static int existing_user(int *user){*user=42;return 0;}
void *dlopen(const char *name,int flags){(void)name;(void)flags;return NULL;}
void *dlsym(void *handle,const char *name){(void)handle;(void)name;return NULL;}
#include "console.h"
void *existing_symbol(const char *name){(void)name;return NULL;}
void *packed_symbol(void *h,const char *n,const char *a,void *p){(void)h;(void)n;(void)a;(void)p;return NULL;}
int psn_statfs(const char *p,void *b){(void)p;(void)b;return -1;}
static int fallback_calls,off_calls,reboot_calls,rest_calls,launch_calls,close_calls,remove_calls,patch_calls;
static int active_id=-1,launch_result=0x60000001;
int psn_evf_open(const char *name){assert(!strcmp(name,"SceSysCoreReboot"));fallback_calls++;return 7;}
int psn_evf_clear(int fd,uint64_t bits,int opt){assert(fd==7&&bits==0x4000&&opt==0);fallback_calls++;return 0;}
int psn_evf_close(int fd){assert(fd==7);fallback_calls++;return 0;}
int psn_kill(int pid,int sig){assert(pid==1&&sig==30);fallback_calls++;return 0;}
static int fake_exists(const char *title,int *exists){assert(!strcmp(title,"CUSA12345"));*exists=1;return 0;}
static int fake_id(const char *title){assert(!strcmp(title,"CUSA12345"));return active_id;}
static int fake_launch(const char *title,const char **argv,struct launch_param *p){assert(!strcmp(title,"CUSA12345"));assert(!argv&&p->size==32&&p->user==42&&p->option==0&&p->crash==0&&p->flags==2);launch_calls++;return launch_result;}
static int fake_close(uint32_t id,int opt,int method,int reason){assert(id==0x60000001&&opt==-1&&method==0&&reason==0);close_calls++;return 0;}
static int fake_remove(const char *title){assert(!strcmp(title,"CUSA12345"));remove_calls++;return 0;}
static int fake_patch(const char *title){assert(!strcmp(title,"CUSA12345"));patch_calls++;return 0;}
static int fake_off(void){off_calls++;return 0;}
static int fake_reboot(void){reboot_calls++;return 0;}
static int fake_rest(int arg){assert(arg==0);rest_calls++;return 0;}
int main(void){
 assert(firmware_version()==0x10010000);assert(firmware_target(firmware_version()));
 uint32_t targets[]={0x09000000,0x09030000,0x09040000,0x09500000,0x09510000,0x09600000,0x10000000,0x10010000,0x10500000,0x10700000,0x10710000,0x11000000,0x13520000};
 for(unsigned int i=0;i<sizeof(targets)/sizeof(targets[0]);i++)assert(firmware_target(targets[i]));
 assert(!firmware_target(0));assert(!firmware_target(0x14000000));sysctl_error=1;assert(firmware_version()==0);sysctl_error=0;
 app_exists=fake_exists;app_id=fake_id;app_launch=fake_launch;app_kill=fake_close;app_remove=fake_remove;patch_remove=fake_patch;
 state_off=fake_off;state_reboot=fake_reboot;kernel_reboot=fake_reboot;enter_standby=fake_rest;
 uint8_t reply[120];char title[]="CUSA12345";
 assert(console_app(1,title,reply)==0);
 if(launch_calls!=1 || off_calls || reboot_calls || rest_calls || fallback_calls){fprintf(stderr,"FAIL: launch invoked a power action instead of only the game launcher\n");return 1;}
 launch_result=(int)0x80940001;assert(console_app(1,title,reply)==launch_result);assert(launch_calls==2);launch_result=0x60000001;
 active_id=0x60000001;assert(console_app(1,title,reply)==-1023);assert(console_app(3,title,reply)==-1024);assert(console_app(4,title,reply)==-1024);assert(console_app(2,title,reply)==0);assert(close_calls==1);
 active_id=-1;assert(console_app(3,title,reply)==0);assert(remove_calls==1&&patch_calls==0);assert(console_app(4,title,reply)==0);assert(patch_calls==1&&remove_calls==1);
 assert(console_app(99,title,reply)==-1010);assert(off_calls==0&&reboot_calls==0&&rest_calls==0&&fallback_calls==0);
 assert(console_power(1)==0);assert(off_calls==1&&reboot_calls==0&&rest_calls==0&&fallback_calls==0);
 assert(console_power(2)==0);assert(reboot_calls==1&&off_calls==1&&rest_calls==0);
 assert(console_power(3)==0);assert(rest_calls==1&&reboot_calls==1&&off_calls==1);
 assert(console_power(99)==-1010);assert(launch_calls==2&&close_calls==1&&remove_calls==1&&patch_calls==1);
 state_off=NULL;assert(console_power(1)==0);assert(fallback_calls==4);
 char parsed[10];assert(title_field((const uint8_t*)"CUSA12345",9,parsed)==0);assert(title_field((const uint8_t*)"NPXS20001",9,parsed)==-1010);
 puts("PASS: native launch/close/removal dispatch cannot invoke power; power actions are distinct; launch ABI and errors checked.");return 0;
}

// SPDX-License-Identifier: GPL-3.0-or-later
// Public scene ABIs: Itemzflow, PS4-daemon-writeup, Scene-Collective SDK.
void *existing_symbol(const char*);
void *packed_symbol(void*,const char*,const char*,void*);
#include "build/nids.h"
int psn_statfs(const char*,void*);
int psn_evf_open(const char*); int psn_evf_clear(int,uint64_t,int);
int psn_evf_close(int); int psn_kill(int,int);
struct launch_param { uint32_t size,user,option; uint64_t crash; uint32_t flags; };
_Static_assert(sizeof(struct launch_param)==32,"launch ABI");
static int (*app_exists)(const char*,int*),(*app_id)(const char*);
static int (*app_launch)(const char*,const char**,struct launch_param*);
static int (*app_kill)(uint32_t,int,int,int),(*app_remove)(const char*),(*patch_remove)(const char*);
static int (*kernel_reboot)(void),(*enter_standby)(int);
static int (*state_reboot)(void),(*state_off)(void);
static uint32_t console_caps;
static uint32_t console_symbols;
static int console_module;
static int console_init(void) {
 int r=initialize();if(r)return r;
 if(console_caps)return 0;
 void *s=dlopen("/system/common/lib/libSceSystemService.sprx",0);
 console_module=(int)(long long)s;
 app_exists=existing_symbol("sceAppInstUtilAppExists");
 app_id=existing_symbol("sceLncUtilGetAppId");
 app_launch=existing_symbol("sceLncUtilLaunchApp");
 app_kill=existing_symbol("sceSystemServiceKillApp");
 app_remove=existing_symbol("sceAppInstUtilAppUnInstall");
 patch_remove=existing_symbol("sceAppInstUtilAppUnInstallPat");
 kernel_reboot=existing_symbol("sceKernelReboot");
 enter_standby=existing_symbol("sceSystemStateMgrEnterStandby");
 if(s){
  if(!app_id)app_id=dlsym(s,"sceLncUtilGetAppId");
  if(!app_launch)app_launch=dlsym(s,"sceLncUtilLaunchApp");
  if(!app_kill)app_kill=dlsym(s,"sceSystemServiceKillApp");
  if(!enter_standby)enter_standby=dlsym(s,"sceSystemStateMgrEnterStandby");
  void *anchor=dlsym(s,"sceSystemServiceLaunchApp");
  if(!app_id)app_id=packed_symbol(s,NID_sceLncUtilGetAppId,NID_sceSystemServiceLaunchApp,anchor);
  if(!app_launch)app_launch=packed_symbol(s,NID_sceLncUtilLaunchApp,NID_sceSystemServiceLaunchApp,anchor);
  if(!enter_standby)enter_standby=packed_symbol(s,NID_sceSystemStateMgrEnterStandby,NID_sceSystemServiceLaunchApp,anchor);
  state_reboot=packed_symbol(s,NID_sceSystemStateMgrReboot,NID_sceSystemServiceLaunchApp,anchor);
  state_off=packed_symbol(s,NID_sceSystemStateMgrTurnOff,NID_sceSystemServiceLaunchApp,anchor);
 }
 console_symbols=(!!app_exists)|((!!app_id)<<1)|((!!app_launch)<<2)|((!!app_kill)<<3)|((!!app_remove)<<4)|((!!patch_remove)<<5)|((!!kernel_reboot)<<6)|((!!enter_standby)<<7);
 console_caps=1|64;
 if(app_exists && app_id)console_caps|=2;
 if(app_launch && app_id)console_caps|=4;
 if(app_kill && app_id)console_caps|=8;
 if(app_remove && app_id && app_exists)console_caps|=16;
 if(patch_remove && app_id && app_exists)console_caps|=32;
 if(kernel_reboot)console_caps|=128;
 if(enter_standby)console_caps|=256;
 return 0;
}
static int title_field(const uint8_t *p,uint32_t size,char *out) {
 if(size!=9)return -1010;
 if(p[0]!='C'||p[1]!='U'||p[2]!='S'||p[3]!='A')return -1010;
 for(int i=4;i<9;i++)if(p[i]<'0'||p[i]>'9')return -1010;
 memcpy(out,p,9);out[9]=0;return 0;
}
static int game_running(int id){return ((uint32_t)id&0xff000000)==0x60000000;}
static int console_storage(uint32_t index,uint8_t *out) {
 const char *roots[]={"/user","/mnt/ext0","/mnt/ext1"};
 if(index>2)return -1010;
 // FreeBSD 9 statfs: fixed prefix; oversized buffer accommodates newer tails.
 uint64_t buffer[1024];memset(buffer,0,sizeof(buffer));
 if(psn_statfs(roots[index],buffer))return -1021;
 uint8_t *p=(uint8_t*)buffer;uint64_t bsize,blocks,free,available;
 memcpy(&bsize,p+16,8);memcpy(&blocks,p+32,8);memcpy(&free,p+40,8);memcpy(&available,p+48,8);
 if(!bsize || bsize>1048576 || blocks>0xffffffffffffffffULL/bsize)return -1021;
 uint64_t values[3]={bsize*blocks,bsize*free,(int64_t)available<0?0:bsize*available};
 memcpy(out,values,24);memcpy(out+24,p+192,8);memcpy(out+32,p+384,88);out[119]=0;
 return 0;
}
static int console_app(uint32_t action,char *title,uint8_t *out) {
 if(!app_id || !app_exists)return -1013;
 int exists=0,r=app_exists(title,&exists);if(r)return r;
 int id=app_id(title),running=game_running(id);
 if(id<0 && id!=-1)return id;
 if(!action){memcpy(out,&exists,4);memcpy(out+4,&id,4);memcpy(out+8,&running,4);return 0;}
 if(!exists)return -1022;
 if(action==1){
  if(!app_launch)return -1013;if(running)return -1023;
  int current_user=-1;if(existing_user(&current_user))return -1004;
  struct launch_param p={.size=sizeof(p),.user=(uint32_t)current_user,.flags=2};
  r=app_launch(title,NULL,&p);return r<0?r:0;
 }
 if(action==2){if(!running || !app_kill)return -1023;return app_kill((uint32_t)id,-1,0,0);}
 if(action!=3 && action!=4)return -1010;
 // Refuse a running title. Never kill an app implicitly to uninstall it.
 if(running)return -1024;
 if(action==3)return app_remove?app_remove(title):-1013;
 return patch_remove?patch_remove(title):-1013;
}
static int console_power(uint32_t action) {
 if(action==1){
  if(state_off)return state_off();
  // Scene-Collective's PS4 shutdown sequence: request orderly SysCore poweroff.
  int evf=psn_evf_open("SceSysCoreReboot");if(evf<0)return -1025;
  int r=psn_evf_clear(evf,0x4000,0);psn_evf_close(evf);if(r)return r;
  return psn_kill(1,30);
 }
 if(action==2)return state_reboot?state_reboot():(kernel_reboot?kernel_reboot():-1013);
 if(action==3)return enter_standby?enter_standby(0):-1013;
 return -1010;
}

// SPDX-License-Identifier: GPL-3.0-or-later
// PS5 public service ABI references are listed in receiver-ps5/README.md.
// All service calls run serially in this companion, never inside ShellUI.
#include <dlfcn.h>
#include <stdio.h>
#include <stddef.h>
#include <sys/stat.h>
#include <ps5/kernel.h>
#include "install-abi.h"

struct launch_context { uint32_t size,user,options; uint64_t crash; uint32_t flags; };
static struct install_meta active_meta;
static struct install_pkg active_pkg;
static struct install_playgo active_playgo;
static char active_name[256],active_url[768];
static int active_task,active_finished=1;
static uint64_t active_size;static uint32_t active_type;static int active_patch;
_Static_assert(sizeof(struct launch_context)==32,"PS5 launch context ABI");
static int (*get_app_id)(const char*),(*kill_app)(int,int,int,int);
static int (*launch_app)(const char*,const char**,struct launch_context*);
static int (*user_init)(const void*),(*get_user)(int*),(*lnc_init)(void);
static int (*remove_app)(const char*,int*,int*);
static int (*remove_patch)(const char*);
static int (*shutdown_console)(int),(*restart_console)(void),(*rest_console)(int);
static int (*installer_init)(void),(*install_package)(struct install_meta*,struct install_pkg*,struct install_playgo*);
static int (*get_install_status)(const char*,struct install_status*);
static int (*get_patch_status)(const char*,struct install_status*);
static int (*pause_install)(const char*),(*resume_install)(const char*);
static int (*pause_patch)(const char*),(*resume_patch)(const char*);
static uint32_t service_symbols;static int installer_ready,auth_broken;

static void service_resolve(void){
 if(service_symbols)return;
 // SystemService/UserService already belong to kernel_web's symbol scope.
 // Explicitly loading them can hang on 13.60. Discovery never loads a module.
#define SYM(target,name) target=dlsym(RTLD_DEFAULT,name)
 SYM(get_app_id,"sceLncUtilGetAppId");SYM(kill_app,"sceSystemServiceKillApp");
 SYM(launch_app,"sceSystemServiceLaunchApp");SYM(user_init,"sceUserServiceInitialize");
 SYM(get_user,"sceUserServiceGetForegroundUser");SYM(lnc_init,"sceLncUtilInitialize");
 SYM(remove_app,"sceAppInstUtilAppUnInstall");
 SYM(remove_patch,"sceAppInstUtilAppUnInstallPat");
 SYM(shutdown_console,"sceShellCoreUtilRequestShutdown");
 SYM(restart_console,"sceSystemServiceRequestReboot");SYM(rest_console,"sceSystemStateMgrEnterStandby");
 SYM(installer_init,"sceAppInstUtilInitialize");SYM(install_package,"sceAppInstUtilInstallByPackage");
 SYM(get_install_status,"sceAppInstUtilGetInstallStatus");
 SYM(get_patch_status,"sceAppInstUtilGetPatchInstallStatus");
 SYM(pause_install,"sceAppInstUtilPauseInstall");SYM(resume_install,"sceAppInstUtilResumeInstall");
 SYM(pause_patch,"sceAppInstUtilPausePatchInstall");SYM(resume_patch,"sceAppInstUtilResumePatchInstall");
#undef SYM
 service_symbols= (!!get_app_id)|((!!kill_app)<<1)|((!!launch_app)<<2)|((!!get_user)<<3)|((!!remove_app)<<4)|((!!shutdown_console)<<5)|((!!restart_console)<<6)|((!!rest_console)<<7)|((!!installer_init)<<8)|((!!install_package)<<9)|((!!remove_patch)<<10);
}
static uint32_t service_caps(void){
 service_resolve();uint32_t caps=1;
 if(get_app_id)caps|=2;
 if(get_app_id&&launch_app&&get_user&&user_init&&lnc_init)caps|=4;
 if(get_app_id&&kill_app)caps|=8;
 if(get_app_id&&remove_app&&installer_init)caps|=16;
 // The one-title-argument patch wrapper was inspected on 13.60. Keep other
 // firmware revisions disabled until their contract has been validated.
 uint32_t firmware=0;size_t fw_size=sizeof firmware;
 if(!sysctlbyname("kern.sdk_version",&firmware,&fw_size,0,0)&&(firmware>>16)==0x1360&&get_app_id&&remove_patch&&installer_init)caps|=32;
 if(shutdown_console)caps|=64;if(restart_console)caps|=128;if(rest_console)caps|=256;
 return caps;
}
static int valid_title(const uint8_t *data,uint32_t length,char title[10]){
 if(length!=9||(memcmp(data,"CUSA",4)&&memcmp(data,"PPSA",4)&&memcmp(data,"MOUU",4)))return -1010;
 for(int i=4;i<9;i++)if(data[i]<'0'||data[i]>'9')return -1010;
 memcpy(title,data,9);title[9]=0;return 0;
}
static int auth_begin(uint64_t requested,uint64_t *saved){
 if(auth_broken)return -1030;
 *saved=kernel_get_ucred_authid(getpid());if(!*saved||*saved==UINT64_MAX)return -1030;
 if(kernel_set_ucred_authid(getpid(),requested)||kernel_get_ucred_authid(getpid())!=requested){
  if(kernel_set_ucred_authid(getpid(),*saved)||kernel_get_ucred_authid(getpid())!=*saved)auth_broken=1;
  return -1030;
 }return 0;
}
static int auth_end(uint64_t saved,int result){
 for(int i=0;i<3;i++)if(!kernel_set_ucred_authid(getpid(),saved)&&kernel_get_ucred_authid(getpid())==saved)return result;
 auth_broken=1;return -1030;
}
static int init_installer(void){
 service_resolve();if(installer_ready)return 0;
 if(!installer_init||!install_package){
  dlopen("/system/common/lib/libSceAppInstUtil.sprx",RTLD_LAZY);
  installer_init=dlsym(RTLD_DEFAULT,"sceAppInstUtilInitialize");
  install_package=dlsym(RTLD_DEFAULT,"sceAppInstUtilInstallByPackage");
 }if(!installer_init||!install_package)return -1013;
 uint64_t saved;int r=auth_begin(0x4801000000000013ULL,&saved);if(r)return r;
 r=auth_end(saved,installer_init());if(!r)installer_ready=1;return r;
}
static int app_query(const char *title,int out[3]){
 if(!get_app_id)return -1013;
 char location[64];struct stat st;snprintf(location,sizeof location,"/user/app/%s",title);
 out[0]=!stat(location,&st)&&S_ISDIR(st.st_mode);
 // PS5 LncUtil returns small nonnegative application IDs (BO2: 24), not
 // PS4's 0x60000000 family. -1 means no running application for this title.
 int id=get_app_id(title);out[1]=id;out[2]=id>=0;
 // Unknown negative results are errors, not proof that a title is closed.
 if(id<0&&id!=-1)return id;return 0;
}
static int app_action(uint32_t action,const char *title){
 int info[3],r=app_query(title,info);if(r)return r;if(!info[0])return -1022;
 if(action==1){
  if(!(service_caps()&4))return -1013;if(info[2])return -1023;
  uint64_t saved;r=auth_begin(0x4801000000000013ULL,&saved);if(r)return r;
  int priority=256;user_init(&priority);lnc_init();int user=-1;r=get_user(&user);
  if(!r&&user>0){struct launch_context ctx={.size=sizeof ctx,.user=(uint32_t)user};const char *argv[]={NULL};r=launch_app(title,argv,&ctx);if(r>=0)r=0;}
  else if(!r)r=-1004;
  return auth_end(saved,r);
 }
 if(action==2){if(!kill_app||!info[2])return -1023;return kill_app(info[1],-1,0,0);}
 if(action==3||action==4){
  if(info[2])return -1024;if(!(service_caps()&(action==3?16:32)))return -1013;
  if(action==4){char location[64];struct stat st;snprintf(location,sizeof location,"/user/patch/%s",title);if(stat(location,&st)||!S_ISDIR(st.st_mode))return -1022;}
  r=init_installer();if(r)return r;
  uint64_t saved;r=auth_begin(0x3800000000000010ULL,&saved);if(r)return r;
  return auth_end(saved,action==3?remove_app(title,NULL,NULL):remove_patch(title));
 }return -1013;
}
static int power_action(uint32_t action){
 if(action==1)return shutdown_console?shutdown_console(2):-1013;
 if(action==2)return restart_console?restart_console():-1013;
 if(action==3)return rest_console?rest_console(0):-1013;return -1010;
}
static int read_string(const uint8_t **p,uint32_t *remaining,char *out,uint32_t capacity){
 if(*remaining<4)return -1010;uint32_t n;memcpy(&n,*p,4);*p+=4;*remaining-=4;
 if(n>=capacity||n>*remaining||memchr(*p,0,n))return -1010;
 memcpy(out,*p,n);out[n]=0;*p+=n;*remaining-=n;return 0;
}
static int submit_package(const uint8_t *data,uint32_t length){
 if(!active_finished)return -1031;
 if(length<12)return -1010;
 uint32_t firmware=0;size_t fw_size=sizeof firmware;
 if(sysctlbyname("kern.sdk_version",&firmware,&fw_size,0,0)||(firmware>>16)!=0x1360)return -1032;
 char content[40],name[256],url[768];const uint8_t *p=data+12;uint32_t left=length-12;
 if(read_string(&p,&left,content,sizeof content)||read_string(&p,&left,name,sizeof name)||read_string(&p,&left,url,sizeof url)||left)return -1010;
 uint32_t package_type;memcpy(&package_type,data+8,4);
 if(!psn_install_content_valid(content,package_type))return -1010;
 // Local staging is restricted to files placed by this application's FTP workflow.
 // Accept the previous staging path for existing clients as well.
 if(strncmp(url,"http://",7)&&strncmp(url,"/data/ps-neighborhood-pkgs/",sizeof("/data/ps-neighborhood-pkgs/")-1)&&strncmp(url,"/data/ps-neighbourhood-pkgs/",sizeof("/data/ps-neighbourhood-pkgs/")-1))return -1010;
 if(strstr(url,"..")||strchr(url,'\\'))return -1010;
 int r=init_installer();if(r)return r;
 // Native arguments remain alive until the system finishes using them.
 strcpy(active_url,url);size_t name_length=strlen(name);if(name_length>127){name_length=127;while(((uint8_t)name[name_length]&0xc0)==0x80)name_length--;}
 memcpy(active_name,name,name_length);active_name[name_length]=0;
 memset(&active_pkg,0,sizeof active_pkg);memset(&active_playgo,0,sizeof active_playgo);
 active_meta=(struct install_meta){.uri=active_url,.extra="",.scenario="",.content="",.name=active_name,.icon="",.option=0,.flag=0};
 uint64_t saved;r=auth_begin(0x4801000000000013ULL,&saved);if(r)return r;
 memcpy(&active_size,data,8);memcpy(&active_type,data+8,4);active_patch=!!(active_type&0x80000000u);active_type&=0x7fffffffu;
 if(active_patch&&!get_patch_status)return auth_end(saved,-1013);active_finished=0;
 r=auth_end(saved,install_package(&active_meta,&active_pkg,&active_playgo));
 if(!r){active_pkg.content[47]=0;active_task++;}return r;
}
static int package_progress(int task,uint8_t *out){
 if(task!=active_task||task<=0||!get_install_status)return -1010;
 struct install_status s;memset(&s,0,sizeof s);uint64_t saved;int r=auth_begin(0x4801000000000013ULL,&saved);if(r)return r;
 r=auth_end(saved,(active_patch?get_patch_status:get_install_status)(active_pkg.content,&s));if(r)return r;
 s.state[15]=0;memset(out,0,80);
 // A playable initial chunk alone is not a completed download.
 uint32_t done=psn_install_complete(&s,active_size,active_type);
 if(done)active_finished=1;
 memcpy(out,&done,4);memcpy(out+4,&s.error.code,4);
 memcpy(out+8,&s.total,8);memcpy(out+16,&s.downloaded,8);memcpy(out+24,&s.total,8);memcpy(out+32,&s.downloaded,8);
 memcpy(out+52,&s.seconds,4);memcpy(out+56,&s.promote,4);memcpy(out+64,s.state,16);
 return 0;
}
static int package_control(int task,int pause){
 if(task!=active_task||task<=0||active_finished)return -1010;
 int (*fn)(const char*)=active_patch?(pause?pause_patch:resume_patch):(pause?pause_install:resume_install);if(!fn)return -1013;
 uint64_t saved;int r=auth_begin(0x4801000000000013ULL,&saved);if(r)return r;
 return auth_end(saved,fn(active_pkg.content));
}

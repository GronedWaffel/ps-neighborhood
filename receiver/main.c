// SPDX-License-Identifier: GPL-3.0-or-later
// PS Neighbourhood background receiver. BGFT ABI follows flatz and marcussacana.
#include <stdint.h>
#include <stddef.h>
#include "vendor/ps4-libjbc/jailbreak.h"
#include "firmware.h"

struct __attribute__((packed)) configuration { char magic[16]; uint32_t addr; uint16_t port; uint16_t reserved; uint8_t token[32]; };
volatile struct configuration config = { .magic = "PSNRECEIVERCFG01", .addr = 0xb4b4b4b4, .port = 0xb4b4 };
struct sockaddr_in { uint8_t len, family; uint16_t port; uint32_t addr; uint8_t zero[8]; };
struct timeval { long sec, usec; };
int socket(int,int,int); int connect(int,const void*,int); int setsockopt(int,int,int,const void*,int);
void *mmap(void*,size_t,int,int,int,long); int munmap(void*,size_t);
void *dlopen(const char*,int); void *dlsym(void*,const char*);
int existing_user(int*);
void *memset(void *p, int c, size_t n) { uint8_t *b=p; while(n--) *b++=(uint8_t)c; return p; }
void *memcpy(void *d,const void *s,size_t n) { uint8_t *a=d; const uint8_t *b=s; while(n--) *a++=*b++; return d; }

struct init_params { void *mem; size_t size; };
struct download_params {
 int user, entitlement; const char *id,*url,*ex_url,*name,*icon,*sku;
 uint32_t option; const char *scenario,*release,*type,*subtype; uint64_t size;
};
struct progress_info { uint32_t bits; int32_t error; uint64_t length,transferred,total,done; uint32_t index,count,remaining,remaining_total; int32_t preparing,copy; };
_Static_assert(sizeof(struct download_params)==104,"BGFT download ABI");
_Static_assert(sizeof(struct progress_info)==64,"BGFT progress ABI");
struct frame { uint32_t magic,id,code,length; };
static int (*bg_init)(struct init_params*), (*reg_task)(struct download_params*,int*), (*reg_debug)(struct download_params*,int*);
static int (*start_task)(int), (*get_progress)(int,struct progress_info*), (*pause_task)(int), (*resume_task)(int);
static int (*bg_term)(void); static int owns_bgft;
static int user, initialized, stage, last_task=-1;
static struct init_params bg_memory;
static char package_id[40],package_name[256],package_url[768],package_type[8];

static int exact(int fd,void *buf,size_t size,int sending) {
 uint8_t *p=buf; while(size) { long n=sending?write(fd,p,size):read(fd,p,size); if(n<=0) return -1; p+=n;size-=n; } return 0;
}
static int response(int fd,uint32_t id,int code,void *data,uint32_t size) {
 struct frame h={0x52534e50,id,(uint32_t)code,size};
 return exact(fd,&h,sizeof(h),1) || (size && exact(fd,data,size,1));
}
static int initialize(void) {
 if(initialized) return 0;
 stage=40;if(!firmware_target(firmware_version()))return -1040;
 stage=1; struct jbc_cred cred;
 if(jbc_get_cred(&cred) || jbc_jailbreak_cred(&cred)) return -1001;
 cred.jdir=0;
 if(jbc_set_cred(&cred)) return -1002;
 stage=2;
 // GoldHEN may host multiple UserService instances. Reuse a working instance
 // before loading or initializing another one with conflicting named objects.
 int have_user=existing_user(&user)==0;
 if(!have_user) {
  void *u=dlopen("/system/common/lib/libSceUserService.sprx",0);
  if(!u)return -1003;
  int (*uinit)(void*)=dlsym(u,"sceUserServiceInitialize");
  int (*getuser)(int*)=dlsym(u,"sceUserServiceGetForegroundUser");
  if(!uinit || !getuser)return -1004;
  stage=30;int r=uinit(NULL);if(r && (uint32_t)r!=0x80960003)return r;
  stage=3;r=getuser(&user);if(r)return r;
 }
 stage=2;
 void *a=dlopen("/system/common/lib/libSceAppInstUtil.sprx",0);
 void *b=dlopen("/system/common/lib/libSceBgft.sprx",0);
 if(!a || !b) return -1003;
 int (*ainit)(void)=dlsym(a,"sceAppInstUtilInitialize");
 bg_init=dlsym(b,"sceBgftServiceIntInit");
 bg_term=dlsym(b,"sceBgftServiceIntTerm");
 reg_task=dlsym(b,"sceBgftServiceDownloadRegisterTask");
 reg_debug=dlsym(b,"sceBgftServiceIntDebugDownloadRegisterPkg");
 start_task=dlsym(b,"sceBgftServiceIntDownloadStartTask");
 get_progress=dlsym(b,"sceBgftServiceDownloadGetProgress");
 pause_task=dlsym(b,"sceBgftServiceDownloadPauseTask");
 resume_task=dlsym(b,"sceBgftServiceDownloadResumeTask");
 if(!ainit || !bg_init || !reg_task || !reg_debug || !start_task) return -1004;
 stage=4; int r=ainit();if(r) return r;
 stage=5;
 if(!bg_memory.mem) { bg_memory.size=0x100000; bg_memory.mem=mmap(NULL,bg_memory.size,3,0x1002,-1,0); }
 if(bg_memory.mem==(void*)-1) {bg_memory.mem=NULL;return -1005;}
 r=bg_init(&bg_memory);if(r && (uint32_t)r!=0x80990001) return r;
 if((uint32_t)r==0x80990001){munmap(bg_memory.mem,bg_memory.size);bg_memory.mem=NULL;}
 else owns_bgft=1;
 initialized=1;stage=0;return 0;
}
static int string_field(uint8_t **cursor,uint32_t *left,char *out,uint32_t capacity) {
 if(*left<4)return -1; uint32_t size; memcpy(&size,*cursor,4);*cursor+=4;*left-=4;
 if(!size || size>=capacity || size>*left)return -1;
 for(uint32_t i=0;i<size;i++) if(!(*cursor)[i])return -1;
 memcpy(out,*cursor,size);out[size]=0;*cursor+=size;*left-=size;return 0;
}
static int install(uint8_t *body,uint32_t len,int *task) {
 stage=6;if(len<12)return -1010;
 uint64_t size;uint32_t type;memcpy(&size,body,8);memcpy(&type,body+8,4);body+=12;len-=12;
 if(!size || string_field(&body,&len,package_id,sizeof(package_id)) || string_field(&body,&len,package_name,sizeof(package_name)) || string_field(&body,&len,package_url,sizeof(package_url)) || len)return -1010;
 if(package_url[0]!='h'||package_url[1]!='t'||package_url[2]!='t'||package_url[3]!='p'||package_url[4]!=':'||package_url[5]!='/'||package_url[6]!='/')return -1010;
 if(type==0x1a)memcpy(package_type,"PS4GD",6);else if(type==0x1b)memcpy(package_type,"PS4AC",6);else if(type==0x1c)memcpy(package_type,"PS4AL",6);else if(type==0x1e)memcpy(package_type,"PS4DP",6);else return -1010;
 int r=initialize();if(r)return r;
 struct download_params p={.user=user,.entitlement=5,.id=package_id,.url=package_url,.name=package_name,.icon="",.option=0x10000,.scenario="0",.type=package_type,.subtype="",.size=size};
 *task=-1;stage=7;r=reg_task(&p,task);
 if(r && *task==-1 && (uint32_t)r!=0x80990088) {stage=8;r=reg_debug(&p,task);}
 if(r)return r;if(*task<0)return -1011;
 last_task=*task;stage=9;r=start_task(*task);if(!r)stage=0;return r;
}
#include "console.h"
int main(void) {
 struct sockaddr_in to={.len=16,.family=2,.port=config.port,.addr=config.addr};
 int fd=socket(2,1,6);if(fd<0)return -1;
 struct timeval timeout={15,0};setsockopt(fd,0xffff,0x1005,&timeout,sizeof(timeout));setsockopt(fd,0xffff,0x1006,&timeout,sizeof(timeout));
 if(connect(fd,&to,sizeof(to))){close(fd);return -2;}
 uint8_t hello[36];memcpy(hello,(const void*)config.token,32);uint32_t version=1;memcpy(hello+32,&version,4);
 if(response(fd,0,0,hello,sizeof(hello))){close(fd);return -3;}
 uint8_t body[2048];
 for(;;){
  struct frame h;if(exact(fd,&h,sizeof(h),0))break;
  if(h.magic!=0x43534e50 || !h.id || h.length>sizeof(body))break;
  if(h.length && exact(fd,body,h.length,0))break;
  int r=0;uint32_t size=0;
  if(h.code==1 && !h.length){} // heartbeat; no credentials or BGFT calls
  else if(h.code==2 && !h.length){r=initialize();memcpy(body,&stage,4);size=4;}
  else if(h.code==3){int task=-1;r=install(body,h.length,&task);memcpy(body,&task,4);memcpy(body+4,&stage,4);size=8;}
  else if(h.code>=4 && h.code<=6 && h.length==4){
   int task;memcpy(&task,body,4);if(!initialized || task<0 || task!=last_task)r=-1012;
   else if(h.code==4){struct progress_info p;memset(&p,0,sizeof(p));r=get_progress?get_progress(task,&p):-1013;if(!r){memcpy(body,&p,sizeof(p));size=sizeof(p);}}
   else if(h.code==5)r=pause_task?pause_task(task):-1013;
   else r=resume_task?resume_task(task):-1013;
  }
  else if(h.code==7 && !h.length){response(fd,h.id,0,NULL,0);break;}
  else if(h.code==8 && !h.length){r=console_init();if(!r){memcpy(body,&console_caps,4);memcpy(body+4,&console_symbols,4);memcpy(body+8,&console_module,4);size=12;}}
  else if(h.code==9 && h.length==4){uint32_t index;memcpy(&index,body,4);r=console_init();if(!r)r=console_storage(index,body);if(!r)size=120;}
  else if(h.code==10 && h.length==9){char title[10];r=title_field(body,h.length,title);if(!r)r=console_init();if(!r)r=console_app(0,title,body);if(!r)size=12;}
  else if(h.code==11 && h.length==13){char title[10];uint32_t action;memcpy(&action,body,4);r=title_field(body+4,9,title);if(!r)r=console_init();if(!r)r=console_app(action,title,body);}
  else if(h.code==12 && h.length==4){uint32_t action;memcpy(&action,body,4);r=console_init();if(!r)r=console_power(action);}
  else if(h.code==13 && !h.length){uint32_t info[3]={firmware_version(),0,2};info[1]=firmware_target(info[0]);memcpy(body,info,sizeof(info));size=sizeof(info);}
  else r=-1010;
  if(response(fd,h.id,r,body,size))break;
 }
 close(fd); // BGFT owns the submitted download after this receiver exits.
 if(owns_bgft && bg_term && bg_term()==0){munmap(bg_memory.mem,bg_memory.size);bg_memory.mem=NULL;}
 else if(!owns_bgft && bg_memory.mem)munmap(bg_memory.mem,bg_memory.size);
 return 0;
}

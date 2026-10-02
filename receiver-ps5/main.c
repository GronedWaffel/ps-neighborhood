// SPDX-License-Identifier: GPL-3.0-or-later
// PS5 companion using PS5 SDK service ABIs, without PS4 payload code.
#include <sys/param.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <netinet/in.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include "services.h"
#include "saves.h"

struct __attribute__((packed)) configuration {
 char magic[16]; uint32_t addr; uint16_t port, reserved; uint8_t token[32];
};
volatile struct configuration config={.magic="PSNRECEIVERCFG01",.addr=0xb4b4b4b4,.port=0xb4b4};
struct frame {uint32_t magic,id,code,length;};
static int exact(int fd,void *data,size_t length,int sending){
 uint8_t *p=data;
 while(length){ssize_t n=sending?write(fd,p,length):read(fd,p,length);if(n<0&&errno==EINTR)continue;if(n<=0)return -1;p+=n;length-=n;}
 return 0;
}
static int response(int fd,uint32_t id,int code,void *data,uint32_t size){
 struct frame h={0x52534e50,id,(uint32_t)code,size};
 return exact(fd,&h,sizeof h,1)||(size&&exact(fd,data,size,1));
}
#include "shadowmount.h"
static int storage(uint32_t index,uint8_t *out){
 const char *roots[]={"/user","/mnt/ext0","/mnt/ext1","/user2","/mnt/ext2","/mnt/ext3","/mnt/ext4","/mnt/ext5","/mnt/ext6","/mnt/ext7","/mnt/usb0","/mnt/usb1","/mnt/usb2","/mnt/usb3","/mnt/usb4","/mnt/usb5","/mnt/usb6","/mnt/usb7"};
 if(index>=sizeof roots/sizeof roots[0])return -1010;
 struct statfs s;memset(&s,0,sizeof s);
 if(statfs(roots[index],&s))return -1021;
 uint64_t bs=s.f_bsize;
 if(!bs||bs>1048576||s.f_blocks>UINT64_MAX/bs||s.f_bfree>s.f_blocks)return -1021;
 uint64_t available=s.f_bavail>0?(uint64_t)s.f_bavail:0;
 if(available>s.f_bfree)return -1021;
 uint64_t sizes[]={bs*s.f_blocks,bs*s.f_bfree,bs*available};
 memset(out,0,224);memcpy(out,sizes,sizeof sizes);memcpy(out+24,&s.f_fsid,8);
 strncpy((char*)out+32,s.f_mntonname,87);
 strncpy((char*)out+120,s.f_fstypename,15);
 strncpy((char*)out+136,s.f_mntfromname,87);return 0;
}
int main(void){
 signal(SIGPIPE,SIG_IGN);
 int fd=socket(AF_INET,SOCK_STREAM,0);if(fd<0)return 1;
 struct sockaddr_in dest;memset(&dest,0,sizeof dest);dest.sin_len=sizeof dest;dest.sin_family=AF_INET;dest.sin_addr.s_addr=config.addr;dest.sin_port=config.port;
 struct timeval timeout={15,0};setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof timeout);setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof timeout);
 if(connect(fd,(struct sockaddr*)&dest,sizeof dest)){close(fd);return 2;}
 uint8_t body[2048];memcpy(body,(const void*)config.token,32);uint32_t protocol=1;memcpy(body+32,&protocol,4);
 if(response(fd,0,0,body,36)){close(fd);return 3;}
 for(;;){
  struct frame h;if(exact(fd,&h,sizeof h,0)||h.magic!=0x43534e50||h.length>sizeof body)break;
  if(h.length&&exact(fd,body,h.length,0))break;
  // A stuck Sony service must not leave an orphaned companion indefinitely.
  // SIGALRM terminates only this dedicated ELF process; never retry a mutation.
  alarm(12);
  int r=0;uint32_t size=0;
  if(h.code==1&&!h.length){}
  else if(h.code==7&&!h.length){response(fd,h.id,0,0,0);break;}
  else if(h.code==8&&!h.length){uint32_t caps[3]={service_caps()|(save_available()?512:0),service_symbols,0};memcpy(body,caps,sizeof caps);size=sizeof caps;}
  else if(h.code==9&&h.length==4){uint32_t index;memcpy(&index,body,4);r=storage(index,body);if(!r)size=224;}
  else if(h.code==13&&!h.length){uint32_t info[3]={0,0,107};size_t n=4;r=sysctlbyname("kern.sdk_version",&info[0],&n,0,0);info[1]=1;if(!r){memcpy(body,info,sizeof info);size=sizeof info;}}
  else if(h.code==23){uint8_t *reply=NULL;r=shadow_request(body,h.length,&reply,&size);alarm(0);int failed=response(fd,h.id,r,reply,size);free(reply);if(failed)break;continue;}
  else if(h.code==18){r=save_mount_session(body,h.length);}
  else if(h.code==19){r=save_unmount_session(body,h.length);}
  else if(h.code==20&&!h.length){memset(body,0,40);uint32_t mounted=save_mounted;memcpy(body,&mounted,4);if(mounted)memcpy(body+4,save_session,36);size=40;}
  else if(h.code==21){r=save_target_info(body,h.length,body);if(!r)size=sizeof(struct save_stamp);}
  else if(h.code==22){r=save_commit(body,h.length);}
  else if(h.code==2&&!h.length){r=init_installer();uint32_t stage=4;memcpy(body,&stage,4);size=4;}
  else if(h.code==3){r=submit_package(body,h.length);int32_t install[2]={r?-1:active_task,4};memcpy(body,install,8);size=8;}
  else if(h.code==4&&h.length==4){int task;memcpy(&task,body,4);r=package_progress(task,body);if(!r)size=80;}
  else if((h.code==5||h.code==6)&&h.length==4){int task;memcpy(&task,body,4);r=package_control(task,h.code==5);}
  else if(h.code==10){char title[10];r=valid_title(body,h.length,title);if(!r){service_resolve();int info[3];r=app_query(title,info);if(!r){memcpy(body,info,12);size=12;}}}
  else if(h.code==11&&h.length==13){uint32_t action;memcpy(&action,body,4);char title[10];r=valid_title(body+4,9,title);if(!r){service_resolve();r=app_action(action,title);}}
  else if(h.code==12&&h.length==4){uint32_t action;memcpy(&action,body,4);service_resolve();r=power_action(action);}
#ifdef PSN_SERVICE_DIAGNOSTIC
  else if(h.code==17&&!h.length){
   const char *names[]={"sceAppInstUtilPausePatchInstall","sceAppInstUtilResumePatchInstall","sceAppInstUtilPausePatch","sceAppInstUtilResumePatch","sceAppInstUtilPausePatchDownload","sceAppInstUtilResumePatchDownload","sceAppInstUtilPauseUpdate","sceAppInstUtilResumeUpdate","sceAppInstUtilSuspendPatchInstall","sceAppInstUtilContinuePatchInstall"};
   memset(body,0,sizeof body);for(int i=0;i<10;i++){void *fn=dlsym(RTLD_DEFAULT,names[i]);memcpy(body+i*8,&fn,8);}size=80;
  }
  else if(h.code==16&&h.length==36){
   char content[37];memcpy(content,body,36);content[36]=0;r=init_installer();
   int (*status)(const char*,struct install_status*)=dlsym(RTLD_DEFAULT,"sceAppInstUtilGetPatchInstallStatus");
   if(!r&&status){uint64_t saved;r=auth_begin(0x4801000000000013ULL,&saved);if(!r){memset(body,0,sizeof body);r=auth_end(saved,status(content,(struct install_status*)body));size=712;}}
  }
  else if(h.code==15&&h.length==36){
   char content[37];memcpy(content,body,36);content[36]=0;r=init_installer();
   if(!r){uint64_t saved;r=auth_begin(0x4801000000000013ULL,&saved);if(!r){memset(body,0,sizeof body);r=auth_end(saved,get_install_status(content,(struct install_status*)body));size=712;}}
  }
  else if(h.code==14&&!h.length){
   service_resolve();const char *symbols[]={"sceAppInstUtilGetPatchInstallStatus","sceAppInstUtilPauseInstall","sceAppInstUtilResumeInstall","sceAppInstUtilCancelInstall"};
   memset(body,0,sizeof body);uint32_t pid=getpid();memcpy(body,&pid,4);
   for(int i=0;i<4;i++){void *fn=dlsym(RTLD_DEFAULT,symbols[i]);memcpy(body+8+i*8,&fn,8);}
   uint64_t auth=kernel_get_ucred_authid(pid);memcpy(body+40,&auth,8);
   kernel_get_ucred_caps(pid,body+48);kernel_get_ucred_attrs(pid,body+64);
   uint32_t ids[]={kernel_get_ucred_uid(pid),kernel_get_ucred_ruid(pid),kernel_get_ucred_svuid(pid),kernel_get_ucred_rgid(pid),kernel_get_ucred_svgid(pid)};
   memcpy(body+96,ids,sizeof ids);size=116;
  }
#endif
  else r=-1013;
  alarm(0);
  if(response(fd,h.id,r,body,size))break;
 }
 alarm(12);save_cleanup();close(fd);return 0;
}

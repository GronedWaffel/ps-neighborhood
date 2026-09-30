// SPDX-License-Identifier: GPL-3.0-or-later
// PFS API/ABI reference: n0llptr/Playstation-5-Save-Mounter (GPL-3.0).
// Only mounts disposable staged copies; confirmed restore replaces one container.
#include <fcntl.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <signal.h>

struct psn_save_mount_opt { uint8_t reserved; char *budget; };
_Static_assert(sizeof(struct psn_save_mount_opt)==16,"Save mount options ABI");
static char save_session[37],save_mount_path[128];
static int save_mounted;
static void (*save_init_mount)(struct psn_save_mount_opt*);
static int (*save_mount_fn)(struct psn_save_mount_opt*,const char*,const char*,uint8_t*);
static void (*save_init_unmount)(uint8_t*);
static int (*save_unmount_fn)(uint8_t*,const char*,int,int);

static int save_available(void){
 uint32_t firmware=0;size_t n=4;
 if(sysctlbyname("kern.sdk_version",&firmware,&n,0,0)||(firmware>>16)!=0x1360)return 0;
 save_init_mount=dlsym(RTLD_DEFAULT,"sceFsInitMountSaveDataOpt");
 save_mount_fn=dlsym(RTLD_DEFAULT,"sceFsMountSaveData");
 save_init_unmount=dlsym(RTLD_DEFAULT,"sceFsInitUmountSaveDataOpt");
 save_unmount_fn=dlsym(RTLD_DEFAULT,"sceFsUmountSaveData");
 return save_init_mount&&save_mount_fn&&save_init_unmount&&save_unmount_fn;
}
static int save_uuid(const uint8_t *data,uint32_t length,char out[37]){
 if(length!=36)return -1040;
 for(int i=0;i<36;i++){
  if(i==8||i==13||i==18||i==23){if(data[i]!='-')return -1040;}
  else if(!((data[i]>='0'&&data[i]<='9')||(data[i]>='a'&&data[i]<='f')))return -1040;
 }memcpy(out,data,36);out[36]=0;return 0;
}
static void save_wipe(void *p,size_t n){volatile uint8_t *b=p;while(n--)*b++=0;}
static int save_creds_begin(uint64_t *auth,uint8_t caps[16]){
 if(kernel_get_ucred_uid(getpid())!=0||kernel_get_ucred_caps(getpid(),caps))return -1041;
 int r=auth_begin(0x4800000000000010ULL,auth);if(r)return r;
 uint8_t changed[16];memcpy(changed,caps,16);changed[7]|=0x40;
 if(kernel_set_ucred_caps(getpid(),changed)){kernel_set_ucred_caps(getpid(),caps);return auth_end(*auth,-1041);}return 0;
}
static int save_creds_end(uint64_t auth,const uint8_t caps[16],int result){
 uint8_t verify[16];
 if(kernel_set_ucred_caps(getpid(),caps)||kernel_get_ucred_caps(getpid(),verify)||memcmp(caps,verify,16)){auth_broken=1;result=-1041;}
 return auth_end(auth,result);
}
static int save_unmount_session(const uint8_t *data,uint32_t length){
 char id[37];int r=save_uuid(data,length,id);if(r)return r;
 if(!save_mounted||strcmp(id,save_session))return -1042;
 uint64_t auth;uint8_t caps[16];r=save_creds_begin(&auth,caps);if(r)return r;
 uint8_t opt[16]={0};save_init_unmount(opt);r=save_unmount_fn(opt,save_mount_path,0,0);
 if(r>=0){save_mounted=0;save_session[0]=0;save_mount_path[0]=0;r=0;}
 return save_creds_end(auth,caps,r);
}
static int save_mount_session(const uint8_t *data,uint32_t length){
 char id[37],image[128],mount[128];int r=save_uuid(data,length,id);if(r)return r;
 if(save_mounted)return -1043;if(!save_available())return -1044;
 snprintf(image,sizeof image,"/data/psn-saves/%s/image",id);
 snprintf(mount,sizeof mount,"/data/psn-saves/%s/mount",id);
 struct stat st;if(lstat(image,&st)||!S_ISREG(st.st_mode)||st.st_size<0x860)return -1045;
 int fd=open(image,O_RDONLY|O_NOFOLLOW);if(fd<0)return -1045;
 uint8_t header;uint8_t *key=calloc(1,0x100);if(!key){close(fd);return -1045;}
 if(pread(fd,&header,1,0)!=1||header!=2||pread(fd,key,0x60,0x800)!=0x60){close(fd);free(key);return -1046;}close(fd);
 if(mkdir(mount,0700)&&errno!=EEXIST){save_wipe(key,0x100);free(key);return -1045;}
 if(lstat(mount,&st)||!S_ISDIR(st.st_mode)){save_wipe(key,0x100);free(key);return -1045;}
 uint64_t auth;uint8_t caps[16];r=save_creds_begin(&auth,caps);
 if(!r){
  fd=open("/dev/pfsmgr",O_RDWR);
  if(fd<0)r=-1047;
  else{r=ioctl(fd,0xc0845302,key);close(fd);if(r<0)r=-1047;}
  if(r>=0){struct psn_save_mount_opt opt={0};save_init_mount(&opt);opt.budget="system";
   r=save_mount_fn(&opt,image,mount,key+0x60);
   if(r>=0){strcpy(save_session,id);strcpy(save_mount_path,mount);save_mounted=1;r=0;}
  }
  r=save_creds_end(auth,caps,r);
 }
 save_wipe(key,0x100);free(key);return r;
}
static void save_cleanup(void){if(save_mounted)save_unmount_session((const uint8_t*)save_session,36);}

// Restore commit atomically renames a fully uploaded sibling file. Slow transfer
// and hashing happen on the PC first, including a separate recovery copy. That
// copy remains until the PC verifies the installed image and removes it.
struct __attribute__((packed)) save_stamp {uint64_t size,inode;int64_t sec,nsec;uint32_t mode,uid,gid;};
static void save_stamp_stat(struct save_stamp *out,const struct stat *st){
 memset(out,0,sizeof *out);out->size=st->st_size;out->inode=st->st_ino;
 out->sec=st->st_mtim.tv_sec;out->nsec=st->st_mtim.tv_nsec;out->mode=st->st_mode;out->uid=st->st_uid;out->gid=st->st_gid;
}
static int save_target(const uint8_t *data,uint32_t length,char target[512],char title[10],char id[37]){
 // uuid(36), user-id(8 lowercase hex), title(9), slot(up to 127 ASCII bytes)
 if(length<60||length>180)return -1040;
 int r=save_uuid(data,36,id);if(r)return r;
 char user[9];for(int i=0;i<8;i++)if(!((data[36+i]>='0'&&data[36+i]<='9')||(data[36+i]>='a'&&data[36+i]<='f')))return -1040;
 memcpy(user,data+36,8);user[8]=0;
 if(valid_title(data+44,9,title)||(!memcmp(title,"CUSA",4)))return -1040;
 size_t n=length-53;if(n<7||n>127||memcmp(data+53,"sdimg_",6))return -1040;
 for(size_t i=53;i<length;i++){uint8_t c=data[i];if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'||c=='-'||c=='.'))return -1040;}
 char slot[128];memcpy(slot,data+53,n);slot[n]=0;
 unsigned uid=(unsigned)strtoul(user,0,16);
 snprintf(target,512,"/user/home/%x/savedata_prospero/%s/%s",uid,title,slot);return 0;
}
static int save_target_closed(const char *title){service_resolve();int info[3];int r=app_query(title,info);return r?r:info[2]?-1048:0;}
static int save_target_info(const uint8_t *data,uint32_t length,uint8_t *reply){
 char target[512],title[10],id[37];int r=save_target(data,length,target,title,id);if(r)return r;
 if((r=save_target_closed(title)))return r;
 struct stat st;if(lstat(target,&st)||!S_ISREG(st.st_mode))return -1045;
 struct save_stamp out;save_stamp_stat(&out,&st);memcpy(reply,&out,sizeof out);return 0;
}
static int save_commit(const uint8_t *data,uint32_t length){
 if(length<=sizeof(struct save_stamp)||save_mounted||!save_available())return -1043;
 char target[512],title[10],id[37],incoming[560],backup[560];
 uint32_t target_length=length-sizeof(struct save_stamp);
 int r=save_target(data,target_length,target,title,id);if(r)return r;
 struct save_stamp expected;memcpy(&expected,data+target_length,sizeof expected);
 const char *slot=strrchr(target,'/')+1;int prefix=(int)(slot-target);
 snprintf(incoming,sizeof incoming,"%.*s.psn-new-%s-%s",prefix,target,id,slot);
 snprintf(backup,sizeof backup,"%.*s.psn-old-%s-%s",prefix,target,id,slot);
 if((r=save_target_closed(title)))return r;
 uint64_t auth;uint8_t caps[16];r=save_creds_begin(&auth,caps);if(r)return r;
 int original=-1,staged=-1,recovery=-1;struct stat old,st;struct save_stamp observed;
 original=open(target,O_RDONLY|O_NOFOLLOW);staged=open(incoming,O_RDWR|O_NOFOLLOW);
 if(original<0||staged<0||fstat(original,&old)||fstat(staged,&st)||!S_ISREG(old.st_mode)||!S_ISREG(st.st_mode)||old.st_size!=st.st_size){r=-1045;goto done;}
 save_stamp_stat(&observed,&old);if(memcmp(&expected,&observed,sizeof expected)){r=-1049;goto done;}
 // The edited container must retain this exact save's sealed key.
 uint8_t oldkey[0x60],newkey[0x60],hdr;
 if(pread(staged,&hdr,1,0)!=1||hdr!=2||pread(original,oldkey,sizeof oldkey,0x800)!=sizeof oldkey||pread(staged,newkey,sizeof newkey,0x800)!=sizeof newkey||memcmp(oldkey,newkey,sizeof oldkey)){r=-1050;goto done;}
 if(fchmod(staged,old.st_mode&07777)||fchown(staged,old.st_uid,old.st_gid)||fsync(staged)){r=-1051;goto done;}
 recovery=open(backup,O_RDWR|O_NOFOLLOW);
 if(recovery<0||fstat(recovery,&st)||!S_ISREG(st.st_mode)||st.st_size!=old.st_size||pread(recovery,newkey,sizeof newkey,0x800)!=sizeof newkey||memcmp(oldkey,newkey,sizeof oldkey)){r=-1051;goto done;}
 if(fchmod(recovery,old.st_mode&07777)||fchown(recovery,old.st_uid,old.st_gid)||fsync(recovery)){r=-1051;goto done;}
 if((r=save_target_closed(title)))goto done;
 if(lstat(target,&st)){r=-1049;goto done;}save_stamp_stat(&observed,&st);
 if(memcmp(&expected,&observed,sizeof expected)){r=-1049;goto done;}
 // The target pathname is replaced in one rename; the verified recovery copy
 // is already persisted. Directory fsync is not supported on every console FS.
 if(rename(incoming,target)){r=-1051;goto done;}
 char parent[512];strcpy(parent,target);*strrchr(parent,'/')=0;
 int directory=open(parent,O_RDONLY|O_DIRECTORY);if(directory>=0){fsync(directory);close(directory);}
 r=0;
done:
 if(original>=0)close(original);if(staged>=0)close(staged);if(recovery>=0)close(recovery);
 return save_creds_end(auth,caps,r);
}

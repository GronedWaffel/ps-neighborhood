// https://gist.github.com/flatz/1055a8d7819c8478db1b464842582c9c
#include <sys/types.h>
#include <stddef.h>
#include "ps4-libjbc/kernelrw.h"
#include "dynlib-layout.h"

struct module_segment
{
    uint64_t addr;
    uint32_t size;
    uint32_t flags;
};

struct module_info_ex
{
    size_t st_size;
    char name[256];
    int id;
    uint32_t tls_index;
    uint64_t tls_init_addr;
    uint32_t tls_init_size;
    uint32_t tls_size;
    uint32_t tls_offset;
    uint32_t tls_align;
    uint64_t init_proc_addr;
    uint64_t fini_proc_addr;
    uint64_t reserved1;
    uint64_t reserved2;
    uint64_t eh_frame_hdr_addr;
    uint64_t eh_frame_addr;
    uint32_t eh_frame_hdr_size;
    uint32_t eh_frame_size;
    struct module_segment segments[4];
    uint32_t segment_count;
    uint32_t ref_count;
};

long long dynlib_load_prx(const char*, int, int*, int);
int dynlib_get_info_ex(int, int, struct module_info_ex*);
long long dynlib_dlsym(int, const char*, void**);
int dynlib_get_list(int*,size_t,size_t*);

void *existing_symbol(const char *name) {
    int handles[256];size_t count=0;
    if(dynlib_get_list(handles,256,&count))return 0;
    for(size_t i=0;i<count && i<256;i++) {
        void *p=0;dynlib_dlsym(handles[i],name,&p);if(p)return p;
    }
    return 0;
}

int existing_user(int *user) {
    int handles[256];size_t count=0;
    if(dynlib_get_list(handles,256,&count))return -1;
    for(size_t i=0;i<count && i<256;i++) {
        int (*getuser)(int*)=0;
        dynlib_dlsym(handles[i],"sceUserServiceGetForegroundUser",(void**)&getuser);
        if(!getuser)continue;
        int candidate=-1;
        if(getuser(&candidate)==0 && candidate>=0){*user=candidate;return 0;}
    }
    return -1;
}

void* dlopen_ex(const char* path, int mode /*ignored*/, void* data, size_t data_len)
{
    int (*load_start)(const char*,size_t,const void*,unsigned,void*,int*) = 0;
    dynlib_dlsym(0x2001, "sceKernelLoadStartModule", (void**)&load_start);
    if(!load_start) dynlib_dlsym(1, "sceKernelLoadStartModule", (void**)&load_start);
    if(load_start) {
        int result=0;
        int handle=load_start(path,data_len,data,0,0,&result);
        return handle > 0 && result >= 0 ? (void*)(long long)handle : 0;
    }
    // Never call a loaded module's constructor manually: it may be shared by
    // the payload host, and its service objects may already be initialized.
    return 0;
}

void* dlopen(const char* path, int mode)
{
    return dlopen_ex(path, mode, NULL, 0);
}

void* dlsym(void* handle, const char* name)
{
    void* addr = 0;
    dynlib_dlsym((int)(long long)handle, name, &addr);
    return addr;
}

// Packed libraries are not exposed by syscall dlsym. Read only this process's
// loader metadata, following ps4-payload-dev/sdk (John Törnblom, GPL-3.0+).
// Validate a public symbol against dlsym before accepting any private address.
void *packed_symbol(void *handle,const char *nid,const char *anchor_nid,void *anchor) {
    if(!handle || !anchor)return 0;
    uintptr_t proc=jbc_krw_read64(jbc_krw_get_td()+8,KERNEL_HEAP);
    uintptr_t at=jbc_krw_read64(proc+0x340,KERNEL_HEAP);
    dynlib_obj_t obj;int found=0;
    for(int n=0;n<512;n++) {
        at=jbc_krw_read64(at,KERNEL_HEAP);if(!at || at==(uintptr_t)-1)return 0;
        if(jbc_krw_memcpy((uintptr_t)&obj,at,sizeof(obj),KERNEL_HEAP))return 0;
        if(obj.handle==(uintptr_t)handle){found=1;break;}
    }
    if(!found || !obj.mapbase || obj.mapbase>=0x800000000000ULL || !obj.textsize || obj.textsize>0x1000000)return 0;
    dynlib_dynsec_t sec;
    if(jbc_krw_memcpy((uintptr_t)&sec,obj.dynsec,sizeof(sec),KERNEL_HEAP))return 0;
    if(!sec.symtabsize || sec.symtabsize%24 || sec.symtabsize>0x100000 || sec.strtabsize<12 || sec.strtabsize>0x100000)return 0;
    extern void *mmap(void*,size_t,int,int,int,long);extern int munmap(void*,size_t);
    size_t size=sec.symtabsize+sec.strtabsize;uint8_t *buf=mmap(0,size,3,0x1002,-1,0);if(buf==(void*)-1)return 0;
    void *result=0,*check=0;
    if(!jbc_krw_memcpy((uintptr_t)buf,sec.symtab,sec.symtabsize,KERNEL_HEAP) && !jbc_krw_memcpy((uintptr_t)(buf+sec.symtabsize),sec.strtab,sec.strtabsize,KERNEL_HEAP)) {
        struct sym { uint32_t name;uint8_t info,other;uint16_t section;uint64_t value,size; };
        for(size_t i=0;i<sec.symtabsize;i+=24) {
            struct sym *s=(struct sym*)(buf+i);
            if(!s->section || (s->info&15)!=2 || !s->value || s->value>=obj.textsize || s->name>sec.strtabsize-12)continue;
            const char *text=(char*)(buf+sec.symtabsize+s->name);int match=1,anchor_match=1;
            for(int j=0;j<11;j++){if(text[j]!=nid[j])match=0;if(text[j]!=anchor_nid[j])anchor_match=0;}
            if(match && text[11]=='#')result=(void*)(obj.mapbase+s->value);
            if(anchor_match && text[11]=='#')check=(void*)(obj.mapbase+s->value);
        }
    }
    munmap(buf,size);return check==anchor?result:0;
}

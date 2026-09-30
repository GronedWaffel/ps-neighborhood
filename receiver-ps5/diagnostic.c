// SPDX-License-Identifier: GPL-3.0-or-later
// Opt-in hardware test: scratch memory belongs solely to this short-lived payload.
#include <sys/socket.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
struct __attribute__((packed)) configuration {char magic[16];uint32_t addr;uint16_t port,reserved;uint8_t token[32];};
volatile struct configuration config={.magic="PSNRECEIVERCFG01",.addr=0xb4b4b4b4,.port=0xb4b4};
struct values {uint32_t value,second;float floating;uint32_t pad;double precise;uint64_t pointer;char text[32];};
volatile struct values scratch={.value=100,.second=200,.floating=1.5f,.precise=2.25,.text="PS Neighborhood diagnostic"};
int main(void){
 int fd=socket(AF_INET,SOCK_STREAM,0);if(fd<0)return 1;
 struct sockaddr_in dest;memset(&dest,0,sizeof dest);dest.sin_len=sizeof dest;dest.sin_family=AF_INET;dest.sin_addr.s_addr=config.addr;dest.sin_port=config.port;
 struct timeval timeout={90,0};setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof timeout);setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof timeout);
 if(connect(fd,(struct sockaddr*)&dest,sizeof dest)){close(fd);return 2;}
 scratch.pointer=(uint64_t)&scratch.second;
 struct __attribute__((packed)) {uint32_t magic,pid;uint64_t address;uint32_t size;uint8_t token[32];} info={.magic=0x544e5350,.pid=getpid(),.address=(uint64_t)&scratch,.size=sizeof scratch};memcpy(info.token,(const void*)config.token,32);
 size_t left=sizeof info;uint8_t *p=(uint8_t*)&info;while(left){ssize_t n=write(fd,p,left);if(n<=0){close(fd);return 3;}p+=n;left-=n;}
 char stop;read(fd,&stop,1);close(fd);return 0;
}

#include <assert.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
typedef intptr_t ssize_t;
struct timeval {long tv_sec,tv_usec;};
struct sockaddr {char bytes[32];};
struct sockaddr_in {uint8_t sin_len,sin_family;uint16_t sin_port;struct {uint32_t s_addr;} sin_addr;};
#define AF_INET 2
#define SOCK_STREAM 1
#define SOL_SOCKET 1
#define SO_RCVTIMEO 1
#define SO_SNDTIMEO 2
static uint16_t htons(uint16_t n){return (n>>8)|(n<<8);}
static uint32_t htonl(uint32_t n){return (n>>24)|((n>>8)&0xff00)|((n<<8)&0xff0000)|(n<<24);}
static int opened,closed,reads,fail_read,huge;
static char request[1024];static size_t used;
static int socket(int a,int b,int c){assert(a==AF_INET&&b==SOCK_STREAM);opened++;return 9;}
static int setsockopt(int a,int b,int c,const void*d,size_t e){return 0;}
static int connect(int fd,const struct sockaddr *s,size_t n){const struct sockaddr_in *a=(const void*)s;assert(fd==9&&a->sin_addr.s_addr==htonl(0x7f000001)&&a->sin_port==htons(10101));return 0;}
static int exact(int fd,void *p,size_t n,int sending){assert(sending&&used+n<sizeof request);memcpy(request+used,p,n);used+=n;request[used]=0;return 0;}
static ssize_t read(int fd,void*p,size_t n){if(fail_read){errno=EIO;return -1;}if(huge){memset(p,'x',n);return n;}if(reads++)return 0;const char *v="HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\n{\"status\":0}";memcpy(p,v,strlen(v));return strlen(v);}
static int close(int fd){closed++;return 0;}
#include "../receiver-ps5/shadowmount.h"
int main(void){uint8_t in[6]={0x75,0x27,3,0,'{','}'},*out;uint32_t size;
 assert(shadow_request(in,6,&out,&size)==0);assert(out&&size>12);free(out);assert(opened==closed);assert(strstr(request,"POST /api/v1/games HTTP/1.1"));assert(strstr(request,"Connection: close"));
 in[2]=250;assert(shadow_request(in,6,&out,&size)==-1060);assert(opened==1);in[2]=3;in[4]='\n';assert(shadow_request(in,6,&out,&size)==-1060);in[4]='{';
 fail_read=1;used=0;assert(shadow_request(in,6,&out,&size)==-1062);assert(out==NULL&&size==0&&opened==closed);
 fail_read=0;huge=1;used=0;assert(shadow_request(in,6,&out,&size)==-1064);assert(out==NULL&&size==0&&opened==closed);
 puts("ShadowMount native bridge bounds and loopback routing passed");return 0;}

// SPDX-License-Identifier: GPL-3.0-or-later
// Bounded HTTP bridge over the companion's authenticated reverse connection.
// Only these ShadowMount routes on console loopback can be reached.
#include <stdlib.h>
#include <stdio.h>
#define PSN_SHADOW_LIMIT (1024u*1024u)
static const char *shadow_routes[]={"version","storage","settings","games","images","scan","manual/add","games/mount","games/unmount","games/info"};
static int shadow_request(const uint8_t *input,uint32_t length,uint8_t **output,uint32_t *size){
 *output=NULL;*size=0;
 if(length<6||length>2048)return -1060;
 uint16_t port,op;memcpy(&port,input,2);memcpy(&op,input+2,2);
 if(!port||op>=sizeof shadow_routes/sizeof shadow_routes[0]||input[4]!='{'||input[length-1]!='}')return -1060;
 for(uint32_t i=4;i<length;i++)if(input[i]==0||input[i]=='\r'||input[i]=='\n')return -1060;
 int fd=socket(AF_INET,SOCK_STREAM,0);if(fd<0)return -1061;
 struct timeval timeout={4,0};setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof timeout);setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof timeout);
 struct sockaddr_in addr;memset(&addr,0,sizeof addr);addr.sin_len=sizeof addr;addr.sin_family=AF_INET;addr.sin_port=htons(port);addr.sin_addr.s_addr=htonl(0x7f000001);
 int rc=-1062;uint8_t *data=NULL;
 if(connect(fd,(struct sockaddr*)&addr,sizeof addr))goto done;
 char header[320];int n=snprintf(header,sizeof header,"POST /api/v1/%s HTTP/1.1\r\nHost: 127.0.0.1:%u\r\nContent-Type: application/json\r\nContent-Length: %u\r\nConnection: close\r\n\r\n",shadow_routes[op],port,length-4);
 if(n<=0||(size_t)n>=sizeof header||exact(fd,header,(size_t)n,1)||exact(fd,(void*)(input+4),length-4,1))goto done;
 data=malloc(PSN_SHADOW_LIMIT);if(!data){rc=-1063;goto done;}
 uint32_t used=0;
 while(used<PSN_SHADOW_LIMIT){ssize_t got=read(fd,data+used,PSN_SHADOW_LIMIT-used);if(got<0&&errno==EINTR)continue;if(got<0)goto done;if(got==0){*output=data;*size=used;data=NULL;rc=0;goto done;}used+=(uint32_t)got;}
 rc=-1064;
done:
 free(data);close(fd);return rc;
}

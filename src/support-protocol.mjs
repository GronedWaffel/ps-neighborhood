export const SUPPORT_RELAY='https://sniperscheats.lol/support/api';
export const SUPPORT_READ_METHODS=new Set(['status','probe','connect','processes','process_info','maps','memory_read','memory_readv','memory_inspect','memory_strings','pointer_resolve','ftp_list','ftp_read']);
export const SUPPORT_ACTION_METHODS=new Set(['payload_send','memory_write']);
export function relayUrl(value=SUPPORT_RELAY,{allowLocal=false}={}){
  const u=new URL(value);
  if(u.username||u.password||u.search||u.hash||!(u.protocol==='https:'||(allowLocal&&u.protocol==='http:'&&u.hostname==='127.0.0.1')))throw Error('Support relay must use HTTPS');
  return u.href.replace(/\/$/,'');
}
export async function supportRequest(base,route,token,body={},signal){
  const response=await fetch(base+route,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(540000)]):AbortSignal.timeout(540000)});
  // The endpoint is fixed by the session, but still bound the response allocation.
  let length=0;const chunks=[];for await(const chunk of response.body){length+=chunk.length;if(length>48*1048576)throw Error('Support response too large');chunks.push(chunk);}
  const result=JSON.parse(Buffer.concat(chunks).toString());if(!response.ok||result.error)throw Error(result.error||'Support request failed');return result;
}

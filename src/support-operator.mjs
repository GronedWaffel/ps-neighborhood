import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {McpServer} from '@modelcontextprotocol/server';
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';
import {supportTools} from './support-tools.mjs';
import {SUPPORT_ACTION_METHODS,relayUrl,supportRequest} from './support-protocol.mjs';
import {validatePS5Elf} from './platform.mjs';

export async function operatorCall(connection,method,args){
  if(method==='payload_send'&&typeof args.local==='string'){
    const data=await readFile(args.local);if(data.length>32*1048576)throw Error('ELF exceeds 32 MiB');validatePS5Elf(data);
    args={name:path.basename(args.local),sha256:createHash('sha256').update(data).digest('hex'),base64:data.toString('base64')};
  }
  const r=await supportRequest(relayUrl(connection.relay,{allowLocal:connection.testOnly===true}),`/sessions/${connection.id}/call`,connection.controller,{method,args});return r.result;
}
export function createSupportMcp(call){
  const mcp=new McpServer({name:'ps-neighborhood-remote-support',version:'0.12.2-support.1'});
  for(const [name,description,shape] of supportTools){
    const input=name==='payload_send'?{local:z.string().min(1)}:shape;
    mcp.registerTool('psn_support_'+name,{description,inputSchema:z.object(input).strict(),annotations:{readOnlyHint:!SUPPORT_ACTION_METHODS.has(name)&&name!=='connect',destructiveHint:SUPPORT_ACTION_METHODS.has(name),openWorldHint:true}},async args=>{
      try{const result=await call(name,args);return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:{result}};}
      catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}
    });
  }
  return mcp;
}
async function main(){
  const file=process.env.PSN_SUPPORT_CONNECTION;if(!file)throw Error('Set PSN_SUPPORT_CONNECTION to a private session JSON file');
  const [command,argument,argsFile]=process.argv.slice(2);
  if(command==='pair'){
    const relay=relayUrl(process.env.PSN_SUPPORT_RELAY);const operatorKey=process.env.PSN_SUPPORT_OPERATOR_KEY||(process.env.PSN_SUPPORT_KEY_FILE?(await readFile(process.env.PSN_SUPPORT_KEY_FILE,'utf8')).trim():null);
    if(!operatorKey)throw Error('Set PSN_SUPPORT_KEY_FILE to your private operator key file');
    if(!/^[A-Fa-f0-9]{16}$/.test(argument||''))throw Error('Supply the 16-character code displayed by the owner');
    const result=await supportRequest(relay,'/claim',operatorKey,{code:argument.toUpperCase()});await mkdir(path.dirname(path.resolve(file)),{recursive:true});
    await writeFile(file,JSON.stringify({...result,relay},null,2),{mode:0o600});console.log('Paired. Private session credentials saved; expires '+new Date(result.expires).toISOString());return;
  }
  const connection=JSON.parse(await readFile(file,'utf8'));
  if(command==='call'){const args=argsFile?JSON.parse(await readFile(argsFile,'utf8')):{};console.log(JSON.stringify(await operatorCall(connection,argument,args),null,2));return;}
  if(command==='disconnect'){await supportRequest(relayUrl(connection.relay),`/sessions/${connection.id}/revoke`,connection.controller,{});console.log('Support session ended');return;}
  if(command!=='mcp')throw Error('Use pair CODE, call METHOD [args.json], disconnect, or mcp');
  await createSupportMcp((method,args)=>operatorCall(connection,method,args)).connect(new StdioServerTransport());
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});

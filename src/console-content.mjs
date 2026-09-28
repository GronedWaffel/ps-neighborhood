import {DatabaseSync} from 'node:sqlite';
import {Writable} from 'node:stream';

export function readAddons(file){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Add-on catalog copy is inconsistent');
    const columns=new Set(db.prepare('PRAGMA table_info(addcont)').all().map(x=>x.name));
    if(!['title_id','dir_name','title'].every(x=>columns.has(x)))throw Error('Unrecognized add-on catalog schema');
    const result=new Map();
    for(const r of db.prepare('SELECT title_id,dir_name,title FROM addcont LIMIT 20000').all()){
      if(!/^CUSA\d{5}$/.test(r.title_id))continue;
      if(!result.has(r.title_id))result.set(r.title_id,[]);
      result.get(r.title_id).push({id:String(r.dir_name),name:String(r.title||r.dir_name)});
    }
    return result;
  }finally{db.close();}
}

export async function smallText(c,remote,limit=256*1024){
  const chunks=[];let size=0;
  await c.downloadTo(new Writable({write(chunk,encoding,done){size+=chunk.length;if(size>limit)return done(Error('Metadata exceeds size limit'));chunks.push(chunk);done();}}),remote);
  return Buffer.concat(chunks).toString('utf8');
}

export function changeVersions(xml){
  return [...new Set([...xml.matchAll(/<changes\s+[^>]*app_ver=["'](\d{1,3}\.\d{2})["']/g)].map(m=>m[1]))].sort((a,b)=>Number(a)-Number(b));
}

// Evidence is limited to recognizable files in a mounted game, not a claim
// that a whole DLC pack is licensed, complete, or independently uninstallable.
const bo2={zm_highrise:'Die Rise',zm_prison:'Mob of the Dead',zm_buried:'Buried',zm_tomb:'Origins',zm_nuked:'Nuketown Zombies'};
const bo1={zombie_cosmodrome:'Ascension',zombie_coast:'Call of the Dead',zombie_temple:'Shangri-La',zombie_moon:'Moon',zombie_cod5_prototype:'Nacht der Untoten',zombie_cod5_asylum:'Verrückt',zombie_cod5_sumpf:'Shi No Numa',zombie_cod5_factory:'Der Riese'};
export function recognizeContent(game,files){
  const labels=/black ops\s+(ii|2)\b/i.test(game.name)?bo2:/black ops\b/i.test(game.name)?bo1:{};
  const maps=[];const seen=new Set();const patchFiles=[];
  for(const file of files){
    if(!file.size)continue;
    const name=file.name.toLowerCase();
    if(/_patch\.ff$/.test(name))patchFiles.push(file);
    const key=name.replace(/\.ff$/,'');
    if(labels[key]&&name.endsWith('.ff')&&!seen.has(key)){seen.add(key);maps.push({...file,fileName:file.name,name:labels[key]});}
  }
  return {maps,patchFiles};
}

export async function mountedContent(c,list,game){
  const mounts=await list(c,'/mnt/sandbox/pfsmnt',true);
  // A union mount can exist even without a separate patch. Never use its name
  // as proof of an installed update or add its virtual bytes to disk totals.
  const roots=mounts.filter(x=>x.isDirectory&&[game.titleId+'-app0',game.titleId+'-patch0'].includes(x.name));
  if(!roots.length)return null;
  const files=[];
  for(const root of roots){
    const zone='/mnt/sandbox/pfsmnt/'+root.name+'/zone';
    const entries=await list(c,zone,true);
    const dirs=entries.filter(x=>x.isDirectory).sort((a,b)=>(a.name==='all'?-1:b.name==='all'?1:a.name.localeCompare(b.name))).slice(0,20);
    const groups=[[zone,entries]];
    for(const d of dirs)groups.push([zone+'/'+d.name,await list(c,zone+'/'+d.name,true)]);
    for(const [parent,items] of groups){
      for(const f of items)if(f.isFile&&f.name.endsWith('.ff'))files.push({name:f.name,size:f.size,path:parent+'/'+f.name,source:root.name.endsWith('-patch0')?'patch':'base'});
    }
  }
  return {...recognizeContent(game,files),checkedAt:new Date().toISOString(),mounted:true};
}
